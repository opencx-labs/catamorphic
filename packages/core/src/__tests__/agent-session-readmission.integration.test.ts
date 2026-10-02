import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type {
  EnvironmentProvider,
  EnvironmentRuntimeBinding,
} from "@catamorphic/sandbox";
import { SANDBOX_CAPABILITIES } from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EVERY_ARTIFACT, type Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionActionsService } from "../services/session-actions-service.js";
import { RecordingAdapter } from "./recording-adapter.js";

/** A native agent recording whom each of its turns ran for. */
class Recorder {
  readonly startedFor: string[] = [];
  /** A turn told "Block" runs until this settles. */
  blocker: Promise<void> = Promise.resolve();
  running = false;
  readonly adapter = new RecordingAdapter({
    before: async (attempt) => {
      if (attempt.input?.text === "Block") {
        this.running = true;
        await this.blocker;
        this.running = false;
      }
    },
  });
}

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_readmission";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = "11111111-1111-4111-8111-111111111111";
const alice: Identity = { tenantId, externalUserId: "alice" };
const bob: Identity = { tenantId, externalUserId: "bob" };
const HOST = "readmission-host";

/** One machine that enforces egress policy and runs native agents. */
const binding: EnvironmentRuntimeBinding = {
  descriptor: {
    id: "machine",
    label: "Machine",
    trust: "local",
    isolation: "sandbox",
    workloads: ["agent"],
    agentTopologies: ["native"],
    capabilities: [SANDBOX_CAPABILITIES.egressPolicy],
    resources: {},
  },
};
const environmentProvider: EnvironmentProvider = { get: () => binding };

describe("chats admitted again after their workspace was released (ADR 0173)", () => {
  let tmpDir: string;
  let projectId: string;
  let projectManager: ProjectManager;
  const provider = new Recorder();
  const allocations = new ExecutionAllocationsService(db);
  /** Whom the host resolves; a person who left resolves to nobody. */
  const members = new Map<string, Identity>([["alice", alice]]);

  /** Every service made here, stopped before the database closes. */
  const services: AgentSessionsService[] = [];
  const service = (workerNode?: { id: string; token: string }) => {
    const agent = {
      id: "worker",
      harness: {
        placement: "host" as const,
        adapter: provider.adapter,
        local: (context: { caller?: { externalUserId: string } }) => {
          provider.startedFor.push(context.caller?.externalUserId ?? "");
          return {};
        },
      },
      topology: "native" as const,
    };
    const sessions = new AgentSessionsService(db, {
      hostId: HOST,
      ...(workerNode ? { workerNode } : {}),
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        environmentProvider,
      ),
      executionAllocations: allocations,
      codingAgents: {
        defaultAgentId: () => agent.id,
        get: (id) => (id === agent.id ? agent : undefined),
        list: () => [agent],
      },
      nativeAgentCheckout: {
        resolve: () => ({ path: tmpDir, owned: false }),
      },
    });
    services.push(sessions);
    return sessions;
  };
  const resolveIdentity = async (args: { externalUserId: string }) =>
    members.get(args.externalUserId) ?? null;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "readmission-"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(alice, { name: "Readmission" })).id;
    const repo = await projectManager.open(tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            review: {
              workloads: ["agent"],
              network: { egress: "allowlist", allow: ["github.com"] },
              approvals: { waitMinutes: 45 },
            },
          },
          defaultEnvironment: "review",
        }),
      );
      await repo.commit("Review Environment", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
  }, 60_000);

  afterAll(async () => {
    // A stopped worker leaves the drains it started running, as a host's
    // would: they settle before the database closes and the folder goes.
    await Promise.all(services.map((sessions) => sessions.stopLocalTurns()));
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** An idle chat of Alice's whose workspace was given back. */
  async function releasedChat(sessions: AgentSessionsService) {
    const chat = await sessions.create(alice, projectId);
    const allocationId = chat.allocationId ?? "";
    await allocations.release({
      identity: alice,
      allocationId,
      reason: "idle",
    });
    return { sessionId: chat.id, allocationId };
  }

  const policyOf = async (allocationId: string) =>
    (
      await db
        .selectFrom("execution_allocations")
        .select("policy_snapshot")
        .where("id", "=", allocationId)
        .executeTakeFirstOrThrow()
    ).policy_snapshot;

  const currentAllocation = async (sessionId: string) =>
    (
      await db
        .selectFrom("agent_sessions")
        .select("allocation_id")
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).allocation_id;

  it("keeps the Environment's egress and approval wait, and runs as the chat's owner", async () => {
    const sessions = service();
    const worker = sessions.startWorker({
      resolveIdentity,
      pollIntervalMs: 60_000,
    });
    try {
      const { sessionId, allocationId } = await releasedChat(sessions);
      const first = await policyOf(allocationId);
      expect(first).toMatchObject({
        sandbox: { egress: { mode: "allowlist" } },
        approvals: { waitMinutes: 45 },
      });
      provider.startedFor.length = 0;
      // Bob may write to everyone's chats; his message still runs as Alice.
      await sessions.command(bob, projectId, sessionId, {
        type: "send",
        commandId: randomUUID(),
        text: "Continue",
      });
      await vi.waitFor(
        async () => {
          const detail = await sessions.get(alice, projectId, sessionId);
          expect(detail.snapshot.turns.at(-1)?.status).toBe("completed");
        },
        { timeout: 10_000 },
      );
      expect(provider.startedFor).toEqual(["alice"]);
      const readmitted = await currentAllocation(sessionId);
      expect(readmitted).not.toBe(allocationId);
      expect(await policyOf(readmitted ?? "")).toMatchObject({
        sandbox: { egress: { mode: "allowlist" } },
        approvals: { waitMinutes: 45 },
      });
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("never runs a chat as whoever delivered to it when its owner is gone", async () => {
    const sessions = service();
    const worker = sessions.startWorker({
      resolveIdentity,
      pollIntervalMs: 60_000,
    });
    try {
      const { sessionId, allocationId } = await releasedChat(sessions);
      members.delete("alice");
      provider.startedFor.length = 0;
      await sessions.command(bob, projectId, sessionId, {
        type: "send",
        commandId: randomUUID(),
        text: "Continue",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(provider.startedFor).toEqual([]);
      expect(await currentAllocation(sessionId)).toBe(allocationId);
      const turns = await db
        .selectFrom("agent_turns")
        .select("status")
        .where("session_id", "=", sessionId)
        .execute();
      expect(turns.map((turn) => turn.status)).toEqual(["queued"]);
    } finally {
      members.set("alice", alice);
      await worker.stop();
    }
  }, 30_000);

  it("closing cancels work delivered while its running turn stopped", async () => {
    const sessions = service();
    const chat = await sessions.create(alice, projectId);
    let unblock = () => {};
    provider.blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    await sessions.command(alice, projectId, chat.id, {
      type: "send",
      commandId: randomUUID(),
      text: "Block",
    });
    await vi.waitFor(() => expect(provider.running).toBe(true));
    const closing = sessions.close(alice, projectId, chat.id);
    // While close waits for the running turn, more work arrives and is held.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const late = await sessions.deliver(alice, projectId, chat.id, {
      content: "Late",
      author: { kind: "user", externalUserId: "alice" },
      mode: "queue",
    });
    await sessions.command(alice, projectId, chat.id, {
      type: "edit_queued",
      commandId: randomUUID(),
      turnId: late.turnId ?? "",
      held: true,
    });
    unblock();
    await closing;
    const open = await db
      .selectFrom("agent_turns")
      .select(["id", "status"])
      .where("session_id", "=", chat.id)
      .where("status", "in", ["queued", "held"])
      .execute();
    expect(open).toEqual([]);
  }, 30_000);

  it("names a keyed chat only to those who may see it", async () => {
    const sessions = service();
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const chat = await sessions.chatForKey(alice, projectId, {
      key: "pr-9",
      workflowName: "reviewOnOpen",
    });
    // Mallory reaches the project's agents, not Alice's chats.
    const mallory: Identity = {
      tenantId,
      externalUserId: "mallory",
      scope: [{ kind: "agent", projectId, name: EVERY_ARTIFACT }],
    };
    const act = (operation: "find" | "inspect" | "close", args: unknown) =>
      actions.execute({
        identity: mallory,
        projectId,
        operation,
        args,
        author: { kind: "user", externalUserId: "mallory" },
      });
    const aliceKey = { key: "pr-9", audience: { member: "alice" } };
    const nobodys = { key: "pr-404", audience: { member: "alice" } };
    expect(await act("find", aliceKey)).toBeNull();
    expect(await act("find", nobodys)).toBeNull();
    await expect(act("inspect", aliceKey)).rejects.toThrow(
      "No open chat has the key pr-9",
    );
    expect(await act("close", { ...aliceKey, idempotencyKey: "m-1" })).toEqual({
      sessionId: null,
      closed: false,
    });
    expect((await sessions.get(alice, projectId, chat.sessionId)).status).toBe(
      "active",
    );
  });

  it("reports closing a closed chat as nothing closed, and a retried close finishes its cleanup", async () => {
    const sessions = service();
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const act = (args: unknown) =>
      actions.execute({
        identity: alice,
        projectId,
        operation: "close",
        args,
        author: { kind: "user", externalUserId: "alice" },
      });
    const done = await sessions.chatForKey(alice, projectId, {
      key: "pr-11",
      workflowName: "reviewOnOpen",
    });
    await sessions.close(alice, projectId, done.sessionId);
    expect(
      await act({ sessionId: done.sessionId, idempotencyKey: "late" }),
    ).toEqual({ sessionId: done.sessionId, closed: false });

    // A close that dies after closing the chat, before its cleanup.
    const chat = await sessions.chatForKey(alice, projectId, {
      key: "pr-12",
      workflowName: "reviewOnOpen",
    });
    await sessions.sendMessage(alice, projectId, chat.sessionId, "Hello");
    let sweeps = 0;
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 0 }),
      stop: async () => {
        sweeps += 1;
        if (sweeps === 2) throw new Error("host crashed");
      },
    });
    const merged = { key: "pr-12", idempotencyKey: "merged-12" };
    await expect(act(merged)).rejects.toThrow("host crashed");
    expect((await sessions.get(alice, projectId, chat.sessionId)).status).toBe(
      "closed",
    );
    // Retrying finishes it, though the key no longer names the chat.
    expect(await act(merged)).toEqual({
      sessionId: chat.sessionId,
      closed: true,
    });
    expect(sweeps).toBeGreaterThan(2);
  });

  it("admits a released chat again although the machine it left is gone", async () => {
    const creator = service();
    const { sessionId, allocationId } = await releasedChat(creator);
    // Its workspace was on a worker that has since left.
    await db
      .updateTable("execution_allocations")
      .set({ worker_node_id: "worker.gone" })
      .where("id", "=", allocationId)
      .execute();
    await creator.deliver(alice, projectId, sessionId, {
      content: "Continue",
      author: { kind: "user", externalUserId: "alice" },
      mode: "queue",
    });
    // A replica serving other machines picks it up on its poll.
    const replica = service({ id: "worker.here", token: crypto.randomUUID() });
    const worker = replica.startWorker({
      resolveIdentity,
      pollIntervalMs: 50,
    });
    try {
      await vi.waitFor(
        async () =>
          expect(await currentAllocation(sessionId)).not.toBe(allocationId),
        { timeout: 10_000 },
      );
    } finally {
      await worker.stop();
    }
  }, 30_000);
});
