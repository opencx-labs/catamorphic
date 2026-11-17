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
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { sql } from "kysely";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CatamorphicCore } from "../core.js";
import { cleanupWorkerAllocations } from "../services/allocation-sandbox-provider.js";
import { ConnectionUnavailableError } from "../services/connections-service.js";
import { MAX_QUEUED_START_ATTEMPTS } from "../services/runs-service.js";
import { EnvironmentCapacityError } from "../services/worker-capacity.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";
import { WorkflowNotFoundError } from "../services/workflows-service.js";

const ownedSandboxes = new TestSandboxes();

const schema = `run_queue_${randomUUID().replaceAll("-", "")}`;
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
  ".work/workflows/src/queue.ts": `import { defineWorkflow, type BoundaryContext } from "@catamorphic/workflow";
// Each run waits for "go" so the test decides when it settles.
export const publish = defineWorkflow(({ defineBoundary }) => ({
  concurrency: { key: "subject.id", onConflict: "queue" },
  steps: [
    defineBoundary({ run: ({ input, pause }: BoundaryContext<{ subject?: { id: string }; n: number; fail?: boolean }>) => {
      if (input.fail) throw new Error("publication failed");
      return pause({ signal: "go" });
    } }),
    defineBoundary({ run: ({ input }: BoundaryContext<{ reason: string; value: { n: number } }>) => input.value }),
  ],
}));
export const cleanup = defineWorkflow(({ defineBoundary }) => ({ steps: [
  defineBoundary({ run: ({ input }: BoundaryContext<{ id: string }>) => ({ cleaned: input.id }) }),
] }));`,
});

describe.skipIf(!process.env.DATABASE_URL)(
  "runs queued per key (ADR 0325)",
  () => {
    beforeAll(async () => {
      await migrateToLatest({ db, schema });
      root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-capacity-"));
      provider = ownedSandboxes.track(
        new LocalProcessSandboxProvider({
          root: path.join(root, "sandboxes"),
        }),
      );
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
    }, 60_000);
    afterEach(async () => {
      await cleanupTestResources([
        () => core.runs.stopWorkers(),
        () => cleanupWorkerAllocations({ db, workerNode: lease, provider }),
        () =>
          core.runs.list({ identity, projectId }).then(async (page) => {
            for (const run of page.items)
              if (!["completed", "failed", "canceled"].includes(run.status))
                await core.runs
                  .cancel({ identity, runId: run.id })
                  .catch(() => {});
          }),
        () => ownedSandboxes.cleanup(),
      ]);
    });
    afterAll(async () => {
      clearInterval(heartbeat);
      await cleanupTestResources(
        [
          () => renewing,
          () => core?.runs.stopWorkers(),
          () => ownedSandboxes.cleanup(),
          () => db.schema.dropSchema(schema).cascade().execute(),
          () => db.destroy(),
        ],
        async () => {
          if (root) await fs.rm(root, { recursive: true, force: true });
        },
      );
    });

    const status = async (runId: string) => {
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      return (await core.runs.get({ identity, runId })).status;
    };
    const statusOnly = async (runId: string) =>
      (await core.runs.get({ identity, runId })).status;
    const release = async (runId: string, n: number) => {
      await expect
        .poll(() => status(runId), { timeout: 20_000 })
        .toBe("waiting");
      const pause = (await core.runs.get({ identity, runId })).activePause;
      if (!pause) throw new Error("The run is not paused");
      await core.runs.resumePause({
        identity,
        runId,
        pauseId: pause.id,
        idempotencyKey: `go:${runId}`,
        value: { n },
      });
      await expect
        .poll(() => status(runId), { timeout: 20_000 })
        .toBe("completed");
    };
    const enroll = (input: {
      subject?: { id: string };
      n: number;
      fail?: boolean;
    }) =>
      core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "publish",
        input,
      });

    it("runs one at a time per key, in arrival order, holding no capacity while queued", async () => {
      core.runs.startWorker({
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      const parked = async (runId: string) => {
        await expect
          .poll(() => status(runId), { timeout: 20_000 })
          .toBe("waiting");
        const { allocationId } = await core.runs.get({ identity, runId });
        await expect
          .poll(
            async () => {
              await cleanupWorkerAllocations({
                db,
                workerNode: lease,
                provider,
              });
              return (
                await core.executionAllocations.get({
                  identity,
                  allocationId: allocationId ?? "",
                })
              )?.status;
            },
            { timeout: 20_000 },
          )
          .toBe("released");
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      };
      const first = await enroll({ subject: { id: "pr-1" }, n: 1 });
      expect(first.correlationKey).toBe("pr-1");
      expect(first.status).toBe("pending");
      // Overlapping enrollments for the key decide under its lock; none
      // needs a workspace, though the only one is taken.
      const later = await Promise.all(
        [2, 3, 4].map((n) => enroll({ subject: { id: "pr-1" }, n })),
      );
      for (const run of later) {
        expect(run.status).toBe("queued");
        expect(run.allocationId).toBeNull();
      }
      const order = (
        await db
          .selectFrom("workflow_runs")
          .select("id")
          .where("status", "=", "queued")
          .where("correlation_key", "=", "pr-1")
          .orderBy("queued_at")
          .orderBy("id")
          .execute()
      ).map((row) => row.id);
      expect(new Set(order)).toEqual(new Set(later.map((run) => run.id)));
      await parked(first.id);
      // Another key and an unkeyed run are not held up by the queue.
      const other = await enroll({ subject: { id: "pr-2" }, n: 20 });
      expect(other.status).toBe("pending");
      await parked(other.id);
      const unkeyed = await enroll({ n: 30 });
      expect(unkeyed.correlationKey).toBeNull();
      expect(unkeyed.status).toBe("pending");
      await parked(unkeyed.id);
      // Three queued runs hold no workspace: the one slot takes other work.
      const cleanup = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "cleanup",
        input: { id: "slot" },
      });
      await expect
        .poll(() => status(cleanup.id), { timeout: 20_000 })
        .toBe("completed");

      await release(first.id, 1);
      const results: number[] = [1];
      for (const runId of order) {
        for (const queued of order.slice(order.indexOf(runId) + 1))
          expect(await status(queued)).toBe("queued");
        await release(runId, results.length + 1);
        results.push(results.length + 1);
      }
      const settled = await db
        .selectFrom("workflow_runs")
        .select(["id", "result", "completed_at"])
        .where("id", "in", [first.id, ...order])
        .orderBy("completed_at")
        .execute();
      expect(settled.map((run) => run.id)).toEqual([first.id, ...order]);
      await release(other.id, 20);
      await release(unkeyed.id, 30);
    }, 120_000);

    it("a failed or canceled run frees the key, and a canceled queued run is skipped", async () => {
      core.runs.startWorker({
        pollIntervalMs: 10,
        idlePollIntervalMs: 50,
        leaseSeconds: 30,
      });
      const failing = await enroll({
        subject: { id: "pr-9" },
        n: 1,
        fail: true,
      });
      const canceledLater = await enroll({ subject: { id: "pr-9" }, n: 2 });
      const queuedThenCanceled = await enroll({
        subject: { id: "pr-9" },
        n: 3,
      });
      const last = await enroll({ subject: { id: "pr-9" }, n: 4 });
      expect([
        canceledLater.status,
        queuedThenCanceled.status,
        last.status,
      ]).toEqual(["queued", "queued", "queued"]);
      // Canceling a queued run ends it where it stands.
      expect(
        (await core.runs.cancel({ identity, runId: queuedThenCanceled.id }))
          .status,
      ).toBe("canceled");
      await expect
        .poll(() => status(failing.id), { timeout: 20_000 })
        .toBe("failed");
      // The failure freed the key for the next in line.
      await expect
        .poll(() => status(canceledLater.id), { timeout: 20_000 })
        .toBe("waiting");
      expect(await status(last.id)).toBe("queued");
      await core.runs.cancel({ identity, runId: canceledLater.id });
      await release(last.id, 4);
      expect(await status(queuedThenCanceled.id)).toBe("canceled");
    }, 90_000);

    it("a sweep starts a queued run whose turn came while nothing settled here", async () => {
      const first = await enroll({ subject: { id: "pr-sweep" }, n: 1 });
      const next = await enroll({ subject: { id: "pr-sweep" }, n: 2 });
      expect(next.status).toBe("queued");
      // The active run ends behind the scheduler's back, as a crashed replica's would.
      await db
        .updateTable("workflow_runs")
        .set({ status: "canceled", completed_at: sql<Date>`now()` })
        .where("id", "=", first.id)
        .execute();
      await db
        .updateTable("execution_allocations")
        .set({ status: "released", released_at: sql<Date>`now()` })
        .where("id", "=", first.allocationId ?? "")
        .execute();
      expect(await status(next.id)).toBe("queued");
      await core.runs.startQueuedRuns();
      expect(await status(next.id)).toBe("pending");
      await core.runs.cancel({ identity, runId: next.id });
    }, 30_000);

    it("full slots leave an automation on: its run retries, and a queued run waits for room", async () => {
      const enable = async (workflowName: string) => {
        const preview = await core.workflowEnablements.preview({
          identity,
          projectId,
          workflowName,
        });
        return core.workflowEnablements.create({
          identity,
          projectId,
          workflowName,
          consentDigest: preview.consentDigest,
        });
      };
      const cleanupOn = await enable("cleanup");
      const publishOn = await enable("publish");
      // No worker runs, so the blocker keeps the only workspace reserved.
      const blocker = await core.runs.triggerProduction({
        identity,
        projectId,
        workflowName: "cleanup",
        input: { id: "blocker" },
      });
      await expect(
        core.runs.triggerWithEnablement({
          identity,
          projectId,
          workflowName: "cleanup",
          enablementId: cleanupOn.id,
          input: { id: "automation" },
        }),
      ).rejects.toBeInstanceOf(EnvironmentCapacityError);
      expect(
        await core.workflowEnablements.get({
          identity,
          enablementId: cleanupOn.id,
        }),
      ).toMatchObject({ status: "active", suspensionReason: null });
      await core.runs.cancel({ identity, runId: blocker.id });
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      const retried = await core.runs.triggerWithEnablement({
        identity,
        projectId,
        workflowName: "cleanup",
        enablementId: cleanupOn.id,
        input: { id: "automation" },
      });
      expect(retried.status).toBe("pending");
      await core.runs.cancel({ identity, runId: retried.id });
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });

      const automated = (n: number) =>
        core.runs.triggerWithEnablement({
          identity,
          projectId,
          workflowName: "publish",
          enablementId: publishOn.id,
          input: { subject: { id: "pr-room" }, n },
        });
      const ahead = await automated(1);
      const behind = await automated(2);
      expect([ahead.status, behind.status]).toEqual(["pending", "queued"]);
      // Its turn comes while the ended run's workspace is still held.
      await core.runs.cancel({ identity, runId: ahead.id });
      expect(await statusOnly(behind.id)).toBe("queued");
      await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      // The ended run's settling wakes the head that waited for its room.
      await core.runs.startQueuedRuns({ runId: ahead.id });
      const started = await core.runs.get({ identity, runId: behind.id });
      expect(started.status).toBe("pending");
      expect(started.workflowEnablementId).toBe(publishOn.id);
      await core.runs.cancel({ identity, runId: behind.id });
    }, 60_000);

    describe("starting heads (review fixes)", () => {
      const queuedRow = (runId: string) =>
        db
          .selectFrom("workflow_runs")
          .select([
            "status",
            "error",
            "queue_attempts",
            "queue_blocked",
            "completed_at",
          ])
          .where("id", "=", runId)
          .executeTakeFirstOrThrow();
      /** An active head for the key, then runs queued behind it. */
      const lane = async (subject: string, count: number) => {
        const first = await enroll({ subject: { id: subject }, n: 0 });
        const queued = [];
        for (let n = 1; n <= count; n += 1)
          queued.push(await enroll({ subject: { id: subject }, n }));
        return { first, queued };
      };
      const endAhead = async (runId: string) => {
        await core.runs.cancel({ identity, runId });
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
      };

      it("fails a head whose start is refused for good, freeing its key at once", async () => {
        const { first, queued } = await lane("pr-refused", 2);
        const ensure = vi
          .spyOn(core.deploymentArtifacts, "ensure")
          .mockRejectedValueOnce(
            new WorkflowNotFoundError(projectId, "publish"),
          );
        try {
          await endAhead(first.id);
        } finally {
          ensure.mockRestore();
        }
        expect(await queuedRow(queued[0]?.id ?? "")).toMatchObject({
          status: "failed",
          error: expect.stringContaining("The queued run cannot start"),
          completed_at: expect.any(Date),
        });
        // The key's next run was tried in the same pass (the cancel's); it
        // found the ended run's room still held, and starts once it is free.
        expect(await queuedRow(queued[1]?.id ?? "")).toMatchObject({
          status: "queued",
          queue_blocked: "room",
        });
        await core.runs.startQueuedRuns({ runId: first.id });
        expect(await statusOnly(queued[1]?.id ?? "")).toBe("pending");
        await core.runs.cancel({ identity, runId: queued[1]?.id ?? "" });
      }, 30_000);

      it("retries an unexpected failure with backoff, then fails the head after a bound", async () => {
        const { first, queued } = await lane("pr-flaky", 2);
        const head = queued[0]?.id ?? "";
        const ensure = vi
          .spyOn(core.deploymentArtifacts, "ensure")
          .mockRejectedValue(new Error("artifact build broke"));
        try {
          await endAhead(first.id);
          await core.runs.startQueuedRuns();
          expect(await queuedRow(head)).toMatchObject({
            status: "queued",
            error: "artifact build broke",
            queue_attempts: 1,
            queue_blocked: "error",
          });
          // Not due again yet: the sweep leaves it alone.
          await core.runs.startQueuedRuns();
          expect((await queuedRow(head)).queue_attempts).toBe(1);
          await db
            .updateTable("workflow_runs")
            .set({
              queue_attempts: MAX_QUEUED_START_ATTEMPTS - 1,
              queue_attempted_at: sql<Date>`now() - interval '1 hour'`,
            })
            .where("id", "=", head)
            .execute();
          await core.runs.startQueuedRuns();
          expect(await queuedRow(head)).toMatchObject({
            status: "failed",
            error: expect.stringContaining("artifact build broke"),
          });
        } finally {
          ensure.mockRestore();
        }
        // The next head tried in the same pass and failed once; when due,
        // it starts.
        await db
          .updateTable("workflow_runs")
          .set({ queue_attempted_at: sql<Date>`now() - interval '1 hour'` })
          .where("id", "=", queued[1]?.id ?? "")
          .execute();
        await core.runs.startQueuedRuns();
        expect(await statusOnly(queued[1]?.id ?? "")).toBe("pending");
        await core.runs.cancel({ identity, runId: queued[1]?.id ?? "" });
      }, 30_000);

      it("counts waits for room apart from errors, and retries a connection that is unavailable for now", async () => {
        const { first, queued } = await lane("pr-room-then-error", 1);
        const head = queued[0]?.id ?? "";
        const due = () =>
          db
            .updateTable("workflow_runs")
            .set({ queue_attempted_at: sql<Date>`now() - interval '1 hour'` })
            .where("id", "=", head)
            .execute();
        // Its turn comes while the ended run's workspace is still held, and
        // it waits for room many times.
        await core.runs.cancel({ identity, runId: first.id });
        for (let wait = 0; wait < MAX_QUEUED_START_ATTEMPTS; wait += 1) {
          await due();
          await core.runs.startQueuedRuns();
        }
        expect(await queuedRow(head)).toMatchObject({
          status: "queued",
          queue_attempts: 0,
          queue_blocked: "room",
        });
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
        // Then a connection is unavailable for a moment: an error to retry,
        // the first one, not a refusal and not past the bound.
        const ensure = vi
          .spyOn(core.deploymentArtifacts, "ensure")
          .mockRejectedValueOnce(
            new ConnectionUnavailableError(
              "github",
              "The broker is restarting",
            ),
          );
        try {
          await due();
          await core.runs.startQueuedRuns();
        } finally {
          ensure.mockRestore();
        }
        expect(await queuedRow(head)).toMatchObject({
          status: "queued",
          queue_attempts: 1,
          queue_blocked: "error",
        });
        await due();
        await core.runs.startQueuedRuns();
        expect(await statusOnly(head)).toBe("pending");
        await core.runs.cancel({ identity, runId: head });
      }, 60_000);

      it("wakes a head waiting for room when any run settles, and when a child's job settles its root", async () => {
        const { first, queued } = await lane("pr-room-wake", 1);
        const head = queued[0]?.id ?? "";
        // Its turn comes while the ended run's workspace is still held.
        await core.runs.cancel({ identity, runId: first.id });
        expect(await queuedRow(head)).toMatchObject({
          status: "queued",
          queue_blocked: "room",
        });
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
        // Not due for the sweep, but another run settling frees room.
        await core.runs.startQueuedRuns();
        expect(await statusOnly(head)).toBe("queued");
        const other = await core.runs.triggerProduction({
          identity,
          projectId,
          workflowName: "cleanup",
          input: { id: "frees-room" },
        });
        await core.runs.cancel({ identity, runId: other.id });
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
        await core.runs.startQueuedRuns({ runId: other.id });
        expect(await statusOnly(head)).toBe("pending");

        // A child's settled job names its root's key.
        const next = await enroll({ subject: { id: "pr-room-wake" }, n: 9 });
        expect(next.status).toBe("queued");
        const attempt = await db
          .selectFrom("workflow_step_attempts")
          .select("id")
          .where("run_id", "=", head)
          .executeTakeFirstOrThrow();
        const child = randomUUID();
        await db
          .insertInto("workflow_runs")
          .values({
            id: child,
            project_id: projectId,
            workflow_name: "cleanup",
            provenance: {},
            parent_run_id: head,
            parent_workflow_step_attempt_id: attempt.id,
            status: "completed",
            completed_at: sql<Date>`now()`,
          })
          .execute();
        await db
          .updateTable("workflow_runs")
          .set({ status: "completed", completed_at: sql<Date>`now()` })
          .where("id", "=", head)
          .execute();
        await db
          .updateTable("execution_allocations")
          .set({ status: "released", released_at: sql<Date>`now()` })
          .where("root_workload_id", "=", head)
          .execute();
        await cleanupWorkerAllocations({ db, workerNode: lease, provider });
        await core.runs.startQueuedRuns({ runId: child });
        expect(await statusOnly(next.id)).toBe("pending");
        await core.runs.cancel({ identity, runId: next.id });
      }, 30_000);

      it("pages heads fairly: one tenant's backlog never fills the page", async () => {
        const otherTenant = randomUUID();
        const otherProject = randomUUID();
        await db
          .insertInto("tenants")
          .values({ id: otherTenant, name: "Other" })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        await db
          .insertInto("projects")
          .values({ id: otherProject, tenant_id: otherTenant, name: "Other" })
          .execute();
        const queuedRun = (project: string, key: string, at: string) => ({
          id: randomUUID(),
          project_id: project,
          workflow_name: "publish",
          provenance: {},
          status: "queued",
          correlation_key: key,
          queued_at: sql<Date>`${at}::timestamptz`,
        });
        const backlog = Array.from({ length: 30 }, (_, index) =>
          queuedRun(projectId, `backlog-${index}`, "2026-01-01T00:00:00Z"),
        );
        const late = queuedRun(otherProject, "late", "2026-06-01T00:00:00Z");
        await db
          .insertInto("workflow_runs")
          .values([...backlog, late])
          .execute();
        const picked: string[] = [];
        const start = vi
          .spyOn(
            core.runs as unknown as {
              startQueuedRun(head: { id: string }): Promise<string>;
            },
            "startQueuedRun",
          )
          .mockImplementation(async (head) => {
            picked.push(head.id);
            return "waiting";
          });
        try {
          await core.runs.startQueuedRuns({ limit: 8 });
        } finally {
          start.mockRestore();
          await db
            .deleteFrom("workflow_runs")
            .where(
              "id",
              "in",
              [...backlog, late].map((run) => run.id),
            )
            .execute();
        }
        expect(picked).toHaveLength(3);
        expect(picked).toContain(late.id);
      }, 30_000);
    });
  },
);
