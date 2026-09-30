import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "./server.js";
import { testServerOptions } from "./test-support.js";

/**
 * A single PGlite server keeps its machine identity (ADR 0190): it restarts
 * into its own lease, and an operator can disable and enable it again
 * without it ever stopping.
 */

const OPERATOR_SECRET = "single-server-operator-secret-with-32-chars";

function options(dataDir: string) {
  return testServerOptions({
    dataDir,
    env: {
      WORK_OPERATOR_SECRET: OPERATOR_SECRET,
      WORK_FAKE_AGENT: "1",
      PATH: process.env.PATH,
    },
  });
}

async function machineId(server: WorkServer): Promise<string> {
  return (await server.app.inject({ method: "GET", url: "/healthz" })).json()
    .machine.id;
}

it("a server restarting into its own lapsed lease waits for it instead of failing to boot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-restart-"));
  const first = await createWorkServer(options(dir));
  let second: WorkServer | undefined;
  try {
    const node = await machineId(first);
    // The first process "dies": its lease is still live for two seconds
    // under a token its shutdown can no longer release.
    await first.catamorphic.core.db
      .updateTable("worker_nodes")
      .set({
        lease_token: randomUUID(),
        lease_expires_at: new Date(Date.now() + 2_000),
      })
      .where("id", "=", node)
      .execute();
    await first.shutdown();
    const started = Date.now();
    second = await createWorkServer(options(dir));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(await machineId(second)).toBe(node);
  } finally {
    await second?.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 30_000);

it("a disabled single server idles, restarts, and takes work again once enabled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-disabled-"));
  let server = await createWorkServer(options(dir));
  try {
    const node = await machineId(server);
    const setEnabled = (enabled: boolean) =>
      server.operatorApp.inject({
        method: "PATCH",
        url: `/_work/operator/machines/${node}`,
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ enabled }),
      });
    const probe = async (url: "/healthz" | "/readyz") =>
      (await server.app.inject({ method: "GET", url })).statusCode;
    let lost = false;
    void server.lost.then(() => {
      lost = true;
    });

    expect((await setEnabled(false)).statusCode).toBe(200);
    // It stops taking work, but stays alive: nothing would restart it into
    // a different state.
    await expect
      .poll(() => probe("/readyz"), { timeout: 25_000, interval: 500 })
      .toBe(503);
    expect(await probe("/healthz")).toBe(200);
    expect(lost).toBe(false);

    // A restart boots into the same, still disabled machine.
    await server.shutdown();
    server = await createWorkServer(options(dir));
    expect(await machineId(server)).toBe(node);
    expect(await probe("/readyz")).toBe(503);
    expect(await probe("/healthz")).toBe(200);

    // Its own operator API enables it again.
    expect((await setEnabled(true)).statusCode).toBe(200);
    await expect
      .poll(() => probe("/readyz"), { timeout: 25_000, interval: 500 })
      .toBe(200);
  } finally {
    await server.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 90_000);
