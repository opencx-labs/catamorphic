import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type EnvironmentAllocationPolicy,
  EnvironmentCapacityError,
  ExecutionAllocationsService,
  type Identity,
  WorkerNodesService,
} from "@catamorphic/core";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { workAuthorityId } from "../cluster.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { createTestDatabase, testServerOptions } from "../test-support.js";
import { WorkerOfferSchema, WorkWorkerRegistry } from "./worker-registry.js";

const PUBLIC = "https://drain.example.test";

/** A worker process's epoch: a UUIDv7 (ADR 0192). */
function epoch(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(6) & 0x0f) | 0x70) >>> 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(8) & 0x3f) | 0x80) >>> 0, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A machine is stopped or taken out of service only while nothing holds it
 * (ADRs 0258, 0349, 0350): those and a new Allocation take the same node
 * row lock, so on real Postgres one waits for the other and neither misses
 * the other.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "never stops or retires a machine an Allocation is landing on, and places nothing on one that went",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-drain-"));
    const database = await createTestDatabase("work_drain");
    let server: WorkServer | undefined;
    try {
      server = await createWorkServer(
        testServerOptions({
          dataDir: path.join(dir, "control-plane"),
          publicBases: [PUBLIC],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: "drain-test-secret-with-at-least-32-characters",
            WORK_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
            WORK_OPERATOR_SECRET: "drain-operator-secret-shared-by-replicas",
            WORK_CONTROL_PLANE_WORKLOADS: "workflow",
            WORK_FAKE_AGENT: "1",
            PATH: process.env.PATH,
          },
        }),
      );
      const db = server.catamorphic.core.db;
      const owner: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: "drain-test",
      };
      const project = await server.catamorphic.core.projects.create(owner, {
        name: "Drain",
      });
      const registry = new WorkWorkerRegistry({
        db,
        nodes: new WorkerNodesService(db),
        tenantId: SERVER_TENANT_ID,
        authorityId: workAuthorityId(PUBLIC),
      });
      const keys = generateExecutorKeyPair();
      const enrollment = await registry.createEnrollment({
        name: "racer",
        placement: { for: [{ project: project.id }] },
      });
      const { nodeId } = await registry.enroll({
        code: enrollment.code,
        publicKey: keys.publicKey,
      });
      await registry.connect({
        nodeId,
        name: "racer",
        session: epoch(),
        offer: WorkerOfferSchema.parse({
          isolation: "process",
          workspaceRoot: "/workspaces",
          capacity: { workspaces: 2 },
        }),
        publicKey: keys.publicKey,
      });
      const allocations = new ExecutionAllocationsService(db);
      const placementRevision = async () => {
        const revision = (await registry.placements()).get(
          nodeId,
        )?.admissionRevision;
        if (!revision) throw new Error("The worker has no placement revision");
        return revision;
      };
      const previousRevision = await placementRevision();
      const policy: EnvironmentAllocationPolicy = {
        binding: {
          id: nodeId,
          label: "racer",
          trust: "managed",
          isolation: "process",
          workloads: ["agent"],
          agentTopologies: ["controller"],
          capabilities: [],
          resources: {},
          admissionRevision: previousRevision,
        },
        requirements: { workload: "agent" },
      };
      const allocate = (
        transaction?: Parameters<
          ExecutionAllocationsService["create"]
        >[0]["transaction"],
        admissionRevision = previousRevision,
      ) =>
        allocations.create({
          identity: owner,
          projectId: project.id,
          environmentName: "review",
          workloadKind: "agent",
          rootWorkloadId: randomUUID(),
          workerNodeId: nodeId,
          policy: {
            ...policy,
            binding: { ...policy.binding, admissionRevision },
          },
          ...(transaction ? { transaction } : {}),
        });

      // A scheduled choice under the old principals cannot land while the
      // disk is being reset or after the next principals can place work.
      await registry.machines.beginReset({
        name: "racer",
        for: [{ user: owner.externalUserId }],
      });
      expect(await registry.connected({ name: "racer" })).toBe(true);
      await expect(allocate()).rejects.toBeInstanceOf(EnvironmentCapacityError);
      await registry.machines.finishReset({ name: "racer" });
      const revision = await placementRevision();
      expect(revision).not.toBe(previousRevision);
      await expect(allocate()).rejects.toBeInstanceOf(EnvironmentCapacityError);

      // An Allocation is being made on the machine, its transaction still
      // open, when the sequencer retires it: the retirement waits for it,
      // then sees it and keeps the machine.
      let commit = () => {};
      const committing = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let made = () => {};
      const madeOne = new Promise<void>((resolve) => {
        made = resolve;
      });
      const landing = db.transaction().execute(async (trx) => {
        const allocation = await allocate(trx, revision);
        made();
        await committing;
        return allocation;
      });
      await madeOne;
      let settled = false;
      const drain = registry.retireMachine({ name: "racer" }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      commit();
      const allocation = await landing;
      expect(await drain).toBe(false);
      // Stopping is refused the same way: it holds a live workspace.
      expect(await registry.beginStop({ name: "racer" })).toBe(false);
      expect(await registry.connected({ name: "racer" })).toBe(true);
      expect(
        (await registry.list()).find((worker) => worker.name === "racer"),
      ).toMatchObject({ state: "serving", holding: { workspaces: 1 } });

      // Its lease lapses (a restart, a network blip) with the workspace
      // still on it: one reading is not enough to give the workspace up.
      await sql`
        UPDATE worker_nodes SET lease_expires_at = now() - interval '1 second'
        WHERE id = ${nodeId}
      `.execute(db);
      expect(await registry.retireMachine({ name: "racer" })).toBe(false);
      expect(
        await registry.declareLost({
          name: "racer",
          unseenForMs: 15 * 60_000,
        }),
      ).toBe(false);
      expect(
        (await registry.list()).find((worker) => worker.name === "racer"),
      ).toMatchObject({ state: "unreachable" });
      // Unseen for longer than its limit, it is lost: taken out of service
      // though it holds the workspace, and nothing lands on it any more.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        await registry.declareLost({ name: "racer", unseenForMs: 10 }),
      ).toBe(true);
      expect(allocation.workerNodeId).toBe(nodeId);
      await expect(allocate()).rejects.toBeInstanceOf(EnvironmentCapacityError);
      expect(await registry.connected({ name: "racer" })).toBe(false);
      expect(
        (await registry.list()).find((worker) => worker.name === "racer"),
      ).toMatchObject({ state: "destroying", holding: { workspaces: 0 } });
    } finally {
      await server?.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  120_000,
);
