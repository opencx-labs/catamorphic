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
 * A machine is taken out of service only while nothing holds it (ADR
 * 0258): the drain and a new Allocation take the same node row lock, so on
 * real Postgres one waits for the other and neither misses the other.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "never revokes a machine an Allocation is landing on, and places nothing on a drained one",
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
        placement: { access: { projects: [project.id] } },
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
        },
        requirements: { workload: "agent" },
      };
      const allocate = (
        transaction?: Parameters<
          ExecutionAllocationsService["create"]
        >[0]["transaction"],
      ) =>
        allocations.create({
          identity: owner,
          projectId: project.id,
          environmentName: "review",
          workloadKind: "agent",
          rootWorkloadId: randomUUID(),
          workerNodeId: nodeId,
          policy,
          ...(transaction ? { transaction } : {}),
        });

      // An Allocation is being made on the machine, its transaction still
      // open, when the reconciler drains it: the drain waits for it, then
      // sees it and keeps the machine.
      let commit = () => {};
      const committing = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let made = () => {};
      const madeOne = new Promise<void>((resolve) => {
        made = resolve;
      });
      const landing = db.transaction().execute(async (trx) => {
        const allocation = await allocate(trx);
        made();
        await committing;
        return allocation;
      });
      await madeOne;
      let settled = false;
      const drain = registry.drain({ name: "racer" }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      commit();
      const allocation = await landing;
      expect(await drain).toBe(false);
      expect(await registry.connected({ name: "racer" })).toBe(true);

      // Its work done, the machine is drained, and nothing lands on it.
      await sql`
        UPDATE execution_allocations
        SET status = 'released', released_at = now(), capacity_released_at = now()
        WHERE id = ${allocation.id}
      `.execute(db);
      expect(await registry.drain({ name: "racer" })).toBe(true);
      await expect(allocate()).rejects.toBeInstanceOf(EnvironmentCapacityError);
      expect(await registry.connected({ name: "racer" })).toBe(false);
      expect(
        (await registry.list()).find((worker) => worker.name === "racer"),
      ).toMatchObject({ revoked: true });
    } finally {
      await server?.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  120_000,
);
