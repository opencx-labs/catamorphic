import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import {
  type EnvironmentBinding,
  generateExecutorKeyPair,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AllocationMaintenanceLostError,
  claimAllocationMaintenance,
  releaseAllocationMaintenance,
  renewAllocationMaintenance,
  withAllocationMaintenance,
} from "../services/allocation-sandbox-provider.js";
import {
  EXECUTOR_RESTARTED_ERROR,
  ExecutorKeyMissingError,
  nodeExecutor,
  openRemoteOperation,
  RemoteOperationQueue,
  RemoteReceiptRefusedError,
  registerExecutorKey,
} from "../services/remote-operations.js";
import {
  RemoteEpochSupersededError,
  WorkerNodeLeaseHeldError,
  WorkerNodesService,
} from "../services/worker-nodes-service.js";
import { sessionLogFixture } from "./session-fixtures.js";

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
/** Every executor here seals to the same key (ADR 0206). */
const KEYS = generateExecutorKeyPair();

async function connect(id: string, epoch: string) {
  await registerExecutorKey({
    db,
    executor: nodeExecutor(id),
    publicKey: KEYS.publicKey,
  });
  return connectWithoutKey(id, epoch);
}

function connectWithoutKey(id: string, epoch: string) {
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

/** A chat whose workspace is on `nodeId` (or on none), with a queued turn. */
async function chatOn(
  nodeId: string | null,
  bindingId = nodeId ?? "host-binding",
): Promise<{ sessionId: string; allocationId: string }> {
  const sessionId = crypto.randomUUID();
  await db
    .insertInto("agent_sessions")
    .values({
      id: sessionId,
      project_id: projectId,
      external_user_id: "member",
    })
    .execute();
  const allocation = await db
    .insertInto("execution_allocations")
    .values({
      tenant_id: tenantId,
      project_id: projectId,
      environment_name: "default",
      binding_id: bindingId,
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
  await sessionLogFixture(db).queueTurn({ sessionId, text: "Work" });
  return { sessionId, allocationId: allocation.id };
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
    expect(
      openRemoteOperation({
        operationId: delivered?.id ?? "",
        executor: nodeExecutor(id),
        envelope: delivered?.operation,
        privateKeys: [KEYS.privateKey],
      }),
    ).toMatchObject({ command: "true" });
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
    expect(
      (await nodes.renewRemote({ lease: { id, token: first } })).held,
    ).toBe(false);
    // Its own calls renew the current epoch, even after a lapse.
    await lapse(id);
    expect(await nodes.liveToken({ nodeId: id })).toBeUndefined();
    await expect(provider.executeCommand("sandbox-1", "true")).rejects.toThrow(
      /not connected/,
    );
    expect(await nodes.renewRemote({ lease: { id, token: second } })).toEqual({
      held: true,
      extended: true,
    });
    expect(await nodes.liveToken({ nodeId: id })).toBe(second);
    // A fresh lease is only read: frequent calls write the row once.
    expect(await nodes.renewRemote({ lease: { id, token: second } })).toEqual({
      held: true,
      extended: false,
    });
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
    expect(
      (await nodes.renewRemote({ lease: { id, token: earlier } })).held,
    ).toBe(false);
  });

  it("lets any host claim a remote node's turns only while its executor's lease is live", async () => {
    const turns = sessionLogFixture(db);
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
    const claim = (sessionId: string) =>
      turns.queue.claim({
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
      await turns.queue.claim({
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

  it("refuses a remote executor that registered no key (ADR 0206)", async () => {
    const id = `worker.${crypto.randomUUID().slice(0, 8)}`;
    await expect(
      connectWithoutKey(id, epochAt(Date.now())),
    ).rejects.toBeInstanceOf(ExecutorKeyMissingError);
    expect(await nodes.liveToken({ nodeId: id })).toBeUndefined();
  });

  it("takes over a lease an executor held before it had epochs", async () => {
    // A worker node from before epochs: a random (v4) token, no offer.
    const id = `worker.${crypto.randomUUID().slice(0, 8)}`;
    const legacy = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await nodes.register({ tenantId, authorityId, descriptor: descriptor(id) });
    await db
      .updateTable("worker_nodes")
      .set({ lease_token: legacy })
      .where("id", "=", id)
      .execute();
    // Its first epoch sorts before the old token, and still takes over.
    expect((await connect(id, epochAt(Date.now()))).superseded).toBe(legacy);
  });

  it("keeps a workspace's turns waiting while a host saves it, and never saves a busy one", async () => {
    const turns = sessionLogFixture(db);
    const remote = `worker.${crypto.randomUUID().slice(0, 8)}`;
    await connect(remote, epochAt(Date.now()));
    const chat = await chatOn(remote);
    const claimTurn = () =>
      turns.queue.claim({
        workerId: "host",
        sessionId: chat.sessionId,
      });
    const claimIdle = () =>
      claimAllocationMaintenance({
        db,
        allocationId: chat.allocationId,
        status: "active",
        sessionId: chat.sessionId,
      });

    // A chat with a queued turn is not idle.
    expect(await claimIdle()).toBeUndefined();
    const running = await claimTurn();
    if (!running?.leaseToken) throw new Error("Expected a turn");
    expect(await claimIdle()).toBeUndefined();
    await turns.complete(running.turn);

    // Idle: one host takes the claim, and a turn arriving meanwhile waits.
    const claim = await claimIdle();
    if (!claim) throw new Error("Expected a claim");
    expect(await claimIdle()).toBeUndefined();
    await turns.queueTurn({ sessionId: chat.sessionId, text: "More work" });
    expect(await claimTurn()).toBeNull();

    // Only its holder renews or gives it back.
    const stranger = {
      allocationId: chat.allocationId,
      token: crypto.randomUUID(),
    };
    expect(await renewAllocationMaintenance({ db, claim: stranger })).toBe(
      false,
    );
    await releaseAllocationMaintenance({ db, claim: stranger });
    expect(await claimTurn()).toBeNull();
    expect(await renewAllocationMaintenance({ db, claim })).toBe(true);
    await releaseAllocationMaintenance({ db, claim });
    expect(await claimTurn()).not.toBeNull();
  });

  it("stops maintenance whose claim was lost, and leaves the new holder's claim alone", async () => {
    const chat = await chatOn(null);
    await db
      .deleteFrom("agent_turns")
      .where("session_id", "=", chat.sessionId)
      .execute();
    const claim = await claimAllocationMaintenance({
      db,
      allocationId: chat.allocationId,
      status: "active",
      sessionId: chat.sessionId,
    });
    if (!claim) throw new Error("Expected a claim");
    const steps: string[] = [];
    await expect(
      withAllocationMaintenance({
        db,
        claim,
        work: async (held) => {
          await held();
          steps.push("saved");
          // The host stalled; its claim lapsed and another host took it.
          await db
            .updateTable("execution_allocations")
            .set({ maintenance_claim: crypto.randomUUID() })
            .where("id", "=", chat.allocationId)
            .execute();
          await held();
          steps.push("released");
        },
      }),
    ).rejects.toBeInstanceOf(AllocationMaintenanceLostError);
    expect(steps).toEqual(["saved"]);
    const row = await db
      .selectFrom("execution_allocations")
      .select(["maintenance_claim", "maintenance_claimed_until"])
      .where("id", "=", chat.allocationId)
      .executeTakeFirstOrThrow();
    expect(row.maintenance_claim).not.toBe(claim.token);
    expect(row.maintenance_claimed_until).not.toBeNull();
  });

  it("gives up a claim left by a host that stopped", async () => {
    const chat = await chatOn(null);
    await db
      .deleteFrom("agent_turns")
      .where("session_id", "=", chat.sessionId)
      .execute();
    const args = {
      db,
      allocationId: chat.allocationId,
      status: "active" as const,
      sessionId: chat.sessionId,
    };
    const first = await claimAllocationMaintenance(args);
    expect(first).toBeDefined();
    await db
      .updateTable("execution_allocations")
      .set({ maintenance_claimed_until: sql`now() - interval '1 second'` })
      .where("id", "=", chat.allocationId)
      .execute();
    const second = await claimAllocationMaintenance(args);
    expect(second?.token).not.toBe(first?.token);
    // The stopped host's late release does not free the new holder's claim.
    if (first) await releaseAllocationMaintenance({ db, claim: first });
    expect(await claimAllocationMaintenance(args)).toBeUndefined();
    expect(
      await claimAllocationMaintenance({ ...args, status: "released" }),
    ).toBeUndefined();
  });

  it("keeps a member's machine's turns queued while its runner is away", async () => {
    const turns = sessionLogFixture(db);
    const runnerId = crypto.randomUUID();
    const token = crypto.randomUUID();
    await db
      .insertInto("client_runners")
      .values({
        id: runnerId,
        tenant_id: tenantId,
        project_id: projectId,
        external_user_id: "member",
        environment_name: "laptop",
        label: "Laptop",
        workspace_root: "/workspace",
        lease_token: token,
        lease_expires_at: sql<Date>`now() - interval '1 second'`,
      })
      .execute();
    const chat = await chatOn(null, `client:${runnerId}:${token}`);
    const claim = () =>
      turns.queue.claim({
        workerId: "host",
        sessionId: chat.sessionId,
      });
    expect(await claim()).toBeNull();
    await db
      .updateTable("client_runners")
      .set({ lease_expires_at: sql<Date>`now() + interval '45 seconds'` })
      .where("id", "=", runnerId)
      .execute();
    expect(await claim()).not.toBeNull();
  });
});
