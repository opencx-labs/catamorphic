import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type {
  EnvironmentBinding,
  EnvironmentProvider,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

/**
 * Losing a disposable machine (ADR 0190): its workflow runs move to a live
 * node with their jobs, its chats' workspaces are released for readmission,
 * and the node row goes once nothing active is left on it.
 */

const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;
const db = pool ? createDatabase({ pool, schema }) : undefined;
const authorityId = "recovery-test";
const identity: Identity = {
  tenantId: randomUUID(),
  externalUserId: "recovery-member",
};
const projectId = randomUUID();
const DEPARTED = "departed-member";
let root = "";
let core: CatamorphicCore | undefined;
let nodes: WorkerNodesService | undefined;

const descriptor = (id: string): EnvironmentBinding => ({
  id,
  label: id,
  trust: "managed",
  isolation: "process",
  workloads: ["agent", "workflow"],
  agentTopologies: ["controller"],
  capabilities: [],
  resources: {},
  labels: { node: id, plane: "control" },
});

/** Places work on the first live node, as a host's provider would. */
function nodeProvider(service: WorkerNodesService): EnvironmentProvider {
  return {
    get: async ({ tenantId, allocationBindingId, workerNodeId }) => {
      const live = (await service.list({ tenantId, authorityId })).filter(
        (node) =>
          node.available &&
          (!allocationBindingId || node.id === allocationBindingId) &&
          (!workerNodeId || node.id === workerNodeId),
      );
      const chosen = live[0];
      return chosen
        ? { descriptor: chosen.descriptor, workerNodeId: chosen.id }
        : undefined;
    },
  };
}

beforeAll(async () => {
  if (!db) return;
  await migrateToLatest({ db, schema });
  root = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-recovery-"));
  const projectManager = new ProjectManager(
    new FsBackend(path.join(root, "dev")),
    new FsRemoteBackend(path.join(root, "remote")),
  );
  await db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "Recovery" })
    .execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: identity.tenantId, name: "Recovery" })
    .execute();
  const repo = await projectManager.create(identity.tenantId, projectId, {
    name: "recovery",
    externalUserId: identity.externalUserId,
  });
  await repo.dispose();
  nodes = new WorkerNodesService(db);
  core = new CatamorphicCore({
    db,
    projectManager,
    environmentProvider: nodeProvider(nodes),
    // The host's member resolver: someone who left may run nothing.
    resolveMemberIdentity: async ({ tenantId, externalUserId }) =>
      externalUserId === DEPARTED ? null : { tenantId, externalUserId },
  });
});

afterAll(async () => {
  await db?.schema.dropSchema(schema).cascade().execute();
  await db?.destroy();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function register(
  authority = authorityId,
): Promise<{ id: string; token: string }> {
  if (!nodes) throw new Error("Database required");
  const id = `node.${randomUUID()}`;
  return nodes.register({
    tenantId: identity.tenantId,
    authorityId: authority,
    descriptor: descriptor(id),
    disposable: true,
  });
}

/** Earlier tests' nodes stop taking work (but are not lost yet). */
async function quietOthers(): Promise<void> {
  await db
    ?.updateTable("worker_nodes")
    .set({ lease_expires_at: sql<Date>`now() - interval '1 second'` })
    .where("authority_id", "=", authorityId)
    .where("lease_expires_at", ">", sql<Date>`now()`)
    .execute();
}

/** The node's process died this long ago: nothing renews its lease. */
async function lapse(nodeId: string, seconds: number): Promise<void> {
  await db
    ?.updateTable("worker_nodes")
    .set({
      lease_expires_at: sql<Date>`now() - make_interval(secs => ${seconds})`,
    })
    .where("id", "=", nodeId)
    .execute();
}

/** A waiting run (with a child sharing its Allocation) and a chat on a node. */
async function placeWork(args: {
  nodeId: string;
  environment?: string;
  status?: string;
  owner?: string;
}): Promise<{ runId: string; childId: string; allocationId: string }> {
  if (!core || !db) throw new Error("Database required");
  const runId = randomUUID();
  const childId = randomUUID();
  const allocation = await core.executionAllocations.create({
    identity,
    projectId,
    environmentName: args.environment ?? "default",
    workloadKind: "workflow",
    rootWorkloadId: runId,
    workerNodeId: args.nodeId,
    policy: {
      binding: descriptor(args.nodeId),
      requirements: { workload: "workflow" },
    },
  });
  const run = {
    project_id: projectId,
    workflow_name: "approve",
    provenance: {},
    status: "waiting",
    allocation_id: allocation.id,
    external_user_id: args.owner ?? identity.externalUserId,
  };
  await db
    .insertInto("workflow_runs")
    .values({ ...run, id: runId, status: args.status ?? "waiting" })
    .execute();
  // The root waits on a child run, which shares its Allocation.
  const step = await db
    .insertInto("workflow_step_attempts")
    .values({
      run_id: runId,
      step_index: 0,
      step_node_id: "call-child",
      executor: "boundary",
      attempt: 1,
      status: "waiting",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("workflow_runs")
    .values({
      ...run,
      id: childId,
      parent_run_id: runId,
      parent_workflow_step_attempt_id: step.id,
    })
    .execute();
  await core.executionAllocations.create({
    identity,
    projectId,
    environmentName: "default",
    workloadKind: "agent",
    rootWorkloadId: randomUUID(),
    workerNodeId: args.nodeId,
    policy: {
      binding: descriptor(args.nodeId),
      requirements: { workload: "agent" },
    },
  });
  return { runId, childId, allocationId: allocation.id };
}

it.skipIf(!db)(
  "moves a lost node's runs to a live node, releases its chats, and deletes it",
  async () => {
    if (!core || !db || !nodes) return;
    const lost = await register();
    const live = await register();
    const work = await placeWork({ nodeId: lost.id });
    const job = await new ExecutionJobsService(db).enqueue({
      tenantId: identity.tenantId,
      kind: "durable_boundary",
      payload: {},
      workflowRunId: work.childId,
    });
    const claimOn = (lease: { id: string; token: string }) =>
      new ExecutionJobsService(db, lease).claim({
        workerId: `test:${lease.id}`,
        kinds: ["durable_boundary"],
      });

    // Only the node holding a run's Allocation claims its jobs.
    expect(await claimOn(live)).toEqual([]);
    // Within the grace period a lapsed lease is not yet a lost machine.
    await lapse(lost.id, 5);
    expect(
      (await core.nodeRecovery.recoverLostNodes({ authorityId })).nodes,
    ).toBe(0);

    await lapse(lost.id, 300);
    const result = await core.nodeRecovery.recoverLostNodes({ authorityId });
    expect(result).toMatchObject({
      nodes: 1,
      movedRuns: 1,
      releasedChats: 1,
      failedRuns: 0,
      waitingRuns: 0,
      deletedNodes: 1,
    });
    const runs = await db
      .selectFrom("workflow_runs as run")
      .innerJoin(
        "execution_allocations as allocation",
        "allocation.id",
        "run.allocation_id",
      )
      .select([
        "run.id",
        "allocation.worker_node_id",
        "allocation.status",
        "allocation.binding_id",
      ])
      .where("run.id", "in", [work.runId, work.childId])
      .execute();
    expect(runs).toHaveLength(2);
    for (const run of runs)
      expect(run).toMatchObject({
        worker_node_id: live.id,
        binding_id: live.id,
        status: "active",
      });
    const retired = await db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason", "capacity_released_at"])
      .where("worker_node_id", "=", lost.id)
      .execute();
    expect(retired).toHaveLength(2);
    for (const allocation of retired) {
      expect(allocation).toMatchObject({
        status: "released",
        release_reason: "node_lost",
      });
      expect(allocation.capacity_released_at).not.toBeNull();
    }
    expect(
      await db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", lost.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    // The live node now claims the moved run's job.
    expect((await claimOn(live)).map((claimed) => claimed.id)).toEqual([
      job.id,
    ]);
    // A second pass has nothing left to do.
    expect(
      (await core.nodeRecovery.recoverLostNodes({ authorityId })).nodes,
    ).toBe(0);
  },
  30_000,
);

it.skipIf(!db)(
  "recovers a released node at once, and waits while no machine can take its runs",
  async () => {
    if (!core || !db || !nodes) return;
    // Every other node is gone: nothing can take the work yet.
    await db
      .updateTable("worker_nodes")
      .set({ lease_expires_at: sql<Date>`now() - interval '1 second'` })
      .where("authority_id", "=", authorityId)
      .execute();
    const stopped = await register();
    const work = await placeWork({ nodeId: stopped.id });
    await nodes.release({ lease: stopped });
    const node = await db
      .selectFrom("worker_nodes")
      .select("enabled")
      .where("id", "=", stopped.id)
      .executeTakeFirstOrThrow();
    // Releasing a disposable node retires it for good.
    expect(node.enabled).toBe(false);
    const waiting = await core.nodeRecovery.recoverLostNodes({
      authorityId,
      nodeIds: [stopped.id],
    });
    expect(waiting).toMatchObject({
      nodes: 1,
      movedRuns: 0,
      waitingRuns: 1,
      releasedChats: 1,
      deletedNodes: 0,
    });

    const replacement = await register();
    const moved = await core.nodeRecovery.recoverLostNodes({
      authorityId,
      nodeIds: [stopped.id],
    });
    expect(moved).toMatchObject({ movedRuns: 1, deletedNodes: 1 });
    const run = await db
      .selectFrom("workflow_runs as run")
      .innerJoin(
        "execution_allocations as allocation",
        "allocation.id",
        "run.allocation_id",
      )
      .select("allocation.worker_node_id")
      .where("run.id", "=", work.runId)
      .executeTakeFirstOrThrow();
    expect(run.worker_node_id).toBe(replacement.id);
  },
  30_000,
);

it.skipIf(!db)(
  "fails a run tree its Environment can no longer place",
  async () => {
    if (!core || !db) return;
    const lost = await register();
    await register();
    const work = await placeWork({ nodeId: lost.id, environment: "removed" });
    await lapse(lost.id, 300);
    const result = await core.nodeRecovery.recoverLostNodes({
      authorityId,
      nodeIds: [lost.id],
    });
    expect(result).toMatchObject({ failedRuns: 1, deletedNodes: 1 });
    const runs = await db
      .selectFrom("workflow_runs")
      .select(["status", "error"])
      .where("id", "in", [work.runId, work.childId])
      .execute();
    for (const run of runs) {
      expect(run.status).toBe("failed");
      expect(run.error).toContain("Environment 'removed' is not declared");
    }
    const allocation = await db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason"])
      .where("id", "=", work.allocationId)
      .executeTakeFirstOrThrow();
    expect(allocation).toEqual({
      status: "released",
      release_reason: "node_lost",
    });
  },
  30_000,
);

it.skipIf(!db)(
  "two concurrent passes move a run once",
  async () => {
    if (!core || !db) return;
    await quietOthers();
    const lost = await register();
    const live = await register();
    const work = await placeWork({ nodeId: lost.id });
    await lapse(lost.id, 300);
    const passes = await Promise.all([
      core.nodeRecovery.recoverLostNodes({ authorityId, nodeIds: [lost.id] }),
      core.nodeRecovery.recoverLostNodes({ authorityId, nodeIds: [lost.id] }),
    ]);
    expect(passes.reduce((sum, pass) => sum + pass.movedRuns, 0)).toBe(1);
    const allocations = await db
      .selectFrom("execution_allocations")
      .select(["worker_node_id", "status"])
      .where("root_workload_id", "=", work.runId)
      .orderBy("created_at")
      .execute();
    expect(allocations).toEqual([
      { worker_node_id: lost.id, status: "released" },
      { worker_node_id: live.id, status: "active" },
    ]);
  },
  30_000,
);

it.skipIf(!db)(
  "a job still leased on the lost node is fenced from it and claimed once on the new one",
  async () => {
    if (!core || !db) return;
    await quietOthers();
    const lost = await register();
    const live = await register();
    const work = await placeWork({ nodeId: lost.id });
    await new ExecutionJobsService(db).enqueue({
      tenantId: identity.tenantId,
      kind: "durable_boundary",
      payload: {},
      workflowRunId: work.runId,
    });
    const jobsOn = (lease: { id: string; token: string }) =>
      new ExecutionJobsService(db, lease);
    // The lost node's process claimed the job before it froze.
    const [held] = await jobsOn(lost).claim({
      workerId: "lost-worker",
      kinds: ["durable_boundary"],
      leaseSeconds: 600,
    });
    if (!held?.leaseToken) throw new Error("The lost node claimed nothing");
    await lapse(lost.id, 300);
    expect(
      (
        await core.nodeRecovery.recoverLostNodes({
          authorityId,
          nodeIds: [lost.id],
        })
      ).movedRuns,
    ).toBe(1);
    // The old holder can no longer extend its lease: its run moved away.
    expect(
      await jobsOn(lost).heartbeat({
        jobId: held.id,
        workerId: "lost-worker",
        leaseToken: held.leaseToken,
        leaseGeneration: held.leaseGeneration,
      }),
    ).toBe(false);
    // Nobody else claims it while the old lease stands.
    const claimOnLive = () =>
      jobsOn(live).claim({
        workerId: "live-worker",
        kinds: ["durable_boundary"],
      });
    expect(await claimOnLive()).toEqual([]);
    // Once that lease lapses, the job returns and only the new node takes it.
    await db
      .updateTable("execution_jobs")
      .set({ lease_expires_at: sql<Date>`now() - interval '1 second'` })
      .where("id", "=", held.id)
      .execute();
    await jobsOn(live).requeueExpired();
    expect((await claimOnLive()).map((claimed) => claimed.id)).toEqual([
      held.id,
    ]);
  },
  30_000,
);

it.skipIf(!db)(
  "fails an operator-paused run, and a run whose owner left, instead of holding them",
  async () => {
    if (!core || !db) return;
    await quietOthers();
    const lost = await register();
    await register();
    const paused = await placeWork({
      nodeId: lost.id,
      environment: "removed",
      status: "paused",
    });
    const departed = await placeWork({ nodeId: lost.id, owner: DEPARTED });
    await lapse(lost.id, 300);
    const result = await core.nodeRecovery.recoverLostNodes({
      authorityId,
      nodeIds: [lost.id],
    });
    expect(result).toMatchObject({ failedRuns: 2, deletedNodes: 1 });
    const runs = await db
      .selectFrom("workflow_runs")
      .select(["id", "status", "error"])
      .where("id", "in", [paused.runId, departed.runId])
      .execute();
    expect(runs.map((run) => run.status)).toEqual(["failed", "failed"]);
    expect(runs.find((run) => run.id === departed.runId)?.error).toContain(
      "its owner may no longer run work",
    );
  },
  30_000,
);

it.skipIf(!db)(
  "takes the lost nodes it looked at longest ago first",
  async () => {
    if (!core || !db) return;
    await quietOthers();
    // Another deployment, where no machine can take work: both wait.
    const elsewhere = "recovery-starvation";
    const stuck = await register(elsewhere);
    const newer = await register(elsewhere);
    await placeWork({ nodeId: stuck.id });
    await placeWork({ nodeId: newer.id });
    await lapse(stuck.id, 600);
    await lapse(newer.id, 300);
    const seen: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const pass = await core.nodeRecovery.recoverLostNodes({
        authorityId: elsewhere,
        limit: 1,
      });
      expect(pass).toMatchObject({ nodes: 1, waitingRuns: 1 });
      const [latest] = await db
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "in", [stuck.id, newer.id])
        .orderBy("recovery_attempted_at", (order) => order.desc().nullsLast())
        .execute();
      if (latest) seen.push(latest.id);
    }
    expect(seen).toEqual([stuck.id, newer.id]);
  },
  30_000,
);
