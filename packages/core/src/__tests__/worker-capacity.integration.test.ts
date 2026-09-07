import { randomUUID } from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type { SandboxProvider } from "@catamorphic/sandbox";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  allocationSandboxProvider,
  cleanupWorkerAllocations,
} from "../services/allocation-sandbox-provider.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { EnvironmentCapacityError } from "../services/worker-capacity.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

const schema = `capacity_${randomUUID().replaceAll("-", "")}`;
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

it.skipIf(!db)(
  "reserves atomically, retains failed cleanup, and fences retired sandboxes",
  async () => {
    if (!db) return;
    const identity = { tenantId: randomUUID(), externalUserId: "member" };
    const projectId = randomUUID();
    const descriptor = {
      id: randomUUID(),
      label: "Compute",
      trust: "managed" as const,
      isolation: "sandbox" as const,
      workloads: ["agent" as const],
      agentTopologies: ["controller" as const],
      capabilities: [],
      resourceLimits: ["cpuMillis" as const, "memoryMb" as const],
      resources: { cpuMillis: 2000, memoryMb: 2048 },
    };
    const nodes = new WorkerNodesService(db);
    const lease = await nodes.register({
      tenantId: identity.tenantId,
      authorityId: "test",
      descriptor,
      capacity: { workspaces: 2, cpuMillis: 2000, memoryMb: 2048 },
      defaults: { cpuMillis: 1000, memoryMb: 1024 },
    });
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: identity.tenantId, name: "Compute" })
      .execute();
    const allocations = new ExecutionAllocationsService(db);
    const create = () =>
      allocations.create({
        identity,
        projectId,
        environmentName: "compute",
        workloadKind: "agent",
        rootWorkloadId: randomUUID(),
        workerNodeId: lease.id,
        policy: { binding: descriptor, requirements: { workload: "agent" } },
      });
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, create),
    );
    const admitted = attempts.flatMap((item) =>
      item.status === "fulfilled" ? [item.value] : [],
    );
    expect(admitted).toHaveLength(2);
    for (const result of attempts)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(EnvironmentCapacityError);
    expect(
      (
        await nodes.list({ tenantId: identity.tenantId, authorityId: "test" })
      )[0],
    ).toMatchObject({
      acceptingWork: false,
      usage: { workspaces: 2, cpuMillis: 2000, memoryMb: 2048 },
    });
    const allocation = admitted[0];
    if (!allocation) throw Error("Missing Allocation");
    const runId = randomUUID();
    await db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "capacityFixture",
        provenance: {},
        status: "pending",
        allocation_id: allocation.id,
      })
      .execute();
    const jobs = new ExecutionJobsService(db, lease);
    for (const direct of [false, true]) {
      const job = await jobs.enqueue({
        tenantId: identity.tenantId,
        workflowRunId: runId,
        kind: "durable_boundary",
        payload: {},
      });
      const claimed = direct
        ? await jobs.claimById({ jobId: job.id, workerId: "worker" })
        : (
            await jobs.claim({
              workerId: "worker",
              kinds: ["durable_boundary"],
              limit: 1,
            })
          )[0];
      if (!claimed) throw Error("Worker did not claim its allocation");
      const ownership = {
        jobId: claimed.id,
        workerId: "worker",
        leaseToken: claimed.leaseToken ?? "",
        leaseGeneration: claimed.leaseGeneration,
      };
      expect(await jobs.heartbeat(ownership)).toBe(true);
      await jobs.complete(ownership);
    }
    const createSandbox = vi.fn(async () => ({
      id: "sandbox",
      providerId: "sandbox",
      sandboxType: "dev" as const,
      status: "started" as const,
    }));
    const destroySandbox = vi.fn(async () => {});
    const provider: SandboxProvider = {
      workspaceRoot: "/workspace",
      createSandbox,
      destroySandbox,
      startSandbox: async () => {},
      stopSandbox: async () => {},
      getSandboxStatus: async () => "started",
      executeCommand: async () => ({ exitCode: 0, result: "ok" }),
      uploadFiles: async () => {},
      downloadFile: async () => "",
      gitClone: async () => {},
      gitCheckout: async () => {},
    };
    const scoped = allocationSandboxProvider({
      db,
      allocation,
      provider,
      workerLeaseToken: lease.token,
    });
    await scoped.createSandbox({ resources: { cpuMillis: 999_000 } });
    await scoped.createSandbox({});
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: expect.objectContaining({ cpuMillis: 1000, memoryMb: 1024 }),
      }),
    );
    await allocations.release({ identity, allocationId: allocation.id });
    await expect(
      scoped.executeCommand("sandbox", "touch unsafe"),
    ).rejects.toThrow("no longer active");
    await expect(create()).rejects.toBeInstanceOf(EnvironmentCapacityError);
    destroySandbox.mockRejectedValueOnce(new Error("Backend unavailable"));
    await expect(
      cleanupWorkerAllocations({ db, workerNode: lease, provider }),
    ).rejects.toThrow("Backend unavailable");
    await expect(create()).rejects.toBeInstanceOf(EnvironmentCapacityError);
    const other = admitted[1];
    if (!other) throw Error("Missing second allocation");
    await allocations.release({ identity, allocationId: other.id });
    destroySandbox.mockRejectedValueOnce(new Error("Backend unavailable"));
    await expect(
      cleanupWorkerAllocations({ db, workerNode: lease, provider }),
    ).rejects.toThrow("Backend unavailable");
    // One broken teardown cannot hold up unrelated retired workspaces.
    const replacement = await create();
    expect(replacement.workerNodeId).toBe(lease.id);
    expect(
      await cleanupWorkerAllocations({ db, workerNode: lease, provider }),
    ).toBe(1);
    await expect(create()).resolves.toMatchObject({ workerNodeId: lease.id });
    await allocations.release({ identity, allocationId: replacement.id });
    expect(
      await nodes.confirmWorkspaceDestroyed({
        tenantId: identity.tenantId,
        authorityId: "wrong",
        nodeId: lease.id,
        allocationId: replacement.id,
      }),
    ).toBe(false);
    expect(
      await nodes.confirmWorkspaceDestroyed({
        tenantId: identity.tenantId,
        authorityId: "test",
        nodeId: lease.id,
        allocationId: replacement.id,
      }),
    ).toBe(true);
  },
);
