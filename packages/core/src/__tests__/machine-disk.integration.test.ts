import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type { EnvironmentBinding, MachineDisk } from "@catamorphic/sandbox";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { EnvironmentCapacityError } from "../services/worker-capacity.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

/**
 * Disk is a resource Work manages on machines (ADR 0335): admission keeps
 * a machine's floor and reserves `storageMb`, an episode under the floor
 * is recorded once.
 */
const schema = `disk_${randomUUID().replaceAll("-", "")}`;
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;
const db = pool ? createDatabase({ pool, schema }) : undefined;
beforeAll(async () => {
  if (db) await migrateToLatest({ db, schema });
});
afterAll(async () => {
  await db?.schema.dropSchema(schema).cascade().execute();
  await db?.destroy();
});

const GIB = 1024 ** 3;
const report = (args: {
  free: number;
  total?: number;
  floor?: number;
  at?: Date;
}): MachineDisk => ({
  path: "/var/lib/docker",
  totalBytes: args.total ?? 100 * GIB,
  freeBytes: args.free,
  floorBytes: args.floor ?? 10 * GIB,
  measuredAt: (args.at ?? new Date()).toISOString(),
});

async function machine() {
  if (!db) throw new Error("No database");
  const identity = { tenantId: randomUUID(), externalUserId: "member" };
  const projectId = randomUUID();
  const descriptor: EnvironmentBinding = {
    id: randomUUID(),
    label: "Review machine",
    trust: "managed",
    isolation: "sandbox",
    workloads: ["agent"],
    agentTopologies: ["controller"],
    capabilities: ["disk"],
    resourceLimits: ["cpuMillis", "memoryMb"],
    resources: { cpuMillis: 8000, memoryMb: 16384 },
  };
  const nodes = new WorkerNodesService(db);
  const lease = await nodes.register({
    tenantId: identity.tenantId,
    authorityId: "test",
    descriptor,
    capacity: { workspaces: 8, cpuMillis: 8000, memoryMb: 16384 },
    defaults: { cpuMillis: 1000, memoryMb: 1024 },
  });
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: identity.tenantId, name: "Reviews" })
    .execute();
  const allocations = new ExecutionAllocationsService(db);
  const admit = (storageMb?: number) =>
    allocations.create({
      identity,
      projectId,
      environmentName: "review",
      workloadKind: "agent",
      rootWorkloadId: randomUUID(),
      workerNodeId: lease.id,
      policy: {
        binding: descriptor,
        requirements: {
          workload: "agent",
          ...(storageMb ? { resources: { storageMb } } : {}),
        },
      },
    });
  const list = async () =>
    (await nodes.list({ tenantId: identity.tenantId, authorityId: "test" }))[0];
  return { identity, projectId, nodes, lease, allocations, admit, list };
}

describe.skipIf(!db)("machine disk (ADR 0335)", () => {
  it("admits nothing while free space is under the floor, so the work waits", async () => {
    const { nodes, lease, admit, list } = await machine();
    await nodes.reportDisk({ lease, disk: report({ free: 4 * GIB }) });
    const refused = await admit().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(EnvironmentCapacityError);
    expect(String(refused)).toMatch(
      /short of disk \(4\.3 GB free of 107 GB, where Work keeps 10\.7 GB free\)/,
    );
    expect(await list()).toMatchObject({
      acceptingWork: false,
      disk: { freeBytes: 4 * GIB },
    });
    // Room again: admitted.
    await nodes.reportDisk({ lease, disk: report({ free: 40 * GIB }) });
    await expect(admit()).resolves.toMatchObject({ status: "active" });
    expect(await list()).toMatchObject({ acceptingWork: true });
  });

  it("reserves storageMb like memory, within the disk less its floor and free space above it", async () => {
    const { nodes, lease, admit, list } = await machine();
    // 100 GiB with a 10 GiB floor: 90 GiB to reserve, 80 GiB free above it.
    await nodes.reportDisk({ lease, disk: report({ free: 90 * GIB }) });
    const first = await admit(40 * 1024);
    await admit(40 * 1024);
    expect((await list())?.usage.storageMb).toBe(80 * 1024);
    // Free space would still hold it, but the reservations would not.
    await expect(admit(20 * 1024)).rejects.toBeInstanceOf(
      EnvironmentCapacityError,
    );
    await expect(admit(10 * 1024)).resolves.toMatchObject({
      status: "active",
    });
    if (!db) return;
    const row = await db
      .selectFrom("execution_allocations")
      .select("reserved_storage_mb")
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(row.reserved_storage_mb).toBe(40 * 1024);
    // A workspace whose storage would take free space under the floor waits.
    await nodes.reportDisk({ lease, disk: report({ free: 12 * GIB }) });
    const fresh = await machine();
    await fresh.nodes.reportDisk({
      lease: fresh.lease,
      disk: report({ free: 12 * GIB }),
    });
    await expect(fresh.admit(3 * 1024)).rejects.toBeInstanceOf(
      EnvironmentCapacityError,
    );
    await expect(fresh.admit(1024)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("does not hold a machine to a report too old to speak for it", async () => {
    const { nodes, lease, admit } = await machine();
    await nodes.reportDisk({
      lease,
      disk: report({
        free: 1 * GIB,
        at: new Date(Date.now() - 10 * 60_000),
      }),
    });
    await expect(admit()).resolves.toMatchObject({ status: "active" });
  });

  it("starts an episode once, whichever replica hears it, and ends it well above the floor", async () => {
    const { nodes, lease, list } = await machine();
    const low = report({ free: 5 * GIB });
    const heard = await Promise.all(
      Array.from({ length: 6 }, () => nodes.reportDisk({ lease, disk: low })),
    );
    expect(heard.filter((episode) => episode.state === "started")).toHaveLength(
      1,
    );
    expect(heard.filter((episode) => episode.state === "ongoing")).toHaveLength(
      5,
    );
    const since = (await list())?.diskLowSince;
    expect(since).toBeDefined();
    // Just over the floor is the same episode; 1.1 times it ends it.
    expect(
      await nodes.reportDisk({ lease, disk: report({ free: 10.5 * GIB }) }),
    ).toMatchObject({ state: "ongoing" });
    expect(
      await nodes.reportDisk({ lease, disk: report({ free: 12 * GIB }) }),
    ).toEqual({ state: "ended" });
    expect((await list())?.diskLowSince).toBeUndefined();
    expect(await nodes.reportDisk({ lease, disk: low })).toMatchObject({
      state: "started",
    });
    // A lease another process took records nothing.
    expect(
      await nodes.reportDisk({
        lease: { id: lease.id, token: randomUUID() },
        disk: low,
      }),
    ).toEqual({ state: "none" });
  });
});
