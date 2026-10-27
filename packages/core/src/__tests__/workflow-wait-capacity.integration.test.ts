import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type {
  EnvironmentBinding,
  EnvironmentProvider,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import { cleanupWorkerAllocations } from "../services/allocation-sandbox-provider.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

const schema = `wait_capacity_${randomUUID().replaceAll("-", "")}`;
const db = createDatabase({
  connectionString: process.env.DATABASE_URL ?? "",
  schema,
  poolSize: 8,
});
const identity = { tenantId: randomUUID(), externalUserId: "owner" };
const projectId = randomUUID();
const binding: EnvironmentBinding = {
  id: randomUUID(),
  label: "One workspace",
  trust: "local",
  isolation: "process",
  workloads: ["workflow"],
  agentTopologies: [],
  capabilities: [],
  resources: {},
};
let root = "";
let core: CatamorphicCore;
let provider: LocalProcessSandboxProvider;
let lease: { id: string; token: string };
let nodes: WorkerNodesService;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let renewing: Promise<void> = Promise.resolve();

const files = (version: string) => ({
  ".work/package.json": JSON.stringify({
    private: true,
    type: "module",
    workspaces: ["workflows"],
  }),
  ".work/workflows/package.json": JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@catamorphic/workflow": version },
  }),
  ".work/workflows/src/wait.ts": `import { defineWorkflow, type BoundaryContext } from "@catamorphic/workflow";
export const wait = defineWorkflow(({ defineBoundary }) => ({ steps: [
  defineBoundary({ run: ({ pause }: BoundaryContext<{ id: string }>) => pause({ signal: "continue", state: {} }) }),
  defineBoundary({ run: ({ input }: BoundaryContext<{ reason: string; value: { done: boolean } }>) => input.value }),
] }));
export const parent = defineWorkflow(({ defineBoundary }) => ({ steps: [
  defineBoundary({ run: ({ input, callWorkflow }: BoundaryContext<{ id: string }>) => callWorkflow(wait, { input }) }),
] }));
export const timed = defineWorkflow(({ defineBoundary }) => ({ steps: [
  defineBoundary({ run: ({ pause }: BoundaryContext<{ id: string }>) => pause({ timeout: "1h", state: {} }) }),
  defineBoundary({ run: ({ input }: BoundaryContext<{ reason: string }>) => ({ reason: input.reason }) }),
] }));
export const cleanup = defineWorkflow(({ defineBoundary }) => ({ steps: [
  defineBoundary({ run: ({ input }: BoundaryContext<{ id: string }>) => ({ cleaned: input.id }) }),
] }));`,
});

describe.skipIf(!process.env.DATABASE_URL)(
  "workflow waits and physical capacity",
  () => {
    beforeAll(async () => {
      await migrateToLatest({ db, schema });
      root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-capacity-"));
      provider = new LocalProcessSandboxProvider({
        root: path.join(root, "sandboxes"),
      });
      nodes = new WorkerNodesService(db);
      lease = await nodes.register({
        tenantId: identity.tenantId,
        authorityId: "wait-test",
        descriptor: binding,
        capacity: { workspaces: 1 },
      });
      heartbeat = setInterval(() => {
        renewing = renewing.then(async () => {
          await nodes.renew({ lease });
        });
      }, 10_000);
      const environments: EnvironmentProvider = {
        get: async ({ allocationBindingId }) =>
          !allocationBindingId || allocationBindingId === binding.id
            ? {
                descriptor: binding,
                workerNodeId: lease.id,
                sandboxProvider: provider,
              }
            : undefined,
      };
      const projectManager = new ProjectManager(
        new FsBackend(path.join(root, "projects")),
        new FsRemoteBackend(path.join(root, "remotes")),
      );
      await db
        .insertInto("projects")
        .values({
          id: projectId,
          tenant_id: identity.tenantId,
          name: "Capacity",
        })
        .execute();
      const metadata: unknown = JSON.parse(
        await fs.readFile(
          new URL("../../../workflow/package.json", import.meta.url),
          "utf8",
        ),
      );
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        !("version" in metadata) ||
        typeof metadata.version !== "string"
      )
        throw Error("Missing workflow version");
      const repo = await projectManager.create(identity.tenantId, projectId, {
        name: "capacity",
        externalUserId: identity.externalUserId,
        initialFiles: files(metadata.version),
      });
      await repo.dispose();
      core = new CatamorphicCore({
        db,
        projectManager,
        workerNode: lease,
        environmentProvider: environments,
      });
    });
    afterEach(async () => {
      await core.runs.stopWorkers();
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
    });
    afterAll(async () => {
      clearInterval(heartbeat);
      await renewing;
      if (core) await core.runs.stopWorkers();
      // Confirmed teardown also closes the real subprocess runtimes on assertion failure.
      const sandboxes = await db
        .selectFrom("execution_allocations")
        .select("sandbox_provider_id")
        .execute();
      for (const row of sandboxes)
        if (row.sandbox_provider_id)
          await provider.destroySandbox(row.sandbox_provider_id);
      await db.schema.dropSchema(schema).cascade().execute();
      await db.destroy();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("parks more waiting roots than slots and admits independent cleanup using real subprocess runtimes", async () => {
      core.runs.startWorker({
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      const waiting: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const run = await core.runs.triggerProduction({
          identity,
          projectId,
          workflowName: "wait",
          input: { id: String(index) },
          correlationKey: String(index),
        });
        waiting.push(run.id);
        await expect
          .poll(
            async () =>
              (await core.runs.get({ identity, runId: run.id })).status,
            { timeout: 15_000 },
          )
          .toBe("waiting");
        if (!run.allocationId) throw Error("Run has no Allocation");
        const allocationId = run.allocationId;
        await expect
          .poll(
            async () =>
              (await core.executionAllocations.get({ identity, allocationId }))
                ?.status,
            { timeout: 2_000 },
          )
          .toBe("released");
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
        expect(
          (
            await nodes.list({
              tenantId: identity.tenantId,
              authorityId: "wait-test",
            })
          )[0]?.usage.workspaces,
        ).toBe(0);
      }
      const cleanup = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "cleanup",
        input: { id: "external-resource" },
      });
      await expect
        .poll(
          async () =>
            (await core.runs.get({ identity, runId: cleanup.id })).status,
          { timeout: 15_000 },
        )
        .toBe("completed");
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      // Three continuations race for one slot, each on the unchanged deployed revision.
      await Promise.all(
        waiting.map((runId, index) =>
          core.runs.signalByKey({
            identity,
            runId,
            projectId,
            workflowName: "wait",
            correlationKey: String(index),
            signal: "continue",
            idempotencyKey: runId,
            value: { done: true },
          }),
        ),
      );
      for (const runId of waiting) {
        await expect
          .poll(
            async () => {
              await cleanupWorkerAllocations({
                db,
                workerNode: lease,
                provider,
              });
              return (await core.runs.get({ identity, runId })).status;
            },
            { timeout: 20_000 },
          )
          .toBe("completed");
      }
      const runs = await db
        .selectFrom("workflow_runs")
        .select(["deployment_artifact_id", "result"])
        .where("id", "in", waiting)
        .execute();
      expect(new Set(runs.map((run) => run.deployment_artifact_id)).size).toBe(
        1,
      );
      for (const run of runs) expect(run.result).toEqual({ done: true });
    }, 90_000);
    it("parks a parent and its paused child together and refences both on continuation", async () => {
      core.runs.startWorker({
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      const parent = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "parent",
        input: { id: "child" },
      });
      if (!parent.allocationId) throw Error("No parent Allocation");
      const oldId = parent.allocationId;
      await expect
        .poll(
          async () =>
            (
              await core.executionAllocations.get({
                identity,
                allocationId: oldId,
              })
            )?.status,
          { timeout: 15_000 },
        )
        .toBe("released");
      const child = await db
        .selectFrom("workflow_runs")
        .select("id")
        .where("parent_run_id", "=", parent.id)
        .executeTakeFirstOrThrow();
      const paused = await core.runs.get({ identity, runId: child.id });
      if (!paused.activePause) throw Error("No child pause");
      expect(paused.allocationId).toBe(oldId);
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      await core.runs.resumePause({
        identity,
        runId: child.id,
        pauseId: paused.activePause.id,
        idempotencyKey: child.id,
        value: { done: true },
      });
      await expect
        .poll(
          async () =>
            (await core.runs.get({ identity, runId: parent.id })).status,
          { timeout: 20_000 },
        )
        .toBe("completed");
      const runs = await db
        .selectFrom("workflow_runs")
        .select(["allocation_id", "deployment_artifact_id", "result"])
        .where("id", "in", [parent.id, child.id])
        .execute();
      expect(new Set(runs.map((run) => run.allocation_id)).size).toBe(1);
      expect(runs[0]?.allocation_id).not.toBe(oldId);
      expect(new Set(runs.map((run) => run.deployment_artifact_id)).size).toBe(
        1,
      );
      for (const run of runs) expect(run.result).toEqual({ done: true });
    }, 45_000);

    it("resolves a parked timeout while the only workspace is occupied and waits to re-admit compute", async () => {
      const worker = core.runs.startWorker({
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      const run = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "timed",
        input: { id: "deadline" },
      });
      if (!run.allocationId) throw Error("No Allocation");
      const oldId = run.allocationId;
      await expect
        .poll(
          async () =>
            (
              await core.executionAllocations.get({
                identity,
                allocationId: oldId,
              })
            )?.status,
          { timeout: 15_000 },
        )
        .toBe("released");
      await worker.stop();
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      const blocker = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "cleanup",
        input: { id: "occupy" },
      });
      await db
        .updateTable("workflow_pauses")
        .set({ timeout_at: sql<Date>`now() - interval '1 second'` })
        .where("run_id", "=", run.id)
        .execute();
      await db
        .updateTable("execution_jobs")
        .set({ available_at: sql<Date>`now()` })
        .where("workflow_run_id", "=", run.id)
        .where("kind", "=", "durable_pause_timeout")
        .execute();
      const timers = core.runs.startWorker({
        kinds: ["durable_pause_timeout"],
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom("workflow_pauses")
                .select("status")
                .where("run_id", "=", run.id)
                .executeTakeFirst()
            )?.status,
          { timeout: 10_000 },
        )
        .toBe("timed_out");
      expect(
        (await core.runs.get({ identity, runId: run.id })).allocationId,
      ).toBe(oldId);
      expect(
        (await core.runs.get({ identity, runId: blocker.id })).status,
      ).toBe("pending");
      await timers.stop();
      core.runs.startWorker({
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      await expect
        .poll(
          async () => {
            await cleanupWorkerAllocations({ db, workerNode: lease, provider });
            return (await core.runs.get({ identity, runId: run.id })).status;
          },
          { timeout: 20_000 },
        )
        .toBe("completed");
      expect((await core.runs.get({ identity, runId: run.id })).result).toEqual(
        { reason: "timed_out" },
      );
    }, 60_000);
  },
);
