import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "./server.js";
import { testServerOptions } from "./test-support.js";

/**
 * The server's own machine reports its disk like any machine (ADR 0335):
 * an operator sees it short of disk, chats wait, and workflow runs, which
 * hold no checkout, still run.
 */
describe("a server short of disk", () => {
  let root: string;
  let server: WorkServer;
  let operatorSecret: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-server-disk-"));
    const dataDir = path.join(root, "server");
    server = await createWorkServer(
      testServerOptions({
        dataDir,
        // A floor no disk has room above: this machine is short of disk.
        env: {
          WORK_DISK_FLOOR_MB: String(1024 * 1024 * 1024),
          PATH: process.env.PATH,
        },
      }),
    );
    operatorSecret = fs
      .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
      .trim();
  }, 120_000);

  afterAll(async () => {
    await server?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shows the operator its own machine's disk and since when it is short", async () => {
    const response = await server.operatorApp.inject({
      method: "GET",
      url: "/_work/operator/machines",
      headers: { authorization: `Bearer ${operatorSecret}` },
    });
    expect(response.statusCode).toBe(200);
    const { machines } = response.json() as {
      machines: Array<{
        descriptor: { labels?: Record<string, string> };
        acceptingWork: boolean;
        disk?: { freeBytes: number; floorBytes: number };
        diskLowSince?: string;
      }>;
    };
    const own = machines.find(
      (machine) => machine.descriptor.labels?.plane === "control",
    );
    expect(own?.disk?.floorBytes).toBe(1024 ** 5);
    expect(own?.diskLowSince).toEqual(expect.any(String));
    expect(own?.acceptingWork).toBe(false);
  });
});
