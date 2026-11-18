import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type { EnvironmentBinding, MachineDisk } from "@catamorphic/sandbox";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { outOfDiskFor } from "../services/out-of-disk.js";
import { RunCoordinator } from "../services/run-coordinator.js";
import { EnvironmentCapacityError } from "../services/worker-capacity.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

/**
 * Disk is a resource Work manages on machines (ADR 0335): admission keeps
 * a machine's floor and reserves `storageMb`, an episode under the floor
 * is recorded once, and failures there name the disk.
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
  critical?: number;
  at?: Date;
}): MachineDisk => ({
  path: "/var/lib/docker",
  totalBytes: args.total ?? 100 * GIB,
  freeBytes: args.free,
  floorBytes: args.floor ?? 10 * GIB,
  criticalBytes: args.critical ?? 1 * GIB,
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
    // Free space is above the floor: the words name what the work reserves.
    await expect(fresh.admit(3 * 1024)).rejects.toThrow(
      /^This machine is short of disk for the 3\.2 GB this work reserves \(12\.9 GB free of 107 GB, where Work keeps 10\.7 GB free\), so it waits for room\./,
    );
    await expect(fresh.admit(1024)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("lists a machine's storage ceiling from its latest report, whichever filesystem is tightest now", async () => {
    const { nodes, lease, list } = await machine();
    await nodes.reportDisk({ lease, disk: report({ free: 50 * GIB }) });
    expect((await list())?.descriptor.resources.storageMb).toBe(90 * 1024);
    // Another of its filesystems is the tightest now (a smaller state
    // folder's): what may be reserved there is what the machine offers.
    await nodes.reportDisk({
      lease,
      disk: report({ free: 15 * GIB, total: 20 * GIB, floor: 2 * GIB }),
    });
    expect((await list())?.descriptor.resources).toMatchObject({
      cpuMillis: 8000,
      storageMb: 18 * 1024,
    });
  });

  it("holds a workflow run only to the critical floor, and every workload to the storage it reserves (ADR 0335)", async () => {
    if (!db) return;
    const { identity, projectId, nodes, lease, admit, allocations } =
      await machine();
    const binding = {
      id: lease.id,
      label: "Server",
      trust: "managed" as const,
      isolation: "process" as const,
      workloads: ["workflow" as const],
      agentTopologies: ["controller" as const],
      capabilities: ["disk"],
      resourceLimits: [],
      resources: {},
    };
    const workflow = (storageMb?: number) =>
      allocations.create({
        identity,
        projectId,
        environmentName: "automations",
        workloadKind: "workflow",
        rootWorkloadId: randomUUID(),
        workerNodeId: lease.id,
        policy: {
          binding,
          requirements: {
            workload: "workflow",
            ...(storageMb ? { resources: { storageMb } } : {}),
          },
        },
      });
    // Under the floor, above the critical floor: chats wait, and the
    // workflows that free or replace machines still run.
    await nodes.reportDisk({ lease, disk: report({ free: 3 * GIB }) });
    await expect(admit()).rejects.toBeInstanceOf(EnvironmentCapacityError);
    await expect(workflow()).resolves.toMatchObject({ status: "active" });
    // A cache fill reserves its size: it needs that room above the
    // critical floor, as a workflow's storage does.
    await expect(workflow(4 * 1024)).rejects.toBeInstanceOf(
      EnvironmentCapacityError,
    );
    await expect(workflow(1024)).resolves.toMatchObject({ status: "active" });
    // Under the critical floor nothing more starts.
    await nodes.reportDisk({ lease, disk: report({ free: 0.5 * GIB }) });
    await expect(workflow()).rejects.toBeInstanceOf(EnvironmentCapacityError);
  });

  it("judges a report's age by the database's clock, not this replica's (ADR 0335)", async () => {
    const { nodes, lease, admit } = await machine();
    await nodes.reportDisk({ lease, disk: report({ free: 1 * GIB }) });
    // This replica's clock runs ten minutes ahead of the database's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    try {
      await expect(admit()).rejects.toBeInstanceOf(EnvironmentCapacityError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dates a report by when the server heard it, not the machine's clock", async () => {
    if (!db) return;
    const { nodes, lease, admit } = await machine();
    // A machine whose clock is ten minutes behind still holds work back.
    await nodes.reportDisk({
      lease,
      disk: report({
        free: 1 * GIB,
        at: new Date(Date.now() - 10 * 60_000),
      }),
    });
    await expect(admit()).rejects.toBeInstanceOf(EnvironmentCapacityError);
    // One the server last heard ten minutes ago speaks for nothing now.
    await db
      .updateTable("worker_nodes")
      .set({
        disk: sql`jsonb_set(disk, '{measuredAt}', to_jsonb((now() - interval '10 minutes')::timestamptz))`,
      })
      .where("id", "=", lease.id)
      .execute();
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

  it("names the disk in a failure from the machine's report, and output only as a hint", async () => {
    if (!db) return;
    const { nodes, lease, admit } = await machine();
    await nodes.reportDisk({ lease, disk: report({ free: 40 * GIB }) });
    const allocation = await admit();
    expect(
      await outOfDiskFor({
        db,
        allocationId: allocation.id,
        texts: ["exit 1"],
      }),
    ).toBeUndefined();
    expect(
      await outOfDiskFor({
        db,
        allocationId: allocation.id,
        texts: ["npm ERR! code ENOSPC"],
      }),
    ).toMatch(
      /^The workspace ran out of disk space \(no space left on device\); the machine reports 42\.9 GB free/,
    );
    await nodes.reportDisk({ lease, disk: report({ free: 2 * GIB }) });
    expect(
      await outOfDiskFor({ db, allocationId: allocation.id, texts: [] }),
    ).toBe(
      "The machine ran out of disk: 2.1 GB free of 107 GB, where Work keeps 10.7 GB free.",
    );
    expect(await outOfDiskFor({ db, nodeId: lease.id, texts: [] })).toMatch(
      /^The machine ran out of disk/,
    );
  });

  it("names the disk in a failed run's error (ADR 0335)", async () => {
    if (!db) return;
    const { projectId, nodes, lease, admit } = await machine();
    const coordinator = new RunCoordinator(db, new ExecutionJobsService(db));
    const failed = async (error: string) => {
      const allocation = await admit();
      const runId = randomUUID();
      await db
        .insertInto("workflow_runs")
        .values({
          id: runId,
          project_id: projectId,
          workflow_name: "review",
          provenance: {},
          status: "running",
          allocation_id: allocation.id,
        })
        .execute();
      await coordinator.failRunTree({ runId, error });
      const run = await db
        .selectFrom("workflow_runs")
        .select(["status", "error"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe("failed");
      return run.error;
    };
    await nodes.reportDisk({ lease, disk: report({ free: 40 * GIB }) });
    expect(await failed("The step failed")).toBe("The step failed");
    expect(await failed("ENOSPC: no space left on device")).toMatch(
      /^The workspace ran out of disk space \(no space left on device\); the machine reports 42\.9 GB free.* ENOSPC: no space left on device$/,
    );
    // Admitted, then the machine filled up under the run.
    const allocation = await admit();
    await nodes.reportDisk({ lease, disk: report({ free: 2 * GIB }) });
    const runId = randomUUID();
    await db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "review",
        provenance: {},
        status: "running",
        allocation_id: allocation.id,
      })
      .execute();
    await coordinator.failRunTree({ runId, error: "exit 1" });
    const run = await db
      .selectFrom("workflow_runs")
      .select("error")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(run.error).toBe(
      "The machine ran out of disk: 2.1 GB free of 107 GB, where Work keeps 10.7 GB free. exit 1",
    );
  });
});
