import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import { createWorkServer, type WorkServer } from "../server.js";
import { testServerOptions } from "../test-support.js";
import {
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_HEADER,
  workerProtocolRefusal,
} from "./worker-protocol.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * Workers state their protocol on every call (ADR 0198): a control plane
 * that cannot drive one answers 426 naming which side to update, and the
 * worker says so and waits instead of retrying every few seconds.
 */
describe("worker protocol versions", () => {
  let root: string;
  let server: WorkServer;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-protocol-"));
    server = await createWorkServer(
      testServerOptions({
        dataDir: path.join(root, "control-plane"),
        env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await server?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const enroll = (headers: Record<string, string | undefined>) =>
    server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      headers: { "content-type": "application/json", ...headers },
      payload: JSON.stringify({ code: "wke_not-a-real-code" }),
    });

  it("answers 426 to a worker it cannot drive, naming which side to update", async () => {
    for (const headers of [
      {},
      { [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.minimum - 1) },
      { [WORKER_PROTOCOL_HEADER]: "not-a-number" },
    ]) {
      const refused = await enroll(headers);
      expect(refused.statusCode).toBe(426);
      expect(refused.json()).toMatchObject({
        code: "upgrade_required",
        serverProtocol: WORKER_PROTOCOL.server,
        minimum: WORKER_PROTOCOL.minimum,
      });
      expect(refused.json().error).toContain("Update the worker");
    }
    const newer = await enroll({
      [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server + 1),
    });
    expect(newer.statusCode).toBe(426);
    expect(newer.json().error).toContain("Update the control plane");
    // Its own protocol reaches the route itself.
    const current = await enroll({
      [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server),
    });
    expect(current.statusCode).toBe(400);
    expect(current.json().error).toContain("invalid, used, or expired");
    // Authenticated calls are refused before the credential is read.
    const poll = await server.app.inject({
      method: "POST",
      url: "/api/workers/poll",
      headers: { authorization: "Worker worker.old:secret" },
      payload: { session: crypto.randomUUID() },
    });
    expect(poll.statusCode).toBe(426);
  });

  it("refuses only versions outside what it drives", () => {
    expect(workerProtocolRefusal(String(WORKER_PROTOCOL.server))).toBe(
      undefined,
    );
    expect(workerProtocolRefusal(undefined)?.code).toBe("upgrade_required");
  });

  it("an outdated worker says to update it and backs off", async () => {
    const enrollment = await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/workers",
      headers: {
        authorization: `Bearer ${fs
          .readFileSync(
            path.join(root, "control-plane", "operator-secret"),
            "utf8",
          )
          .trim()}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "old-box", trusted: true }),
    });
    expect(enrollment.statusCode).toBe(201);
    // Enrolled by its own release; this process speaks an older protocol.
    const enrolled = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      headers: {
        "content-type": "application/json",
        [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server),
      },
      payload: JSON.stringify({ code: enrollment.json().code }),
    });
    expect(enrolled.statusCode).toBe(200);
    const dataDir = path.join(root, "old-box");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "worker-credential"),
      `${enrolled.json().credential}\n`,
      { mode: 0o600 },
    );
    const calls: string[] = [];
    const log: string[] = [];
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir,
      execution: executionSettingsFromEnv({
        WORK_SANDBOX: "local-process",
        PATH: process.env.PATH,
      }),
      protocol: WORKER_PROTOCOL.minimum - 1,
      log: (line) => log.push(line),
      fetch: async (input, init) => {
        const url = new URL(input);
        calls.push(url.pathname);
        const headers = new Headers(init?.headers);
        const answer = await server.app.inject({
          method: "POST",
          url: url.pathname,
          headers: Object.fromEntries(headers.entries()),
          payload: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(answer.body, {
          status: answer.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      await expect
        .poll(() => log.some((line) => line.includes("update this worker")), {
          timeout: 10_000,
        })
        .toBe(true);
      // It waits minutes before asking again, not seconds.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(calls.filter((call) => call.endsWith("/connect"))).toHaveLength(1);
    } finally {
      const stoppedAt = Date.now();
      await worker.stop();
      expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    }
  }, 60_000);
});
