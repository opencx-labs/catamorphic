import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type {
  EnvironmentBinding,
  RuntimeInvocationReceipt,
} from "@catamorphic/sandbox";
import {
  cleanupTestResources,
  TestSandboxes,
} from "@catamorphic/sandbox/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { cleanupWorkerAllocations } from "../services/allocation-sandbox-provider.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";
import { RecordingAdapter } from "./recording-adapter.js";

const ownedSandboxes = new TestSandboxes();

/*
 * A command that outlives its attempt (ADR 0324), from a run whose
 * Allocation is on a worker node, as a Work server places every run. The
 * step parks, the run gives its Allocation back (ADR 0289), and the follower
 * job has to be claimed, keep its lease and resume the run with no placement
 * at all: an Environment setup workflow whose install took over a minute
 * used to leave its chat preparing until the setup timed out.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const schema = `catamorphic_exec_placed_${crypto.randomUUID().replaceAll("-", "")}`;
const tenantId = crypto.randomUUID();
const root: Identity = { tenantId, externalUserId: "root" };

const WORKFLOWS = `
export const execInChat = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ exec: Record<string, unknown> }>) =>
        host["catamorphic.sessions"].exec(input.exec as never),
    }),
    defineBoundary({ run: ({ input }: BoundaryContext<unknown>) => input }),
  ],
}));
`;

/**
 * The workflow runtime, faked at the invocation: each boundary returns what
 * the real one would, so core's side runs for real.
 */
function invokeRuntime(invocation: {
  invocationId: string;
  stepIndex?: number;
  input: unknown;
}): Promise<RuntimeInvocationReceipt> {
  const input: unknown = invocation.input;
  const value =
    typeof input === "object" && input !== null && "value" in input
      ? input.value
      : undefined;
  const args =
    typeof value === "object" && value !== null && "exec" in value
      ? value.exec
      : undefined;
  return Promise.resolve({
    runtimeId: "fake-runtime",
    invocationId: invocation.invocationId,
    events: [],
    terminal: {
      status: "completed",
      result:
        invocation.stepIndex === 0
          ? {
              type: "host_call",
              transition: {
                __catamorphicDurableTransition: "host_call",
                capability: "catamorphic.sessions",
                fn: "exec",
                args,
              },
            }
          : { type: "completed", output: value ?? null },
      steps: [],
    },
  });
}

describe.skipIf(!connectionString)(
  "a parked command resumes a run placed on a worker node (ADRs 0289, 0324)",
  () => {
    let tmpDir: string;
    let core: CatamorphicCore;
    let db: ReturnType<typeof createDatabase>;
    let projectId: string;
    let lease: { id: string; token: string };
    let nodes: WorkerNodesService;
    let provider: LocalProcessSandboxProvider;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let renewing: Promise<void> = Promise.resolve();
    const binding: EnvironmentBinding = {
      id: crypto.randomUUID(),
      label: "One machine",
      trust: "local",
      isolation: "process",
      workloads: ["agent", "workflow"],
      agentTopologies: ["controller"],
      capabilities: [],
      resources: {},
    };

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-placed-"));
      provider = ownedSandboxes.track(
        new LocalProcessSandboxProvider({ root: path.join(tmpDir, "machine") }),
      );
      db = createDatabase({ connectionString, schema, poolSize: 8 });
      await migrateToLatest({ db, schema });
      // The machine every run and chat here is placed on: room for the
      // chat's workspace and one run's.
      nodes = new WorkerNodesService(db);
      lease = await nodes.register({
        tenantId,
        authorityId: "exec-placed-test",
        descriptor: binding,
        capacity: { workspaces: 2 },
      });
      renewal = setInterval(() => {
        renewing = renewing.then(async () => {
          await nodes.renew({ lease });
        });
      }, 10_000);
      const agent = {
        id: "worker",
        harness: {
          placement: "host" as const,
          adapter: new RecordingAdapter(),
        },
        topology: "controller" as const,
      };
      core = new CatamorphicCore({
        hostId: "exec-placed-test-host",
        db,
        projectManager: new ProjectManager(
          new FsBackend(path.join(tmpDir, "dev")),
          new FsRemoteBackend(path.join(tmpDir, "origin")),
        ),
        workerNode: lease,
        sandboxProvider: provider,
        environmentProvider: {
          get: async ({ allocationBindingId }) =>
            !allocationBindingId || allocationBindingId === binding.id
              ? {
                  descriptor: binding,
                  workerNodeId: lease.id,
                  sandboxProvider: provider,
                }
              : undefined,
        },
        credentialVault: new MemoryCredentialVault(),
        resolveMemberIdentity: async ({ tenantId, externalUserId }) => ({
          tenantId,
          externalUserId,
        }),
        codingAgent: {
          defaultAgentId: () => agent.id,
          get: (id) => (id === agent.id ? agent : undefined),
          list: () => [agent],
        },
      });
      // Workflow boundaries skip their runtime: the fake answers for them.
      vi.spyOn(core.runs, "invokeProductionRuntime").mockImplementation(
        (invocation) => invokeRuntime(invocation),
      );
      projectId = (await core.projects.create(root, { name: "Reviews" })).id;
      await core.projects.writeFile(
        root,
        projectId,
        ".work/workflows/src/exec.ts",
        { content: WORKFLOWS, commitMessage: "Write the workflow" },
      );
      const deployed = await core.deployment.deploy(
        tenantId,
        projectId,
        root.externalUserId,
        { message: "deploy" },
      );
      expect(deployed.status).toBe("deployed");
    }, 180_000);

    afterAll(async () => {
      clearInterval(renewal);
      await cleanupTestResources(
        [
          () => renewing,
          () => core?.runs.stopWorkers(),
          () => ownedSandboxes.cleanup(),
          () =>
            sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db),
          () => db.destroy(),
        ],
        () => fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 }),
      );
    });

    it("gives the run's Allocation back while the command runs, follows it in one claim, and resumes the run on a new one", async () => {
      if (!core.agentSessions) throw new Error("sessions not configured");
      const sessionId = (await core.agentSessions.create(root, projectId)).id;
      const run = await core.runs.triggerProduction({
        identity: root,
        projectId,
        workflowName: "execInChat",
        input: {
          exec: {
            sessionId,
            in: "session",
            idempotencyKey: "install",
            command: "sleep 12; echo installed",
          },
        },
      });
      if (!run.allocationId) throw new Error("The run has no Allocation");
      const parkedId = run.allocationId;
      const allocation = (allocationId: string) =>
        db
          .selectFrom("execution_allocations")
          .select([
            "status",
            "release_reason",
            "worker_node_id",
            "capacity_released_at",
          ])
          .where("id", "=", allocationId)
          .executeTakeFirstOrThrow();
      expect(await allocation(parkedId)).toMatchObject({
        status: "active",
        worker_node_id: lease.id,
      });
      // Little of the attempt is left: the command outlives it.
      await db
        .updateTable("workflow_step_attempts")
        .set({ started_at: new Date(Date.now() - 300_000 + 21_500) })
        .where("run_id", "=", run.id)
        .execute();
      // A lease shorter than the command: the follower has to renew it
      // after its run's Allocation was given back, or be fenced.
      core.runs.startWorker({
        kinds: ["durable_boundary", "host_call_wait"],
        concurrency: 2,
        pollIntervalMs: 5,
        leaseSeconds: 8,
      });
      const wait = () =>
        db
          .selectFrom("workflow_pauses")
          .select(["status", "wait_key"])
          .where("run_id", "=", run.id)
          .executeTakeFirst();
      const follower = () =>
        db
          .selectFrom("execution_jobs")
          .select(["status", "lease_generation", "lease_expiries"])
          .where("workflow_run_id", "=", run.id)
          .where("kind", "=", "host_call_wait")
          .executeTakeFirst()
          .then((job) =>
            job
              ? { ...job, lease_generation: Number(job.lease_generation) }
              : undefined,
          );

      // The step parks, and the run gives its Allocation back as idle.
      await expect
        .poll(async () => (await allocation(parkedId)).status, {
          timeout: 30_000,
          interval: 50,
        })
        .toBe("released");
      expect(await allocation(parkedId)).toMatchObject({
        release_reason: "idle",
      });
      expect(await wait()).toMatchObject({
        status: "open",
        wait_key: expect.stringMatching(/^session-exec:/),
      });
      // Its workspace and capacity come back while the command still runs.
      await expect
        .poll(
          async () => {
            await cleanupWorkerAllocations({ db, workerNode: lease, provider });
            return (await allocation(parkedId)).capacity_released_at;
          },
          { timeout: 5_000, interval: 100 },
        )
        .not.toBeNull();
      expect(await wait()).toMatchObject({ status: "open" });

      // The follower resumes the run, which is readmitted for its next step.
      await expect
        .poll(
          async () => {
            await cleanupWorkerAllocations({ db, workerNode: lease, provider });
            return (await core.runs.get({ identity: root, runId: run.id }))
              .status;
          },
          { timeout: 45_000, interval: 100 },
        )
        .toMatch(/completed|failed/);
      const done = await core.runs.get({ identity: root, runId: run.id });
      expect(done.status).toBe("completed");
      expect(done.result).toMatchObject({
        stdout: "installed\n",
        exitCode: 0,
        timedOut: false,
      });
      expect(await wait()).toMatchObject({ status: "resumed" });
      // One claim followed the command to its end: a lease that could not
      // be renewed would have been given up and taken again.
      await expect.poll(follower, { timeout: 5_000, interval: 50 }).toEqual({
        status: "completed",
        lease_generation: 1,
        lease_expiries: 0,
      });
      // The next step ran on a new Allocation; the parked one stayed idle.
      expect(done.allocationId).not.toBe(parkedId);
      expect(await allocation(parkedId)).toMatchObject({
        status: "released",
        release_reason: "idle",
      });
    }, 120_000);
  },
);
