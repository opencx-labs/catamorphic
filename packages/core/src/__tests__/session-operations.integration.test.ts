import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EchoAdapter } from "@catamorphic/agent-runner";
import { type DB, type Json, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { EVERY_ARTIFACT, type Identity } from "../identity.js";
import {
  AgentSessionsService,
  type AgentTurnSettledEvent,
} from "../services/agent-sessions-service.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import {
  parseWaitCursor,
  SESSION_OPERATIONS,
  type SessionOperationName,
  SessionOperationsService,
  sessionOperationError,
  sessionOperationHostName,
} from "../services/session-operations.js";
import {
  type SessionState,
  SessionStateSchema,
} from "../services/session-state.js";
import type { ChangedPaths } from "../services/sessions/changed-paths.js";
import { requestFromRow } from "../services/sessions/session-rows.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * The session operations (ADR 0346, 0347): a chat is started, waited on and
 * answered through one registry. A start answers at once and is found again
 * by its idempotency key; a wait reads Postgres and returns when the chat
 * needs its caller; a question raises the chat's attention and tells its
 * person; a failed turn is a state, never an empty reply.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_operations";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "44444444-4444-4444-8444-444444444444",
  externalUserId: "builder",
};
const assistant = {
  kind: "assistant" as const,
  externalUserId: identity.externalUserId,
};
const unusedSandbox = new Proxy(
  { workspaceRoot: "/unused" } as SandboxProvider,
  {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {
        throw new Error(`Unexpected sandbox call: ${String(property)}`);
      };
    },
  },
);

describe("session operations", () => {
  let tmpDir: string;
  let projectManager: ProjectManager;
  let sessions: AgentSessionsService;
  let operations: SessionOperationsService;
  let projectId: string;
  const settled: AgentTurnSettledEvent[] = [];
  /** Whether a project automation is bound to request events (ADR 0352). */
  let listening = false;
  /** The events it was asked about, as a bound workflow would receive them. */
  const heard: Json[] = [];

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-operations-"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    const echo: RegisteredCodingAgent = {
      id: "echo",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    // Its tools on `prod` ask the person first (ADR 0054).
    const guarded: RegisteredCodingAgent = {
      ...echo,
      id: "guarded",
      toolPolicies: { prod: [{ default: "ask" }] },
    };
    sessions = new AgentSessionsService(db, {
      hostId: "operations-test-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(unusedSandbox),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "echo",
        get: (id: string) => [echo, guarded].find((agent) => agent.id === id),
        list: () => [echo, guarded],
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId: id }: { projectId: string }) => {
          const checkout = path.join(tmpDir, id);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
        head: () => Promise.resolve("c0ffee".padEnd(40, "0")),
      },
      onTurnSettled: (event) => {
        settled.push(event);
      },
      requestListeners: async ({ event }) => {
        heard.push(event);
        return listening;
      },
      sessionUrl: ({ sessionId }) =>
        `https://work.example/?session=${sessionId}`,
    });
    operations = new SessionOperationsService(db, sessions, {
      watchers: () => undefined,
      chatOwner: async ({ caller }) => caller,
      projectManager,
    });
    projectId = (await projects.create(identity, { name: "Operations" })).id;
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns({ timeoutMs: 2_000 });
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** One operation as the member's own assistant runs it. */
  async function run<Result = SessionState>(
    operation: SessionOperationName,
    args: Record<string, unknown>,
    bound = true,
  ): Promise<Result> {
    const value = await operations.execute({
      identity,
      ...(bound ? { projectId } : {}),
      operation,
      args,
      author: assistant,
    });
    // Every answer satisfies its whole schema, and the compact one a
    // tool declares, which clients validate it against.
    z.fromJSONSchema(SESSION_OPERATIONS[operation].outputSchema).parse(value);
    return SESSION_OPERATIONS[operation].output.parse(value) as Result;
  }

  const start = (message: string, extra: Record<string, unknown> = {}) =>
    run("session_start", {
      message,
      idempotencyKey: randomUUID(),
      ...extra,
    });

  /** Wait until the chat needs its caller, as a client loops. */
  async function settle(state: SessionState): Promise<SessionState> {
    let cursor = state.cursor;
    for (let round = 0; round < 20; round += 1) {
      const next = await run("session_wait", {
        sessionIds: [state.sessionId],
        cursor,
        timeoutSeconds: 5,
      });
      if (next.changed) return next;
      cursor = next.cursor;
    }
    throw new Error("The chat never needed its caller");
  }

  it("declares compact answers: a client hands them to its model", () => {
    for (const name of [
      "session_start",
      "session_send",
      "session_wait",
      "session_read",
      "session_answer",
      "session_interrupt",
      "session_close",
      "session_list",
    ] as const) {
      const declared = JSON.stringify(SESSION_OPERATIONS[name].outputSchema);
      expect(declared.length, name).toBeLessThan(2_000);
      expect(declared).not.toContain("$ref");
      expect(SESSION_OPERATIONS[name].outputSchema).toMatchObject({
        type: "object",
      });
      // Told cold: when to use it, and what to call next.
      expect(SESSION_OPERATIONS[name].description).toMatch(/^Use this /);
    }
  });

  it("starts a chat at once and waits for its reply, one registry for every surface", async () => {
    const started = await start("[[wait 300]] Hello");
    expect(started).toMatchObject({
      projectId,
      agent: "echo",
      state: "working",
      reply: null,
      requests: [],
      error: null,
      url: `https://work.example/?session=${started.sessionId}`,
    });
    expect(SessionStateSchema.safeParse(started).success).toBe(true);
    const done = await settle(started);
    expect(done).toMatchObject({
      sessionId: started.sessionId,
      state: "idle",
      changed: true,
      turn: null,
      queued: [],
    });
    expect(done.reply).toContain("Hello");
    // The message is the assistant's, never the person's own words.
    const read = await run("session_read", {
      sessionId: started.sessionId,
      include: ["transcript"],
    });
    expect(read.transcript?.[0]).toMatchObject({
      role: "inbound",
      author: assistant,
    });
    // A wait past the settled chat has nothing new: not an error.
    const quiet = await run("session_wait", {
      sessionIds: [started.sessionId],
      cursor: done.cursor,
      timeoutSeconds: 1,
    });
    expect(quiet).toMatchObject({ changed: false, state: "idle" });
    // A server-wide surface finds the chat's project by itself.
    expect(
      await run("session_read", { sessionId: started.sessionId }, false),
    ).toMatchObject({ projectId, state: "idle" });
    await expect(
      run("session_start", { message: "x", idempotencyKey: "k" }, false),
    ).rejects.toThrow("Name the project");
  }, 60_000);

  it("returns one chat for a start repeated with its idempotency key", async () => {
    const key = randomUUID();
    const call = () =>
      run("session_start", { message: "Once", idempotencyKey: key });
    const [first, second] = await Promise.all([call(), call()]);
    const third = await call();
    expect(new Set([first, second, third].map((s) => s.sessionId)).size).toBe(
      1,
    );
    await settle(first);
    const transcript = (
      await run("session_read", {
        sessionId: first.sessionId,
        include: ["transcript"],
      })
    ).transcript;
    expect(
      transcript?.filter((message) => message.role === "inbound"),
    ).toHaveLength(1);
    // The same key with another message is refused, naming the chat.
    const conflict = await run("session_start", {
      message: "Twice",
      idempotencyKey: key,
    }).catch(sessionOperationError);
    expect(conflict).toMatchObject({
      code: "idempotency_conflict",
      sessionId: first.sessionId,
    });
    // Another actor's same key is another call.
    const other = await operations.execute({
      identity,
      projectId,
      operation: "session_start",
      args: { message: "Once", idempotencyKey: key },
      author: { kind: "user", externalUserId: identity.externalUserId },
    });
    expect(other).not.toMatchObject({ sessionId: first.sessionId });
  }, 60_000);

  it("reports a failed turn as a state with its error, never an empty reply", async () => {
    const failed = await settle(await start("[[fail the model said no]]"));
    expect(failed).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("the model said no") },
      attentionRequired: true,
    });
    expect(
      (await run("session_list", { state: "failed" })) as unknown,
    ).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: failed.sessionId }),
      ]),
    });
  }, 60_000);

  it("stops on a question, raises attention, tells the person, and goes on once answered", async () => {
    settled.length = 0;
    const asked = await settle(await start("[[ask Which branch?]] Done"));
    expect(asked).toMatchObject({
      state: "needs_input",
      attentionRequired: true,
      requests: [{ kind: "question", blocking: true }],
    });
    const [request] = asked.requests;
    // The chat's attention is raised with the request, for a top-level chat.
    expect(
      (await sessions.attention({ identity })).map((session) => session.id),
    ).toContain(asked.sessionId);
    // Its person is told once, as a turn that waits on them.
    expect(
      settled.filter(
        (event) =>
          event.sessionId === asked.sessionId &&
          event.status === "awaiting_input",
      ),
    ).toHaveLength(1);
    // A wait with the cursor it returned holds: nothing new to say.
    expect(
      await run("session_wait", {
        sessionIds: [asked.sessionId],
        cursor: asked.cursor,
        timeoutSeconds: 1,
      }),
    ).toMatchObject({ changed: false, state: "needs_input" });
    const answer = {
      sessionId: asked.sessionId,
      requestId: request?.requestId,
      response: { kind: "question", answers: ["main"] },
      idempotencyKey: randomUUID(),
    };
    const answered = await run("session_answer", answer);
    expect(answered.requests).toEqual([]);
    // The same answer again is the first one's result.
    await run("session_answer", answer);
    const done = await settle(answered);
    expect(done).toMatchObject({ state: "idle" });
    expect(
      JSON.stringify(
        (
          await run("session_read", {
            sessionId: asked.sessionId,
            include: ["transcript"],
          })
        ).transcript,
      ),
    ).toContain("main");
    // Answering what is no longer asked says so.
    expect(
      await run("session_answer", {
        ...answer,
        idempotencyKey: randomUUID(),
      }).catch(sessionOperationError),
    ).toMatchObject({ code: "request_not_pending" });
  }, 60_000);

  it("lets a client approve only when its person granted that", async () => {
    const asked = await settle(
      await start("[[approve prod query]] Done", { agent: "guarded" }),
    );
    expect(asked).toMatchObject({
      state: "needs_input",
      attentionRequired: true,
      requests: [{ kind: "approval", blocking: true }],
    });
    const approve = (caller: Identity) =>
      operations.execute({
        identity: caller,
        projectId,
        operation: "session_answer",
        args: {
          sessionId: asked.sessionId,
          requestId: asked.requests[0]?.requestId,
          response: { kind: "approval", decision: "approved" },
          idempotencyKey: randomUUID(),
        },
        author: assistant,
      });
    // A grant without the scope cannot approve on its person's behalf.
    expect(
      await approve({
        ...identity,
        tokenScopes: ["work:read", "sessions:run"],
      }).catch(sessionOperationError),
    ).toMatchObject({ code: "not_authorized" });
    expect(
      (await run("session_read", { sessionId: asked.sessionId })).state,
    ).toBe("needs_input");
    // One that carries it can, and the agent goes on.
    await approve({
      ...identity,
      tokenScopes: ["work:read", "sessions:run", "sessions:approve"],
    });
    const done = await settle(
      await run("session_read", { sessionId: asked.sessionId }),
    );
    expect(done.state).toBe("idle");
    expect(
      JSON.stringify(
        (
          await run("session_read", {
            sessionId: asked.sessionId,
            include: ["transcript"],
          })
        ).transcript,
      ),
    ).toContain("Allowed query.");
  }, 60_000);

  it("holds an unattended chat's approval for the project's automations, which alone answer it (ADR 0352)", async () => {
    const project = projectChatIdentity({
      tenantId: identity.tenantId,
      projectId,
    });
    const workflow = {
      kind: "workflow" as const,
      runId: randomUUID(),
      workflowName: "answerRequests",
    };
    /** One operation as a project automation's run makes it. */
    const asProject = (
      operation: SessionOperationName,
      args: Record<string, unknown>,
    ) =>
      operations.execute({
        identity: project,
        projectId,
        operation,
        args,
        author: workflow,
      });
    const ask = async () =>
      SESSION_OPERATIONS.session_start.output.parse(
        await asProject("session_start", {
          message: "[[approve prod query]] Done",
          agent: "guarded",
          idempotencyKey: randomUUID(),
        }),
      ) as SessionState;
    const transcript = async (sessionId: string) =>
      JSON.stringify(
        (await run("session_read", { sessionId, include: ["transcript"] }))
          .transcript,
      );
    const recorded = (sessionId: string) =>
      db
        .selectFrom("project_events")
        .select("payload")
        .where("project_id", "=", projectId)
        .where("kind", "=", "session.request-opened")
        .where(sql<boolean>`payload ->> 'sessionId' = ${sessionId}`)
        .execute();

    // No automation listens and no one watches: refused at once, with no
    // event of a request nobody could answer.
    listening = false;
    const refused = await settle(await ask());
    expect(refused).toMatchObject({ state: "idle", requests: [] });
    expect(await transcript(refused.sessionId)).toContain(
      "no one watches this chat",
    );
    expect(await recorded(refused.sessionId)).toEqual([]);

    // One listens: the approval waits for it, two minutes, as a session
    // event with the request in its detail.
    listening = true;
    const asked = await settle(await ask());
    expect(asked).toMatchObject({
      state: "needs_input",
      requests: [{ kind: "approval", blocking: true }],
    });
    const requestId = asked.requests[0]?.requestId;
    const pending = requestFromRow(
      await db
        .selectFrom("agent_runtime_requests")
        .selectAll()
        .where("request_id", "=", requestId ?? "")
        .executeTakeFirstOrThrow(),
    );
    expect(pending.approvers).toEqual([]);
    expect(
      Math.round(
        (Date.parse(pending.expiresAt ?? "") - Date.parse(pending.createdAt)) /
          60_000,
      ),
    ).toBe(2);
    const events = await recorded(asked.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      sessionId: asked.sessionId,
      agentId: "guarded",
      session: { id: asked.sessionId, status: "active" },
      detail: {
        requestId,
        kind: "approval",
        blocking: true,
        approval: { tool: { server: "prod", name: "query" } },
      },
    });
    // The listener was asked about the event a bound workflow receives.
    expect(heard.at(-1)).toMatchObject({
      source: "session",
      kind: "session.request-opened",
      projectId,
      payload: { sessionId: asked.sessionId, detail: { kind: "approval" } },
    });

    const answer = (decision: "approved" | "denied") => ({
      sessionId: asked.sessionId,
      requestId,
      response: { kind: "approval", decision },
      idempotencyKey: randomUUID(),
    });
    // A member who may continue the chat is not who approves for it.
    expect(
      await run("session_answer", answer("approved")).catch(
        sessionOperationError,
      ),
    ).toMatchObject({ code: "not_authorized" });
    expect(
      (await run("session_read", { sessionId: asked.sessionId })).state,
    ).toBe("needs_input");
    // The project's own automation is, and the agent goes on.
    await asProject("session_answer", answer("approved"));
    const done = await settle(
      await run("session_read", { sessionId: asked.sessionId }),
    );
    expect(done.state).toBe("idle");
    expect(await transcript(asked.sessionId)).toContain("Allowed query.");
    listening = false;
  }, 60_000);

  it("sends, interrupts and closes with keys that make retries safe", async () => {
    const chat = await settle(await start("First"));
    const send = {
      sessionId: chat.sessionId,
      message: "[[hang]]",
      idempotencyKey: randomUUID(),
    };
    const sent = await run<SessionState & { sent?: { created: boolean } }>(
      "session_send",
      send,
    );
    expect(sent).toMatchObject({ state: "working", sent: { created: true } });
    expect(await run("session_send", send)).toMatchObject({
      sent: { created: false },
    });
    const interrupt = {
      sessionId: chat.sessionId,
      idempotencyKey: randomUUID(),
    };
    await expect
      .poll(
        async () =>
          (await run("session_read", { sessionId: chat.sessionId })).turn
            ?.status,
        { timeout: 10_000 },
      )
      .toBe("running");
    expect(await run("session_interrupt", interrupt)).toMatchObject({
      interrupted: true,
    });
    const stopped = await settle(sent);
    expect(stopped).toMatchObject({ state: "idle", reply: null });
    const closed = await run("session_close", {
      sessionId: chat.sessionId,
      idempotencyKey: randomUUID(),
    });
    expect(closed).toMatchObject({ closed: true, state: "closed" });
    expect(
      await run("session_send", {
        ...send,
        idempotencyKey: randomUUID(),
      }).catch(sessionOperationError),
    ).toMatchObject({ code: "session_closed" });
    expect(
      await run("session_read", { sessionId: randomUUID() }).catch(
        sessionOperationError,
      ),
    ).toMatchObject({ code: "not_found" });
  }, 60_000);

  it("answers the paths that differ between two commits of a chat to whoever may read it", async () => {
    expect(SESSION_OPERATIONS.session_changed_paths).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true },
      scope: "work:read",
    });
    expect(sessionOperationHostName("session_changed_paths")).toBe(
      "changedPaths",
    );
    const chat = await settle(await start("compare two commits"));
    // The copy of the chat's repository this host keeps, two commits on.
    const copy = await projectManager.openSession({
      tenantId: identity.tenantId,
      projectId,
      sessionId: chat.sessionId,
    });
    const author = { name: "Tester", email: "tester@work.example" };
    await copy.writeFile("bun.lock", "lock 1\n");
    await copy.writeFile("src/keep.ts", "export {};\n");
    const from = await copy.commit("First", author);
    await copy.writeFile("bun.lock", "lock 2\n");
    await copy.writeFile("docs/my notes.md", "notes\n");
    const to = await copy.commit("Second", author);
    await copy.dispose();

    const differs = {
      paths: ["bun.lock", "docs/my notes.md"],
      truncated: false,
      complete: true,
    };
    const compare = { sessionId: chat.sessionId, from, to };
    expect(await run<ChangedPaths>("session_changed_paths", compare)).toEqual(
      differs,
    );
    // The chat is found by its id alone, on a server-wide connection too.
    expect(
      await run<ChangedPaths>("session_changed_paths", compare, false),
    ).toEqual(differs);
    expect(
      await run<ChangedPaths>("session_changed_paths", {
        ...compare,
        to: from,
      }),
    ).toEqual({ paths: [], truncated: false, complete: true });
    // A commit this copy does not hold: nothing was compared.
    expect(
      await run<ChangedPaths>("session_changed_paths", {
        ...compare,
        from: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toEqual({ paths: [], truncated: false, complete: false });
    // A commit is named by its full id, never a ref.
    for (const named of ["main", from.slice(0, 12), "--output=leaked.txt"])
      expect(
        await run("session_changed_paths", { ...compare, from: named }).catch(
          sessionOperationError,
        ),
      ).toMatchObject({ code: "invalid_input" });

    // A subsession that shares the chat's workspace reads the same copy
    // (ADR 0322): it has none of its own.
    const sharing = await settle(await start("works in the first chat's"));
    await db
      .updateTable("agent_sessions")
      .set({ workspace_session_id: chat.sessionId })
      .where("id", "=", sharing.sessionId)
      .execute();
    expect(
      await run<ChangedPaths>("session_changed_paths", {
        ...compare,
        sessionId: sharing.sessionId,
      }),
    ).toEqual(differs);

    // Mallory reaches the project's agents, not this member's chats.
    const mallory: Identity = {
      tenantId: identity.tenantId,
      externalUserId: "mallory",
      scope: [{ kind: "agent", projectId, name: EVERY_ARTIFACT }],
    };
    expect(
      await operations
        .execute({
          identity: mallory,
          projectId,
          operation: "session_changed_paths",
          args: compare,
          author: { kind: "user", externalUserId: "mallory" },
        })
        .catch(sessionOperationError),
    ).toMatchObject({ code: "not_authorized" });
    expect(
      await run("session_changed_paths", {
        ...compare,
        sessionId: randomUUID(),
      }).catch(sessionOperationError),
    ).toMatchObject({ code: "not_found" });
    // A read: nothing is recorded as an action of the chat.
    expect(
      await db
        .selectFrom("session_actions")
        .select("id")
        .where("operation", "=", "session_changed_paths")
        .execute(),
    ).toEqual([]);
  }, 60_000);

  it("waits on several chats with one cursor", async () => {
    const slow = await start("[[wait 1500]] slow");
    const quick = await start("quick");
    const first = await run<
      SessionState & { others?: Array<{ sessionId: string }> }
    >("session_wait", {
      sessionIds: [slow.sessionId, quick.sessionId],
      timeoutSeconds: 10,
    });
    expect(first).toMatchObject({
      sessionId: quick.sessionId,
      state: "idle",
      changed: true,
      others: [{ sessionId: slow.sessionId }],
    });
    // Its cursor names both chats: the settled one is not reported again.
    expect([...parseWaitCursor(first.cursor, [slow.sessionId]).keys()]).toEqual(
      [slow.sessionId],
    );
    const second = await run("session_wait", {
      sessionIds: [slow.sessionId, quick.sessionId],
      cursor: first.cursor,
      timeoutSeconds: 15,
    });
    expect(second).toMatchObject({
      sessionId: slow.sessionId,
      state: "idle",
      changed: true,
    });
    await expect(
      run("session_wait", {
        sessionIds: [slow.sessionId, quick.sessionId],
        cursor: "12",
      }),
    ).rejects.toThrow("Unknown cursor");
  }, 60_000);
});
