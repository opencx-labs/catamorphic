import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import { startWorkWorker } from "./worker-runtime.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A control plane that answers each route from a script. */
function controlPlane(answer: (route: string, call: number) => Response) {
  const calls: Record<string, number> = {};
  const fetch: Fetch = async (input, init) => {
    const route = new URL(input).pathname.split("/").at(-1) ?? "";
    calls[route] = (calls[route] ?? 0) + 1;
    const response = answer(route, calls[route]);
    // An empty long poll waits, as the control plane's does.
    if (route === "poll" && response.status === 200)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    return response;
  };
  return { fetch, calls };
}

const dirs: string[] = [];
function workerDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-epoch-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "worker-credential"),
    "worker.epoch:secret\n",
    { mode: 0o600 },
  );
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const superseded = () =>
  json(409, {
    error: "A newer process of this worker connected; this one must stop",
    superseded: true,
  });

describe("a worker's epoch (ADR 0192)", () => {
  it("waits out a lease its earlier epoch still holds, as after a clock that went back", async () => {
    const plane = controlPlane((route, call) =>
      route === "connect" && call === 1
        ? superseded()
        : route === "connect"
          ? json(200, { session: "s", nodeId: "worker.epoch" })
          : route === "poll"
            ? json(200, { jobs: [] })
            : json(200, { ok: true }),
    );
    const log: string[] = [];
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir: workerDir(),
      execution: executionSettingsFromEnv({ PATH: process.env.PATH }),
      fetch: plane.fetch,
      log: (line) => log.push(line),
    });
    try {
      await expect
        .poll(() => log.some((line) => line.startsWith("Connected")), {
          timeout: 15_000,
        })
        .toBe(true);
      expect(plane.calls.connect).toBe(2);
      expect(log.some((line) => line.includes("once it lapses"))).toBe(true);
    } finally {
      await worker.stop();
    }
  }, 20_000);

  it("stops for good once a newer process of it took over", async () => {
    const plane = controlPlane((route) =>
      route === "connect"
        ? json(200, { session: "s", nodeId: "worker.epoch" })
        : route === "poll"
          ? superseded()
          : json(200, { ok: true }),
    );
    const log: string[] = [];
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir: workerDir(),
      execution: executionSettingsFromEnv({ PATH: process.env.PATH }),
      fetch: plane.fetch,
      log: (line) => log.push(line),
    });
    try {
      await expect
        .poll(() => log.some((line) => line.includes("newer process")), {
          timeout: 10_000,
        })
        .toBe(true);
      // Longer than its first reconnect backoff: it never connects again.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(plane.calls.connect).toBe(1);
    } finally {
      await worker.stop();
    }
  }, 20_000);
});
