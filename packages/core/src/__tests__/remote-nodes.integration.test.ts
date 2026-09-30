import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import type { EnvironmentBinding } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentTurnsService } from "../services/agent-turns-service.js";
import {
  claimAllocationMaintenance,
  releaseAllocationMaintenance,
} from "../services/allocation-sandbox-provider.js";
import {
  EXECUTOR_RESTARTED_ERROR,
  nodeExecutor,
  RemoteOperationQueue,
  RemoteReceiptRefusedError,
} from "../services/remote-operations.js";
import {
  RemoteEpochSupersededError,
  WorkerNodeLeaseHeldError,
  WorkerNodesService,
} from "../services/worker-nodes-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_remote_nodes";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const authorityId = "work:test";
const projectId = crypto.randomUUID();
const nodes = new WorkerNodesService(db);

/** A UUIDv7 epoch for a process started at `ms`. */
function epochAt(ms: number): string {
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function descriptor(id: string): EnvironmentBinding {
  return {
    id,
    label: id,
    trust: "managed",
    isolation: "process",
    workloads: ["agent"],
    agentTopologies: ["controller"],
    capabilities: ["network.egress"],
    resources: {},
  };
}

const offer = { workspaceRoot: "/workspace", processes: false };

async function connect(id: string, epoch: string) {
  return nodes.connectRemote({
    tenantId,
    authorityId,
    descriptor: descriptor(id),
    capacity: { workspaces: 2 },
    epoch,
    offer,
  });
}

async function lapse(id: string) {
  await db
    .updateTable("worker_nodes")
    .set({ lease_expires_at: sql`now() - interval '1 second'` })
    .where("id", "=", id)
    .execute();
}

describe("remote nodes own their lease (ADR 0192)", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  it("keeps a reconnecting epoch's work and fails a restarted one's as uncertain", async () => {
    const id = `worker.${crypto.randomUUID().slice(0, 8)}`;
    const first = epochAt(Date.now() - 1_000);
    expect((await connect(id, first)).superseded).toBeNull();
    const queue = new RemoteOperationQueue(db);
    const provider = nodes.remoteProvider({
      nodeId: id,
      offer,
      label: "The worker",
    });
    const poll = (epoch: string) =>
      queue.poll({
        executor: nodeExecutor(id),
        leaseToken: epoch,
        pollId: crypto.randomUUID(),
        waitMs: 5_000,
        leaseHeld: async () => true,
      });

    // The same epoch connecting again changes nothing in flight.
    const running = provider.executeCommand("sandbox-1", "sleep 1");
    const [taken] = await poll(first);
    expect((await connect(id, first)).superseded).toBeNull();
    await queue.complete({
      executor: nodeExecutor(id),
      leaseToken: first,
      operationId: taken?.id ?? "",
      response: { exitCode: 0, result: "" },
    });
    await expect(running).resolves.toEqual({ exitCode: 0, result: "" });

    // A restarted process takes over at once: the running operation fails
    // as uncertain, and its late receipt is refused.
    const interrupted = provider.executeCommand("sandbox-1", "sleep 2");
    const [inFlight] = await poll(first);
    const second = epochAt(Date.now());
    expect((await connect(id, second)).superseded).toBe(first);
    await expect(interrupted).rejects.toThrow(EXECUTOR_RESTARTED_ERROR);
    await expect(
      queue.complete({
        executor: nodeExecutor(id),
        leaseToken: first,
        operationId: inFlight?.id ?? "",
        response: { exitCode: 0, result: "" },
      }),
    ).rejects.toBeInstanceOf(RemoteReceiptRefusedError);
    // New operations go to the new epoch.
    const next = provider.executeCommand("sandbox-1", "true");
    const [delivered] = await poll(second);
    expect(delivered?.operation).toMatchObject({ command: "true" });
    await queue.complete({
      executor: nodeExecutor(id),
      leaseToken: second,
      operationId: delivered?.id ?? "",
      response: { exitCode: 0, result: "" },
    });
    await next;

    // The stale process cannot take the machine back while the new one
    // lives, and its renewals fail.
    await expect(connect(id, first)).rejects.toBeInstanceOf(
      RemoteEpochSupersededError,
    );
    expect(await nodes.renewRemote({ lease: { id, token: first } })).toBe(
      false,
    );
    // Its own calls renew the current epoch, even after a lapse.
    await lapse(id);
    expect(await nodes.liveToken({ nodeId: id })).toBeUndefined();
    await expect(provider.executeCommand("sandbox-1", "true")).rejects.toThrow(
      /not connected/,
    );
    expect(await nodes.renewRemote({ lease: { id, token: second } })).toBe(
      true,
    );
    expect(await nodes.liveToken({ nodeId: id })).toBe(second);
    // Once the current lease lapsed, any epoch may connect (a clock that
    // went back must not strand the machine).
    await lapse(id);
    const earlier = epochAt(Date.now() - 60_000);
    expect((await connect(id, earlier)).superseded).toBe(second);

    // A disabled node refuses every epoch.
    await nodes.setEnabled({
      tenantId,
      authorityId,
      nodeId: id,
      enabled: false,
    });
    await expect(connect(id, epochAt(Date.now()))).rejects.toBeInstanceOf(
      WorkerNodeLeaseHeldError,
    );
    expect(await nodes.renewRemote({ lease: { id, token: earlier } })).toBe(
      false,
    );
  });

  it("lets any host claim a remote node's turns only while its executor's lease is live", async () => {
    const turns = new AgentTurnsService(db);
    const remote = `worker.${crypto.randomUUID().slice(0, 8)}`;
    await connect(remote, epochAt(Date.now()));
    const local = await nodes.register({
      tenantId,
      authorityId,
      descriptor: descriptor(`node.${crypto.randomUUID()}`),
    });
    const otherLocal = await nodes.register({
      tenantId,
      authorityId,
      descriptor: descriptor(`node.${crypto.randomUUID()}`),
    });
    /** A chat whose workspace is on `nodeId` (or on none), with a turn. */
    const chatOn = async (nodeId: string | null) => {
      const sessionId = crypto.randomUUID();
      await db
        .insertInto("agent_sessions")
        .values({
          id: sessionId,
          project_id: projectId,
          external_user_id: "member",
          provider: "test",
        })
        .execute();
      const allocation = await db
        .insertInto("execution_allocations")
        .values({
          tenant_id: tenantId,
          project_id: projectId,
          environment_name: "default",
          binding_id: nodeId ?? "client:runner:token",
          workload_kind: "agent",
          root_workload_id: sessionId,
          worker_node_id: nodeId,
          policy_snapshot: JSON.stringify({}),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("agent_sessions")
        .set({ allocation_id: allocation.id })
        .where("id", "=", sessionId)
        .execute();
      await turns.deliver({
        sessionId,
        content: "Work",
        author: { kind: "user", externalUserId: "member" },
        mode: "next_turn",
      });
      return { sessionId, allocationId: allocation.id };
    };
    const claim = (sessionId: string) =>
      turns.claimNextForSession({
        workerId: "this-host",
        sessionId,
        localNode: local,
      });

    const onRemote = await chatOn(remote);
    const onNothing = await chatOn(null);
    const onMine = await chatOn(local.id);
    const onOther = await chatOn(otherLocal.id);
    expect(await claim(onOther.sessionId)).toBeNull();
    expect(await claim(onMine.sessionId)).not.toBeNull();
    expect(await claim(onNothing.sessionId)).not.toBeNull();

    // While the worker is away, its chats' turns wait.
    await lapse(remote);
    expect(await claim(onRemote.sessionId)).toBeNull();
    await db
      .updateTable("worker_nodes")
      .set({ lease_expires_at: sql`now() + interval '45 seconds'` })
      .where("id", "=", remote)
      .execute();
    // A host with no node of its own runs it as well as any other.
    expect(
      await turns.claimNextForSession({
        workerId: "another-host",
        sessionId: onRemote.sessionId,
      }),
    ).not.toBeNull();

    // A released workspace is admitted again before its turns run.
    const released = await chatOn(remote);
    await db
      .updateTable("execution_allocations")
      .set({
        status: "released",
        released_at: sql`now()`,
        release_reason: "idle",
      })
      .where("id", "=", released.allocationId)
      .execute();
    expect(await claim(released.sessionId)).toBeNull();
  });

  it("gives one host at a time an Allocation's maintenance", async () => {
    const sessionId = crypto.randomUUID();
    const allocation = await db
      .insertInto("execution_allocations")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "default",
        binding_id: "binding",
        workload_kind: "agent",
        root_workload_id: sessionId,
        policy_snapshot: JSON.stringify({}),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const args = { db, allocationId: allocation.id, status: "active" as const };
    expect(await claimAllocationMaintenance(args)).toBe(true);
    expect(await claimAllocationMaintenance(args)).toBe(false);
    await releaseAllocationMaintenance(args);
    expect(await claimAllocationMaintenance(args)).toBe(true);
    // A claim left by a host that stopped lapses on its own.
    await db
      .updateTable("execution_allocations")
      .set({ maintenance_claimed_until: sql`now() - interval '1 second'` })
      .where("id", "=", allocation.id)
      .execute();
    expect(await claimAllocationMaintenance(args)).toBe(true);
    expect(
      await claimAllocationMaintenance({ ...args, status: "released" }),
    ).toBe(false);
  });
});
