import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ExecutionAllocationsService,
  ExecutionJobsService,
  type Identity,
  PlacementWaitsService,
  WorkerNodesService,
} from "@catamorphic/core";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { workAuthorityId } from "../cluster.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { createTestDatabase, testServerOptions } from "../test-support.js";
import { MachineStore } from "./machine-store.js";

const PUBLIC = "https://demand.example.test";

/**
 * What a parked run asks of machines (ADRs 0258, 0289, 0324): one only once
 * compute is due. A pause timeout and a host call's follower need no
 * placement, so any replica runs them with no machine: a run waiting on
 * either must not start or keep one.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "a parked run is demand for a machine once compute is due, never for a job that needs no placement",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-demand-"));
    const database = await createTestDatabase("work_demand");
    let server: WorkServer | undefined;
    try {
      server = await createWorkServer(
        testServerOptions({
          dataDir: path.join(dir, "control-plane"),
          publicBases: [PUBLIC],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: "demand-test-secret-with-at-least-32-characters",
            WORK_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
            WORK_OPERATOR_SECRET: "demand-operator-secret-shared-by-replicas",
            WORK_CONTROL_PLANE_WORKLOADS: "workflow",
            WORK_FAKE_AGENT: "1",
            PATH: process.env.PATH,
          },
        }),
      );
      const { core } = server.catamorphic;
      const db = core.db;
      // The queue is what this reads: the server's own workers must not
      // claim the jobs placed in it.
      await core.runs.stopWorkers();
      const owner: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: "demand-test",
      };
      const project = await core.projects.create(owner, { name: "Demand" });
      const machines = new MachineStore({
        db,
        nodes: new WorkerNodesService(db),
        tenantId: SERVER_TENANT_ID,
        authorityId: workAuthorityId(PUBLIC),
        enrollmentSecret: randomBytes(32).toString("base64url"),
      });

      // A run parked on a wait: its Allocation was given back as idle.
      const runId = randomUUID();
      const allocation = await new ExecutionAllocationsService(db).create({
        identity: owner,
        projectId: project.id,
        environmentName: "default",
        workloadKind: "workflow",
        rootWorkloadId: runId,
        policy: {
          binding: {
            id: "demand",
            label: "Demand",
            trust: "managed",
            isolation: "process",
            workloads: ["workflow"],
            agentTopologies: [],
            capabilities: [],
            resources: {},
          },
          requirements: { workload: "workflow" },
        },
      });
      await db
        .updateTable("execution_allocations")
        .set({
          status: "released",
          release_reason: "idle",
          released_at: sql`now()`,
          capacity_released_at: sql`now()`,
        })
        .where("id", "=", allocation.id)
        .execute();
      await db
        .insertInto("workflow_runs")
        .values({
          id: runId,
          project_id: project.id,
          workflow_name: "prepare",
          provenance: {},
          status: "waiting",
          allocation_id: allocation.id,
          external_user_id: owner.externalUserId,
        })
        .execute();
      // It asked for a machine a moment ago, as a continuation does.
      await new PlacementWaitsService(db).record({
        tenantId: SERVER_TENANT_ID,
        projectId: project.id,
        workloadKind: "workflow",
        rootWorkloadId: runId,
        target: {
          environmentName: "default",
          reason: "capacity",
          pool: {},
          owner: null,
          key: null,
          requirements: { resources: {}, capabilities: [] },
          waitMinutes: 10,
        },
        limitMinutes: null,
      });
      const waiting = async () =>
        (await machines.work()).filter((work) => work.id === runId);

      const jobs = new ExecutionJobsService(db);
      const queued = async (
        kind: "durable_pause_timeout" | "host_call_wait" | "durable_boundary",
      ) => {
        const job = await jobs.enqueue({
          tenantId: SERVER_TENANT_ID,
          workflowRunId: runId,
          kind,
          payload: {},
        });
        expect(job.status).toBe("pending");
      };

      // Due, and still no reason for a machine: neither needs one.
      await queued("host_call_wait");
      expect(await waiting()).toEqual([]);
      await queued("durable_pause_timeout");
      expect(await waiting()).toEqual([]);
      const quiet = await machines.signature();

      // The wait ended and the next boundary is due: that needs a machine.
      await queued("durable_boundary");
      expect(await waiting()).toMatchObject([
        {
          id: runId,
          kind: "run",
          project: project.id,
          environment: "default",
          reason: "capacity",
        },
      ]);
      expect(await machines.signature()).not.toBe(quiet);
    } finally {
      await server?.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  120_000,
);
