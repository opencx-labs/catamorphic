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
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import {
  ExecutionEnvironmentsService,
  NoCompatibleEnvironmentError,
} from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { EnvironmentCapacityError } from "../services/worker-capacity.js";
import { RecordingAdapter } from "./recording-adapter.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_placement_waits";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = "11111111-1111-4111-8111-111111111111";
const alice: Identity = { tenantId, externalUserId: "alice" };

const binding: EnvironmentRuntimeBinding = {
  descriptor: {
    id: "machine",
    label: "Machine",
    trust: "local",
    isolation: "sandbox",
    workloads: ["agent"],
    agentTopologies: ["native"],
    capabilities: ["review.tools"],
    resources: {},
  },
};

/** The deployment's machines: one with room, all full, or none online. */
const machines = { state: "free" as "free" | "full" | "none" };
const environmentProvider: EnvironmentProvider = {
  get: () => {
    if (machines.state === "full")
      throw new EnvironmentCapacityError("worker.review-1");
    return machines.state === "none" ? undefined : binding;
  },
};

/**
 * Work waits for a machine (ADR 0258): a chat no machine can take yet
 * waits where its Environment lets it, is admitted once one has room, and
 * its turn fails once it waited as long as it may.
 */
describe("chats waiting for a machine (ADR 0258)", () => {
  let tmpDir: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let worker: { stop(): Promise<void> };
  const adapter = new RecordingAdapter();
  const allocations = new ExecutionAllocationsService(db);

  const waitOf = (sessionId: string) =>
    db
      .selectFrom("placement_waits")
      .selectAll()
      .where("root_workload_id", "=", sessionId)
      .executeTakeFirst();
  const allocationOf = async (sessionId: string) =>
    (
      await db
        .selectFrom("agent_sessions")
        .select("allocation_id")
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow()
    ).allocation_id;
  const turnsOf = (sessionId: string) =>
    db
      .selectFrom("agent_turns")
      .select(["status", "error"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal")
      .execute();
  /** Its backoff over: the worker tries it at its next poll. */
  const retryNow = (sessionId: string) =>
    db
      .updateTable("placement_waits")
      .set({ retry_at: sql`now()` })
      .where("root_workload_id", "=", sessionId)
      .execute();
  const send = (identity: Identity, sessionId: string, content: string) =>
    sessions.deliver(identity, projectId, sessionId, {
      content,
      author: { kind: "user", externalUserId: "alice" },
      mode: "queue",
    });

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "placement-waits-"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(alice, { name: "Reviews" })).id;
    const repo = await projectManager.open(tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            default: { workloads: ["agent"] },
            review: {
              workloads: ["agent"],
              pool: { pool: "review" },
              requirements: { capabilities: ["review.tools"] },
              waitMinutes: 30,
            },
          },
          defaultEnvironment: "default",
        }),
      );
      await repo.commit("Review Environment", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
    const agent = {
      id: "reviewer",
      harness: { placement: "host" as const, adapter, local: () => ({}) },
      topology: "native" as const,
    };
    sessions = new AgentSessionsService(db, {
      hostId: "placement-waits-host",
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
      nativeAgentCheckout: { resolve: () => ({ path: tmpDir, owned: false }) },
    });
    worker = sessions.startWorker({
      resolveIdentity: async (args) =>
        args.externalUserId === "alice"
          ? alice
          : projectChatIdentity({ tenantId, projectId }),
      pollIntervalMs: 50,
    });
  }, 60_000);

  afterAll(async () => {
    await worker?.stop();
    await sessions?.stopLocalTurns();
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("starts a project chat without a machine, and runs it once one has room", async () => {
    machines.state = "full";
    const project = projectChatIdentity({ tenantId, projectId });
    const chat = await sessions.chatForKey(project, projectId, {
      key: "pr-1",
      environment: "review",
    });
    expect(chat.sessionCreated).toBe(true);
    expect(await allocationOf(chat.sessionId)).toBeNull();
    // What a host scaling machines with demand reads.
    expect(await waitOf(chat.sessionId)).toMatchObject({
      project_id: projectId,
      workload_kind: "agent",
      environment_name: "review",
      pool: { pool: "review" },
      owner: null,
      requirements: { resources: {}, capabilities: ["review.tools"] },
      reason: "capacity",
    });
    await send(project, chat.sessionId, "Review it");
    await retryNow(chat.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await turnsOf(chat.sessionId)).map((turn) => turn.status)).toEqual([
      "queued",
    ]);
    // Tried again, it still waits, and backs off.
    const tried = await waitOf(chat.sessionId);
    expect(tried?.retry_at.getTime()).toBeGreaterThan(Date.now());

    machines.state = "free";
    await retryNow(chat.sessionId);
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(chat.sessionId)).map((turn) => turn.status),
        ).toEqual(["completed"]),
      { timeout: 10_000 },
    );
    expect(await allocationOf(chat.sessionId)).not.toBeNull();
    expect(await waitOf(chat.sessionId)).toBeUndefined();
  }, 30_000);

  it("fails a new chat at once in an Environment that does not let work wait", async () => {
    machines.state = "full";
    await expect(
      sessions.chatForKey(alice, projectId, { key: "pr-2" }),
    ).rejects.toBeInstanceOf(NoCompatibleEnvironmentError);
    await expect(
      sessions.chatForKey(alice, projectId, {
        key: "pr-2",
        environment: "default",
      }),
    ).rejects.toBeInstanceOf(EnvironmentCapacityError);
    expect(
      await db
        .selectFrom("agent_sessions")
        .select("id")
        .where("chat_key", "=", "pr-2")
        .execute(),
    ).toEqual([]);
  });

  it("fails the turn once the chat waited as long as its Environment allows", async () => {
    machines.state = "none";
    const chat = await sessions.chatForKey(alice, projectId, {
      key: "pr-3",
      environment: "review",
    });
    expect(await waitOf(chat.sessionId)).toMatchObject({
      owner: "alice",
      reason: "unavailable",
    });
    const limit = await waitOf(chat.sessionId);
    expect(
      (limit?.expires_at?.getTime() ?? 0) -
        (limit?.waiting_since.getTime() ?? 0),
    ).toBe(30 * 60_000);
    await send(alice, chat.sessionId, "First");
    await send(alice, chat.sessionId, "Second");
    await db
      .updateTable("placement_waits")
      .set({
        waiting_since: sql`now() - interval '31 minutes'`,
        expires_at: sql`now() - interval '1 minute'`,
        retry_at: sql`now()`,
      })
      .where("root_workload_id", "=", chat.sessionId)
      .execute();
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(chat.sessionId)).map((turn) => turn.status),
        ).toEqual(["failed", "failed"]),
      { timeout: 10_000 },
    );
    const [turn] = await turnsOf(chat.sessionId);
    expect(JSON.stringify(turn?.error)).toContain(
      "No machine for Environment 'review' came online for this chat within 30 minutes",
    );
    // Nothing of it is queued, so nothing of it waits.
    await vi.waitFor(async () =>
      expect(await waitOf(chat.sessionId)).toBeUndefined(),
    );
    expect(
      adapter.attempts.some((attempt) => attempt.sessionId === chat.sessionId),
    ).toBe(false);

    // The next message waits again, from now.
    await send(alice, chat.sessionId, "Third");
    await vi.waitFor(async () =>
      expect(await waitOf(chat.sessionId)).toMatchObject({
        reason: "unavailable",
      }),
    );
    const again = await waitOf(chat.sessionId);
    expect(again?.waiting_since.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await sessions.close(alice, projectId, chat.sessionId);
    expect(await waitOf(chat.sessionId)).toBeUndefined();
  }, 30_000);

  it("keeps a chat whose workspace was given back waiting, and fails it after the wait", async () => {
    machines.state = "free";
    const chat = await sessions.chatForKey(alice, projectId, {
      key: "pr-4",
      environment: "review",
    });
    const allocationId = (await allocationOf(chat.sessionId)) ?? "";
    await allocations.release({
      identity: alice,
      allocationId,
      reason: "idle",
    });
    machines.state = "full";
    await send(alice, chat.sessionId, "Again");
    await vi.waitFor(async () =>
      expect(await waitOf(chat.sessionId)).toMatchObject({
        reason: "capacity",
        environment_name: "review",
      }),
    );
    expect(await allocationOf(chat.sessionId)).toBe(allocationId);
    await db
      .updateTable("placement_waits")
      .set({ expires_at: sql`now()`, retry_at: sql`now()` })
      .where("root_workload_id", "=", chat.sessionId)
      .execute();
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(chat.sessionId)).map((turn) => turn.status),
        ).toEqual(["failed"]),
      { timeout: 10_000 },
    );
    const [turn] = await turnsOf(chat.sessionId);
    expect(JSON.stringify(turn?.error)).toContain("had room for this chat");
  }, 30_000);

  it("keeps a released chat in an Environment without a wait limit waiting as long as it is queued", async () => {
    machines.state = "free";
    const chat = await sessions.create(alice, projectId);
    await allocations.release({
      identity: alice,
      allocationId: chat.allocationId ?? "",
      reason: "idle",
    });
    machines.state = "full";
    await send(alice, chat.id, "Later");
    await vi.waitFor(async () =>
      expect(await waitOf(chat.id)).toMatchObject({
        environment_name: "default",
        expires_at: null,
      }),
    );
    machines.state = "free";
    await retryNow(chat.id);
    await vi.waitFor(
      async () =>
        expect((await turnsOf(chat.id)).map((turn) => turn.status)).toEqual([
          "completed",
        ]),
      { timeout: 10_000 },
    );
    expect(await waitOf(chat.id)).toBeUndefined();
  }, 30_000);
});
