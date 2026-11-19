import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { EnvironmentBinding, MachineDisk } from "@catamorphic/sandbox";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerWorkMachine } from "../cluster.js";
import type { ScheduledPlacement } from "./placement.js";

/**
 * A cache fill is placed with its size (ADR 0334, 0335): on a machine
 * whose free disk less the cache's size stays above its full floor, as
 * admission will then require, never on the first machine of its pool
 * whatever room it has.
 */
const schema = `fills_${randomUUID().replaceAll("-", "")}`;
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;
const db = pool ? createDatabase({ pool, schema }) : undefined;
const GIB = 1024 ** 3;
const tenantId = randomUUID();
const authorityId = "fill-placement";
let root = "";
let machine: Awaited<ReturnType<typeof registerWorkMachine>> | undefined;

const report = (free: number): MachineDisk => ({
  path: "/var/lib/docker",
  totalBytes: 100 * GIB,
  freeBytes: free,
  floorBytes: 10 * GIB,
  criticalBytes: GIB,
  measuredAt: new Date().toISOString(),
});

const worker = (name: string): EnvironmentBinding => ({
  id: `worker.${name}`,
  label: name,
  trust: "managed",
  isolation: "sandbox",
  workloads: ["agent"],
  agentTopologies: ["controller"],
  capabilities: ["network.egress", "disk"],
  resourceLimits: [],
  resources: { storageMb: 90 * 1024 },
  labels: { node: `worker.${name}`, plane: "worker" },
});

beforeAll(async () => {
  if (!db) return;
  await migrateToLatest({ db, schema });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-fill-placement-"));
  const policy: ScheduledPlacement = {
    labels: { pool: "review" },
    access: { everyone: true },
    trusted: true,
    released: false,
  };
  machine = await registerWorkMachine({
    db,
    tenantId,
    authorityId,
    nodeId: "control",
    disposable: true,
    label: "Server",
    sandboxProvider: new LocalProcessSandboxProvider({
      root: path.join(root, "control"),
    }),
    // Workflows only: the review pool's workers take the fill.
    workloads: ["workflow"],
    placement: {
      workers: async () =>
        new Map([
          ["worker.a", policy],
          ["worker.b", policy],
        ]),
      owner: async () => undefined,
    },
  });
  const nodes = new WorkerNodesService(db);
  for (const [name, free] of [
    ["a", 10.25 * GIB],
    ["b", 40 * GIB],
  ] as const) {
    const lease = await nodes.register({
      tenantId,
      authorityId,
      descriptor: worker(name),
    });
    await nodes.reportDisk({ lease, disk: report(free) });
  }
}, 60_000);

afterAll(async () => {
  await machine?.stop();
  await db?.schema.dropSchema(schema).cascade().execute();
  await db?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!db)("placing a cache fill (ADR 0335)", () => {
  it("places it where its size fits above the full floor, which the first machine lacks", async () => {
    const place = (fill?: { storageMb: number }) =>
      machine?.environmentProvider.get({
        tenantId,
        pool: { pool: "review" },
        requirements: { workload: "agent" },
        ...(fill ? { fill } : {}),
      });
    // A workspace that reserves nothing fits on either: the first.
    expect((await place())?.workerNodeId).toBe("worker.a");
    // A 512 MiB fill would take the first under its floor.
    expect((await place({ storageMb: 512 }))?.workerNodeId).toBe("worker.b");
  });
});
