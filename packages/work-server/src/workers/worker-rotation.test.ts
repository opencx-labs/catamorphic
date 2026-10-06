import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executorKey, nodeExecutor } from "@catamorphic/core";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "../server.js";
import { testServerOptions } from "../test-support.js";
import { WORKER_PROTOCOL, WORKER_PROTOCOL_HEADER } from "./worker-protocol.js";

/** What every worker call states (ADR 0198). */
const PROTOCOL = { [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server) };
const OFFER = {
  isolation: "process",
  workspaceRoot: "/workspace",
  capacity: { workspaces: 1 },
};

/** UUIDv7s for epochs and rotations, later ones sorting after earlier ones. */
let ids = 0;
function laterId(): string {
  ids += 1;
  return `01920000-0000-7000-8000-${String(ids).padStart(12, "0")}`;
}

/**
 * Rotations are ordered (ADR 0206): a rotate request that was delayed on
 * its way, arriving after a later one, never replaces the credential the
 * later one issued, which the worker may already hold.
 */
describe("worker credential rotations are ordered (ADR 0206)", () => {
  let root: string;
  let server: WorkServer;
  let operatorSecret: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-rotation-order-"));
    server = await createWorkServer(
      testServerOptions({
        dataDir: path.join(root, "control-plane"),
        env: {
          WORK_FAKE_AGENT: "1",
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          PATH: process.env.PATH,
        },
      }),
    );
    operatorSecret = fs
      .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
      .trim();
  }, 120_000);

  afterAll(async () => {
    await server?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A worker call made with `credential`. */
  function call(credential: string, route: string, body: unknown) {
    return server.app.inject({
      method: "POST",
      url: `/api/workers/${route}`,
      headers: {
        ...PROTOCOL,
        authorization: `Worker ${credential}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  }

  /** An enrolled, connected worker and its session. */
  async function connected(name: string) {
    const enrollment = await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/workers",
      headers: {
        authorization: `Bearer ${operatorSecret}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name, trusted: true }),
    });
    expect(enrollment.statusCode).toBe(201);
    const keys = generateExecutorKeyPair();
    const enrolled = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      headers: PROTOCOL,
      payload: { code: enrollment.json().code, publicKey: keys.publicKey },
    });
    const credential = String(enrolled.json().credential);
    const session = laterId();
    const connect = await call(credential, "connect", {
      session,
      offer: OFFER,
      publicKey: keys.publicKey,
    });
    expect(connect.statusCode).toBe(200);
    return { credential, session };
  }

  /** Ask for a rotation with `rotation`; the new key and the answer. */
  async function rotate(credential: string, rotation: string) {
    const keys = generateExecutorKeyPair();
    const answer = await call(credential, "rotate", {
      publicKey: keys.publicKey,
      rotation,
    });
    return {
      keys,
      status: answer.statusCode,
      credential:
        answer.statusCode === 200
          ? String(answer.json().credential)
          : undefined,
    };
  }

  const registeredKey = (name: string) =>
    executorKey({
      db: server.catamorphic.core.db,
      executor: nodeExecutor(`worker.${name}`),
    });

  it("never lets a request delayed on its way replace a later request's credential", async () => {
    const worker = await connected("delayed");
    // The first request stalls on a replica; the worker gives up on it and
    // asks again, later.
    const stalled = laterId();
    const later = await rotate(worker.credential, laterId());
    expect(later.status).toBe(200);
    // The stalled request finally runs: it issues nothing.
    const late = await rotate(worker.credential, stalled);
    expect(late.status).toBe(409);
    // The worker saved the later credential and calls with it: accepted,
    // and the operations are sealed to its key from now on.
    const renewed = await call(later.credential ?? "", "renew", {
      session: worker.session,
    });
    expect(renewed.statusCode).toBe(200);
    expect(await registeredKey("delayed")).toBe(later.keys.publicKey);
    expect(
      (await call(worker.credential, "renew", { session: worker.session }))
        .statusCode,
    ).toBe(401);
  });

  it("lets a later request replace a pending credential nobody used", async () => {
    const worker = await connected("retried");
    const first = await rotate(worker.credential, laterId());
    const second = await rotate(worker.credential, laterId());
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(
      (await call(first.credential ?? "", "renew", { session: worker.session }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await call(second.credential ?? "", "renew", {
          session: worker.session,
        })
      ).statusCode,
    ).toBe(200);
    expect(await registeredKey("retried")).toBe(second.keys.publicKey);
  });

  it("settles concurrent requests on the latest one", async () => {
    const worker = await connected("concurrent");
    const earlier = laterId();
    const latest = laterId();
    const [a, b] = await Promise.all([
      rotate(worker.credential, latest),
      rotate(worker.credential, earlier),
    ]);
    // Whichever ran first, the latest request's credential is the one the
    // control plane accepts; the earlier one issued nothing usable.
    expect(a.status).toBe(200);
    expect([200, 409]).toContain(b.status);
    if (b.credential)
      expect(
        (await call(b.credential, "renew", { session: worker.session }))
          .statusCode,
      ).toBe(401);
    expect(
      (await call(a.credential ?? "", "renew", { session: worker.session }))
        .statusCode,
    ).toBe(200);
    expect(await registeredKey("concurrent")).toBe(a.keys.publicKey);
  });

  it("refuses a rotation without an id", async () => {
    const worker = await connected("unnamed");
    const answer = await call(worker.credential, "rotate", {
      publicKey: generateExecutorKeyPair().publicKey,
    });
    expect(answer.statusCode).toBe(400);
  });
});
