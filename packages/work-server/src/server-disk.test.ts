import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvironmentCapacityError } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
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
          // No critical floor: workflow runs still start.
          WORK_DISK_CRITICAL_MB: "0",
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

  it("places workflow runs, never chats, while it is under its floor (ADR 0335)", async () => {
    const core = server.catamorphic.core;
    const builder = {
      tenantId: SERVER_TENANT_ID,
      externalUserId: "server-disk-test",
    };
    const project = await core.projects.create(builder, { name: "Disk" });
    await core.deployment.deploy(
      SERVER_TENANT_ID,
      project.id,
      builder.externalUserId,
      {
        message: "Environments",
        files: {
          ".work/project.json": JSON.stringify({
            environments: {
              automations: { workloads: ["workflow"] },
              chats: { workloads: ["agent"] },
            },
            defaultEnvironment: "chats",
          }),
        },
      },
    );
    const admit = (environment: string, workload: "agent" | "workflow") =>
      core.executionEnvironments.admit({
        identity: builder,
        projectId: project.id,
        owner: null,
        environment,
        requirements: { workload },
      });
    await expect(admit("automations", "workflow")).resolves.toMatchObject({
      environmentName: "automations",
    });
    await expect(admit("chats", "agent")).rejects.toBeInstanceOf(
      EnvironmentCapacityError,
    );
  });
});

/**
 * A single server running its work as local processes shares one disk
 * with its database and its people's files: by default it keeps only the
 * critical floor, so its chats are not held back to keep room nothing
 * else on that machine needs (ADR 0335).
 */
describe("a single server's own machine", () => {
  let root: string;
  let server: WorkServer;
  let operatorSecret: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-server-floor-"));
    const dataDir = path.join(root, "server");
    server = await createWorkServer(
      testServerOptions({
        dataDir,
        // The default, as a stock server boots.
        env: { WORK_DISK_FLOOR_MB: undefined, PATH: process.env.PATH },
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

  it("keeps only the critical floor unless the operator sets one", async () => {
    const response = await server.operatorApp.inject({
      method: "GET",
      url: "/_work/operator/machines",
      headers: { authorization: `Bearer ${operatorSecret}` },
    });
    const { machines } = response.json() as {
      machines: Array<{
        descriptor: { labels?: Record<string, string> };
        disk?: {
          totalBytes: number;
          floorBytes: number;
          criticalBytes: number;
        };
      }>;
    };
    const disk = machines.find(
      (machine) => machine.descriptor.labels?.plane === "control",
    )?.disk;
    if (!disk) throw new Error("The server's own machine reports no disk");
    expect(disk.floorBytes).toBe(disk.criticalBytes);
    expect(disk.floorBytes).toBe(
      Math.min(Math.floor(disk.totalBytes * 0.01), 1024 ** 3),
    );
  });
});
