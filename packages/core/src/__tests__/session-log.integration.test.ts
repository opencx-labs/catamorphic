import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentAttachment,
  applySessionEvents,
  itemsOfTurn,
  orderedTurns,
  pendingRequests,
  type SessionEvent,
  type SessionStreamMessage,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import type {
  HarnessAdapter,
  ThreadBinding,
} from "@catamorphic/agent-protocol/runner";
import { EchoAdapter } from "@catamorphic/agent-runner";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import {
  ATTACHMENT_MARKER,
  type SandboxProvider,
  STOPPED_WAITING_NOTE,
  waitUntil,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionLog } from "../services/sessions/session-log.js";
import { readFullSnapshot } from "../services/sessions/session-reads.js";
import {
  hostRetryDelay,
  TurnEngine,
} from "../services/sessions/turn-engine.js";
import { type WorkTopic, WorkWakeups } from "../services/work-wakeups.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * The session log end to end (ADRs 0197, 0198): a real AgentSessionsService
 * on PGlite driving the deterministic echo harness in this process.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_log";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "builder",
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

describe("session log", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projects: ProjectsService;
  let makeService: (wakeups?: WorkWakeups) => AgentSessionsService;
  /** Each checkout's commit, as the host reports it. */
  const heads = new Map<string, string>();
  /** The thread each attempt of the recording agent started on. */
  const bindings: ThreadBinding[] = [];
  /** What the lingering harness's tool call after its turn ended got. */
  const lateTools: string[] = [];
  /**
   * The sign-in agent's host (ADR 0228): whether the sign-in can still
   * refresh, how long its retry waits, and how often it was asked.
   */
  const signIn = { refreshable: true, afterMs: 50, asked: 0 };

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-log-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const echo: RegisteredCodingAgent = {
      id: "echo",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    // Refuses a steer on a turn's first attempt, as a harness that cannot take
    // input mid-turn: the turn restarts with it.
    const inner = new EchoAdapter();
    const stubbornAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        const control = inner.start(attempt, host);
        const first = attempt.reason === "initial";
        return {
          ...control,
          steer: (input) =>
            first ? Promise.resolve(false) : control.steer(input),
        };
      },
    };
    const stubborn: RegisteredCodingAgent = {
      ...echo,
      id: "stubborn",
      harness: { placement: "host", adapter: stubbornAdapter },
    };
    // The same, but its first attempt never reports its thread, as an ACP
    // agent does until a new session holds the conversation (ADR 0241).
    const forgetfulAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        const first = attempt.reason === "initial";
        const control = inner.start(attempt, {
          emit: (event) => {
            if (!(first && event.type === "thread")) host.emit(event);
          },
          callTool: (call) => host.callTool(call),
          authorize: (call) => host.authorize(call),
          request: (key, request, options) =>
            host.request(key, request, options),
          nativeState: host.nativeState,
          signal: host.signal,
        });
        return {
          ...control,
          steer: (input) =>
            first ? Promise.resolve(false) : control.steer(input),
        };
      },
    };
    const forgetful: RegisteredCodingAgent = {
      ...echo,
      id: "forgetful",
      harness: { placement: "host", adapter: forgetfulAdapter },
    };
    // Its threads are gone whenever it is asked to resume one, as an agent
    // whose sessions were deleted (ADR 0245); with `[[always-lost]]`, on a
    // fresh thread too; with `[[lost-midway]]`, it says so and goes on in a
    // replacement of its own instead of failing.
    const amnesiacAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        const resuming =
          attempt.thread.mode === "resume" || attempt.thread.mode === "restore";
        if (
          resuming &&
          (attempt.input?.text ?? "").includes("[[lost-midway]]")
        ) {
          host.emit({ type: "thread.lost", reason: "Its session was pruned." });
          return inner.start(
            {
              ...attempt,
              thread: {
                mode: "fresh",
                providerThreadId: attempt.thread.providerThreadId,
              },
            },
            host,
          );
        }
        if (
          !resuming &&
          !(attempt.input?.text ?? "").includes("[[always-lost]]")
        )
          return inner.start(attempt, host);
        host.emit({ type: "thread.lost", reason: "Its session was deleted." });
        host.emit({
          type: "turn.completed",
          status: "failed",
          error: { message: "The agent couldn't reopen its session." },
        });
        return {
          steer: async () => false,
          interrupt: () => {},
          finished: Promise.resolve(),
        };
      },
    };
    const amnesiac: RegisteredCodingAgent = {
      ...echo,
      id: "amnesiac",
      harness: { placement: "host", adapter: amnesiacAdapter },
    };
    // Rate-limited on its first attempt: the turn waits to retry itself.
    let flakyStarts = 0;
    const flakyAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        flakyStarts += 1;
        if (flakyStarts > 1) return inner.start(attempt, host);
        const limited: typeof host = Object.create(host);
        limited.emit = (event) =>
          host.emit(
            event.type === "turn.completed"
              ? {
                  type: "turn.completed",
                  status: "failed",
                  error: {
                    message: "429 rate limit exceeded",
                    kind: "rate_limit",
                    retrySafe: true,
                  },
                }
              : event,
          );
        return inner.start(attempt, limited);
      },
    };
    const flaky: RegisteredCodingAgent = {
      ...echo,
      id: "flaky",
      harness: { placement: "host", adapter: flakyAdapter },
    };
    // Turned away by its provider on a turn's first N attempts ("sign-in
    // N"), before any work, as an access token the CLI could not refresh;
    // "sign-in N refused" is a failure that is not safe to send again.
    const signInStarts = new Map<string, number>();
    const signInAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        const starts = (signInStarts.get(attempt.turnId) ?? 0) + 1;
        signInStarts.set(attempt.turnId, starts);
        const text = attempt.input?.text ?? "";
        const failing = Number(/sign-in (\d+)/.exec(text)?.[1] ?? 0);
        if (starts > failing) return inner.start(attempt, host);
        const rejected: typeof host = Object.create(host);
        rejected.emit = (event) =>
          host.emit(
            event.type === "turn.completed"
              ? {
                  type: "turn.completed",
                  status: "failed",
                  error: {
                    message:
                      "Failed to authenticate. API Error: 401 OAuth access token has expired.",
                    kind: "auth",
                    ...(text.includes("refused") ? {} : { retrySafe: true }),
                  },
                }
              : event,
          );
        return inner.start(attempt, rejected);
      },
    };
    const signedIn: RegisteredCodingAgent = {
      ...echo,
      id: "signed-in",
      harness: { placement: "host", adapter: signInAdapter },
      retryFailure: async ({ error }) => {
        signIn.asked += 1;
        return error.kind === "auth" && signIn.refreshable
          ? { afterMs: signIn.afterMs, activity: "Reconnecting to Claude…" }
          : undefined;
      },
    };
    // Tries to write a person's message over the turn's input, then
    // answers like the echo harness.
    const forgerAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        host.emit({
          type: "item.started",
          key: "forged",
          status: "completed",
          item: {
            kind: "user_message",
            id: attempt.input?.itemId ?? "",
            author: { kind: "user", externalUserId: "someone-else" },
            text: "forged words",
            attachments: [],
            dispatch: "queue",
            attention: null,
            idempotencyKey: null,
            metadata: {},
          } as never,
        });
        return inner.start(attempt, host);
      },
    };
    const forger: RegisteredCodingAgent = {
      ...echo,
      id: "forger",
      harness: { placement: "host", adapter: forgerAdapter },
    };
    // Lingers after its turn ended, as a harness whose process does not
    // exit: it still calls a tool, and runs until the engine ends it.
    const lingeringAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (_attempt, host) => {
        host.emit({
          type: "thread",
          ref: { id: randomUUID(), strength: "strong" },
        });
        host.emit({ type: "turn.started" });
        host.emit({
          type: "item.started",
          key: "reply",
          status: "completed",
          item: { kind: "assistant_message", text: "Done.", agentId: null },
        });
        host.emit({ type: "turn.completed", status: "completed" });
        setTimeout(() => {
          void host.callTool({ name: "after_the_end", input: {} }).then(
            () => lateTools.push("ran"),
            (error: unknown) =>
              lateTools.push(
                error instanceof Error ? error.message : String(error),
              ),
          );
        }, 100);
        return {
          steer: () => Promise.resolve(false),
          interrupt: () => {},
          finished: new Promise<void>(() => {}),
        };
      },
    };
    const lingering: RegisteredCodingAgent = {
      ...echo,
      id: "lingering",
      harness: { placement: "host", adapter: lingeringAdapter },
    };
    // Slow to begin its first `[[hesitate]]` turn: it names its thread and
    // never reports the turn begun, as a harness still starting up when its
    // host restarts (ADR 0246). Every later attempt is echo's.
    let hesitated = false;
    const hesitantAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        if (hesitated || !attempt.input?.text.includes("[[hesitate]]"))
          return inner.start(attempt, host);
        hesitated = true;
        host.emit({
          type: "thread",
          ref:
            attempt.thread.mode === "resume"
              ? attempt.thread.nativeRef
              : { id: randomUUID(), strength: "strong" },
        });
        return {
          steer: async () => false,
          interrupt: () => {},
          finished: new Promise<void>((resolve) =>
            host.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
        };
      },
    };
    const hesitant: RegisteredCodingAgent = {
      ...echo,
      id: "hesitant",
      harness: { placement: "host", adapter: hesitantAdapter },
    };
    // Its tools on `prod` ask the person first (ADR 0054).
    const guarded: RegisteredCodingAgent = {
      ...echo,
      id: "guarded",
      toolPolicies: { prod: [{ default: "ask" }] },
    };
    // Cannot run until someone approves it.
    const blocked: RegisteredCodingAgent = {
      ...echo,
      id: "blocked",
      unavailable: "Approve this agent first.",
    };
    // Echo, noting which thread binding each attempt starts with.
    const recording: RegisteredCodingAgent = {
      ...echo,
      id: "recording",
      harness: {
        placement: "host",
        adapter: {
          id: "echo",
          capabilities: () => inner.capabilities(),
          start: (attempt, host) => {
            bindings.push(attempt.thread);
            return inner.start(attempt, host);
          },
        },
      },
    };
    // The same echo on another harness.
    const elsewhere: RegisteredCodingAgent = {
      ...echo,
      id: "elsewhere",
      harness: {
        placement: "host",
        adapter: {
          id: "elsewhere",
          capabilities: () => inner.capabilities(),
          start: (attempt, host) => {
            if (
              attempt.thread.mode !== "fresh" ||
              !attempt.input?.text.endsWith("[[reject-before-start]]")
            )
              return inner.start(attempt, host);
            host.emit({
              type: "thread",
              ref: { id: randomUUID(), strength: "strong" },
            });
            host.emit({
              type: "turn.completed",
              status: "failed",
              error: { message: "Turn start refused" },
            });
            return {
              steer: async () => false,
              interrupt: () => {},
              finished: Promise.resolve(),
            };
          },
        },
      },
    };
    const interruptedStart: RegisteredCodingAgent = {
      ...elsewhere,
      id: "interrupted-start",
      harness: {
        placement: "host",
        adapter: {
          id: "elsewhere",
          capabilities: () => inner.capabilities(),
          start: (attempt, host) => {
            if (!attempt.input?.text.endsWith("[[interrupt-before-start]]"))
              return inner.start(attempt, host);
            host.emit({
              type: "thread",
              ref: { id: randomUUID(), strength: "strong" },
            });
            host.emit({ type: "turn.completed", status: "interrupted" });
            return {
              steer: async () => false,
              interrupt: () => {},
              finished: Promise.resolve(),
            };
          },
        },
      },
    };
    // A host tool that waits the way Work's do (ADR 0264): until its minute
    // is up, or something reaches the agent.
    const waiter: RegisteredCodingAgent = {
      ...echo,
      id: "waiter",
      harness: {
        placement: "host",
        adapter: new EchoAdapter(),
        hostTools: [
          {
            name: "wait_a_while",
            description: "Waits up to a minute",
            parameters: {},
            execute: async (_input, context) => ({
              waited: await waitUntil({
                ready: () => false,
                timeoutMs: 60_000,
                stopWaiting: context.stopWaiting,
              }),
            }),
          },
        ],
      },
    };
    makeService = (wakeups) =>
      new AgentSessionsService(db, {
        hostId: "session-log-host",
        ...(wakeups ? { wakeups } : {}),
        projectManager,
        executionEnvironments: new ExecutionEnvironmentsService(
          new ProjectEnvironmentsService(db, projectManager),
          testEnvironmentProvider(unusedSandbox),
        ),
        executionAllocations: new ExecutionAllocationsService(db),
        codingAgents: {
          defaultAgentId: () => "echo",
          get: (id) =>
            [
              echo,
              guarded,
              stubborn,
              forgetful,
              amnesiac,
              flaky,
              signedIn,
              forger,
              lingering,
              elsewhere,
              interruptedStart,
              blocked,
              recording,
              hesitant,
              waiter,
            ].find((agent) => agent.id === id),
          list: () => [
            echo,
            guarded,
            stubborn,
            flaky,
            signedIn,
            forger,
            lingering,
            elsewhere,
            blocked,
            recording,
          ],
        },
        nativeAgentCheckout: {
          resolve: async ({ projectId }) => {
            const checkout = path.join(tmpDir, "checkouts", projectId);
            await fs.mkdir(checkout, { recursive: true });
            return { path: checkout, owned: false };
          },
          // A person's folder: only a turn asked to "change files" commits.
          checkpoint: ({ workingDirectory, message }) => {
            if (!message.includes("change files")) return Promise.resolve(null);
            const commit = randomUUID();
            heads.set(workingDirectory, commit);
            return Promise.resolve(commit);
          },
          head: ({ workingDirectory }) =>
            Promise.resolve(heads.get(workingDirectory) ?? "initial"),
          restore: ({ workingDirectory, commit, expectedHead }) => {
            const head = heads.get(workingDirectory) ?? "initial";
            if (head !== (expectedHead ?? commit))
              return Promise.resolve("This folder changed.");
            heads.set(workingDirectory, commit);
            return Promise.resolve("restored");
          },
        },
      });
    sessions = makeService();
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function chat(name: string) {
    const project = await projects.create(identity, { name });
    const session = await sessions.create(identity, project.id);
    return { projectId: project.id, sessionId: session.id };
  }

  it("runs a turn and records it as a gapless log a client can fold", async () => {
    const { projectId, sessionId } = await chat("Echo");
    const { reply, turn } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "hello",
    );
    expect(turn.status).toBe("completed");
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Echo: hello",
    );

    const detail = await sessions.get(identity, projectId, sessionId);
    const state = sessionStateFromSnapshot(detail.snapshot);
    const [only] = orderedTurns(state);
    expect(only?.status).toBe("completed");
    expect(itemsOfTurn(state, only?.id ?? "").map((item) => item.kind)).toEqual(
      ["user_message", "assistant_message"],
    );

    // Folding the log from the start gives the same transcript.
    const events = await db
      .selectFrom("agent_session_events")
      .select("sequence")
      .where("session_id", "=", sessionId)
      .orderBy("sequence")
      .execute();
    expect(events.map((row) => Number(row.sequence))).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(detail.snapshot.sequence).toBe(events.length);
  });

  it("persists provider retry state in the log and projection without changing turn retry authority", async () => {
    const { projectId, sessionId } = await chat("Provider wait");
    const { turn } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "fixture",
    );
    const providerRetry = {
      error: { message: "Provider says E_OPAQUE" },
      attempt: null,
      maxAttempts: null,
      retryAt: null,
    };
    const log = new SessionLog(db);
    await db.transaction().execute((trx) =>
      log.append(trx, {
        sessionId,
        events: [
          {
            type: "turn.changed",
            turn: {
              ...turn,
              providerRetry,
            },
          },
        ],
      }),
    );
    const snapshot = await readFullSnapshot({ db, sessionId });
    expect(snapshot.turns[0]?.providerRetry).toEqual(providerRetry);
    expect(snapshot.turns[0]?.retryAt).toBeNull();
    expect(snapshot.turns[0]?.error).toBeNull();
    const raw = await db
      .selectFrom("agent_turns")
      .select("provider_retry")
      .where("id", "=", turn.id)
      .executeTakeFirstOrThrow();
    expect(raw.provider_retry).toEqual(providerRetry);
    await db.transaction().execute((trx) =>
      log.append(trx, {
        sessionId,
        events: [
          { type: "turn.changed", turn: { ...turn, providerRetry: null } },
        ],
      }),
    );
    expect(
      (await sessions.get(identity, projectId, sessionId)).snapshot.turns[0]
        ?.providerRetry,
    ).toBeNull();
  });

  it("runs a command once however often it is sent", async () => {
    const { projectId, sessionId } = await chat("Idempotent");
    const command = {
      type: "send" as const,
      commandId: randomUUID(),
      text: "once",
    };
    const [first, second] = await Promise.all([
      sessions.command(identity, projectId, sessionId, command),
      sessions.command(identity, projectId, sessionId, command),
    ]);
    expect(first.status).toBe("accepted");
    expect(second).toEqual(first);
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns.map((turn) => turn.status)).toEqual([
          "completed",
        ]);
      },
      { timeout: 10_000 },
    );
  });

  it("hints what a command wrote once it commits, and other appends at once", async () => {
    const { sessionId } = await chat("Hints");
    const wakeups = new WorkWakeups();
    const heard: WorkTopic[] = [];
    for (const topic of ["sessions", "chats", "agent"] as const)
      wakeups.subscribe(topic, () => heard.push(topic));
    const log = new SessionLog(db, wakeups);
    const renamed = (title: string): SessionEvent[] => [
      { type: "session.changed", session: { title } },
    ];
    let beforeCommit: WorkTopic[] | undefined;
    await log.command({
      sessionId,
      commandId: randomUUID(),
      type: "rename",
      run: async (trx) => {
        await log.append(trx, { sessionId, events: renamed("Hinted") });
        beforeCommit = [...heard];
        return null;
      },
    });
    expect(beforeCommit).toEqual([]);
    expect(heard).toEqual(["sessions", "chats"]);
    // A command that rolls back hints nothing.
    heard.length = 0;
    await expect(
      log.command({
        sessionId,
        commandId: randomUUID(),
        type: "rename",
        run: async (trx) => {
          await log.append(trx, { sessionId, events: renamed("Lost") });
          throw new Error("Rolled back");
        },
      }),
    ).rejects.toThrow("Rolled back");
    expect(heard).toEqual([]);
    // Another writer's transaction hints as it appends.
    await db.transaction().execute(async (trx) => {
      await log.append(trx, { sessionId, events: renamed("Direct") });
      expect(heard).toEqual(["sessions", "chats"]);
    });
  });

  it("tells this process's chat lists when a chat changes outside its log", async () => {
    const { projectId, sessionId } = await chat("Lists");
    const wakeups = new WorkWakeups();
    const service = makeService(wakeups);
    const heard = vi.fn();
    wakeups.subscribe("chats", heard);
    await service.setIcon(identity, projectId, sessionId, "star:blue");
    expect(heard).toHaveBeenCalledTimes(1);
    await service.requestAttention(identity, projectId, sessionId);
    expect(heard).toHaveBeenCalledTimes(2);
    await service.acknowledgeAttention(identity, projectId, sessionId);
    expect(heard).toHaveBeenCalledTimes(3);
    heard.mockClear();
    await service.archive(identity, projectId, sessionId);
    expect(heard).toHaveBeenCalled();
    heard.mockClear();
    await service.unarchive(identity, projectId, sessionId);
    expect(heard).toHaveBeenCalled();
    heard.mockClear();
    await service.create(identity, projectId);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("waits on a question and goes on with the person's answer", async () => {
    const { projectId, sessionId } = await chat("Question");
    const running = sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[ask Ship it?]]",
    );
    const request = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const state = sessionStateFromSnapshot(detail.snapshot);
        const [pending] = pendingRequests(state);
        expect(pending?.kind).toBe("question");
        expect(orderedTurns(state)[0]?.status).toBe("waiting");
        return pending;
      },
      { timeout: 10_000 },
    );
    if (!request) throw new Error("No question");
    const receipt = await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request.id,
      response: { kind: "question", answers: ["Yes"] },
    });
    expect(receipt.status).toBe("accepted");
    const { turn } = await running;
    expect(turn.status).toBe("completed");
    const transcript = await sessions.transcript(
      identity,
      projectId,
      sessionId,
    );
    expect(transcript.map((message) => message.content)).toContain(
      "You answered: Yes",
    );

    // A second answer is refused durably, not applied twice.
    const again = await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request.id,
      response: { kind: "question", answers: ["No"] },
    });
    expect(again.status).toBe("rejected");
  });

  it("carries an answer's pills: the agent reads them in it, and its images follow as a message (ADR 0244)", async () => {
    const { projectId, sessionId } = await chat("Answer pills");
    const running = sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[ask Which layout?]]",
    );
    const request = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const [pending] = pendingRequests(
          sessionStateFromSnapshot(detail.snapshot),
        );
        expect(pending?.kind).toBe("question");
        return pending;
      },
      { timeout: 10_000 },
    );
    if (!request) throw new Error("No question");
    const M = ATTACHMENT_MARKER;
    const paste: AgentAttachment = {
      kind: "text",
      name: "notes.txt",
      text: "columns of cards",
      source: { type: "paste" },
    };
    const image: AgentAttachment = {
      kind: "image",
      name: "shot.png",
      mediaType: "image/png",
      dataBase64: "AAAA",
    };
    const response = {
      kind: "question" as const,
      answers: [`Like ${M} and ${M}`],
      attachments: [[paste, image]],
    };
    const receipt = await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request.id,
      response,
    });
    expect(receipt.status).toBe("accepted");
    const { turn } = await running;
    expect(turn.status).toBe("completed");
    // The agent read the pasted text in the answer, and where the image is.
    const transcript = await sessions.transcript(
      identity,
      projectId,
      sessionId,
    );
    const said = transcript.map((message) => message.content).join("\n");
    expect(said).toContain(
      "You answered: Like [attachment 1: notes.txt] and [attachment 2: shot.png, attachment 1 of the message after these answers]",
    );
    expect(said).toContain("columns of cards");
    // And it read that message in the same turn.
    expect(said).toContain('Steered: With my answer to "Which layout?"');
    const detail = await sessions.get(identity, projectId, sessionId);
    const state = sessionStateFromSnapshot(detail.snapshot);
    // The answer keeps its words and pills for history, as a message does.
    expect(state.requests[request.id]?.response).toEqual(response);
    // The image followed in that turn, a message carrying the same answer.
    const media = detail.snapshot.items.find(
      (item) =>
        item.kind === "user_message" && item.answer?.requestId === request.id,
    );
    expect(media).toMatchObject({
      turnId: turn.id,
      text: `With my answer to "Which layout?": ${M}`,
      attachments: [image],
      answer: { requestId: request.id, answers: response.answers },
    });
    // The pills are the request's alone: not a second copy on the message.
    expect(
      media?.kind === "user_message" &&
        media.answer &&
        "attachments" in media.answer,
    ).toBe(false);
  });

  it("interrupts a turn and runs the next queued one", async () => {
    const { projectId, sessionId } = await chat("Interrupt");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[hang]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "after",
      dispatch: "queue",
    });
    await sessions.command(identity, projectId, sessionId, {
      type: "interrupt",
      commandId: randomUUID(),
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(
          orderedTurns(sessionStateFromSnapshot(detail.snapshot)).map(
            (turn) => turn.status,
          ),
        ).toEqual(["interrupted", "completed"]);
      },
      { timeout: 15_000 },
    );
  });

  it("steers a message sent while the agent works into its turn (ADR 0240)", async () => {
    const { projectId, sessionId } = await chat("Steer");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 1500]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    // No dispatch: a working turn reads it at its next step.
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "also this",
    });
    expect(sent.result).toMatchObject({ mode: "steer" });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const state = sessionStateFromSnapshot(detail.snapshot);
        const turns = orderedTurns(state);
        expect(turns.map((turn) => turn.status)).toEqual(["completed"]);
        const reply = itemsOfTurn(state, turns[0]?.id ?? "").find(
          (item) => item.kind === "assistant_message",
        );
        expect(reply?.kind === "assistant_message" && reply.text).toContain(
          "also this",
        );
      },
      { timeout: 15_000 },
    );
  });

  /** The session's items and turns as a client folds them. */
  async function folded(projectId: string, sessionId: string) {
    const detail = await sessions.get(identity, projectId, sessionId);
    return sessionStateFromSnapshot(detail.snapshot);
  }

  async function running(projectId: string, sessionId: string) {
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await folded(projectId, sessionId))[0]?.status,
        ).toBe("running"),
      { timeout: 10_000 },
    );
  }

  function notifyTests(projectId: string, sessionId: string, key: string) {
    return sessions.notify(identity, projectId, sessionId, {
      task: {
        type: "background_command",
        id: `tests-${key}`,
        title: "Run the tests",
        status: "completed",
      },
      summary: `Run the tests finished (${key})`,
      detail: `All passed (${key})`,
      idempotencyKey: `tests:${sessionId}:${key}`,
    });
  }

  it("ends a host tool's wait when a task notification reaches the turn (ADR 0264)", async () => {
    const project = await projects.create(identity, { name: "Waiting" });
    const { id: sessionId } = await sessions.create(identity, project.id, {
      agentId: "waiter",
    });
    const projectId = project.id;
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[tool wait_a_while {}]]",
    });
    const toolCall = async () =>
      (await folded(projectId, sessionId)).items.find(
        (item) => item.kind === "tool_call",
      );
    await vi.waitFor(
      async () => expect((await toolCall())?.status).toBe("in_progress"),
      { timeout: 10_000 },
    );
    await notifyTests(projectId, sessionId, "waiting");
    // Well inside the tool's minute: the notification ended its wait, and
    // the agent read it at its next step, in the same turn.
    await vi.waitFor(
      async () => {
        const state = await folded(projectId, sessionId);
        expect(orderedTurns(state).map((turn) => turn.status)).toEqual([
          "completed",
        ]);
        const call = await toolCall();
        const said =
          call?.kind === "tool_call"
            ? JSON.stringify(call.result)
            : "no tool call";
        expect(said).toContain("stopped");
        expect(said).toContain(
          JSON.stringify(STOPPED_WAITING_NOTE).slice(1, -1),
        );
        const reply = state.items.find(
          (item) => item.kind === "assistant_message",
        );
        expect(reply?.kind === "assistant_message" && reply.text).toContain(
          "Run the tests finished (waiting)",
        );
      },
      { timeout: 15_000 },
    );
  });

  it("keeps a steered message unread until the agent reaches its next step", async () => {
    const { projectId, sessionId } = await chat("Unread steer");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[wait 1500]]",
    });
    await running(projectId, sessionId);
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "and the docs",
    });
    const itemId = String(sent.result?.itemId);
    // The harness took the steer, and holds it until its step ends.
    await vi.waitFor(
      async () =>
        expect(
          await db
            .selectFrom("agent_turn_commands")
            .select("status")
            .where("kind", "=", "steer")
            .where(sql<string>`payload->>'itemId'`, "=", itemId)
            .executeTakeFirst(),
        ).toEqual({ status: "acknowledged" }),
      { timeout: 10_000 },
    );
    const unread = (await folded(projectId, sessionId)).items.find(
      (item) => item.id === itemId,
    );
    expect(unread).toMatchObject({ dispatch: "steer", status: "in_progress" });
    await vi.waitFor(
      async () => {
        const state = await folded(projectId, sessionId);
        expect(orderedTurns(state).map((turn) => turn.status)).toEqual([
          "completed",
        ]);
        expect(state.items.find((item) => item.id === itemId)?.status).toBe(
          "completed",
        );
        const reply = state.items.find(
          (item) => item.kind === "assistant_message",
        );
        expect(reply?.kind === "assistant_message" && reply.text).toContain(
          "Steered: and the docs",
        );
      },
      { timeout: 15_000 },
    );
  });

  it("stops the agent's step to read a steered message now, in the same turn", async () => {
    const { projectId, sessionId } = await chat("Steer now");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[hang]]",
    });
    await running(projectId, sessionId);
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "use the blue one",
    });
    const itemId = String(sent.result?.itemId);
    const now = await sessions.command(identity, projectId, sessionId, {
      type: "steer_now",
      commandId: randomUUID(),
      itemId,
    });
    expect(now.status).toBe("accepted");
    await vi.waitFor(
      async () => {
        const state = await folded(projectId, sessionId);
        expect(orderedTurns(state).map((turn) => turn.status)).toEqual([
          "completed",
        ]);
        expect(state.items.find((item) => item.id === itemId)?.status).toBe(
          "completed",
        );
      },
      { timeout: 20_000 },
    );
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .select(["reason", "status"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal")
      .execute();
    expect(attempts).toEqual([
      { reason: "initial", status: "superseded" },
      { reason: "steer_restart", status: "completed" },
    ]);
    const replies = (await folded(projectId, sessionId)).items.flatMap(
      (item) => (item.kind === "assistant_message" ? [item.text] : []),
    );
    expect(replies.join("\n").split("use the blue one")).toHaveLength(2);
    // Read now, there is nothing left to stop for: nothing changes.
    const again = await sessions.command(identity, projectId, sessionId, {
      type: "steer_now",
      commandId: randomUUID(),
      itemId,
    });
    expect(again).toMatchObject({
      status: "accepted",
      result: { interrupted: false },
    });
  }, 40_000);

  it("starts the turn's input over when the person stops an attempt that never began", async () => {
    const { projectId, sessionId } = await chat("Never began");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[slow-start 5000]] [[defer-steers]] [[wait 200]] build the page",
    });
    await running(projectId, sessionId);
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "and the footer",
    });
    const itemId = String(sent.result?.itemId);
    const now = await sessions.command(identity, projectId, sessionId, {
      type: "steer_now",
      commandId: randomUUID(),
      itemId,
    });
    expect(now.result).toMatchObject({ interrupted: true });
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await folded(projectId, sessionId)).map(
            (turn) => turn.status,
          ),
        ).toEqual(["completed"]),
      { timeout: 20_000 },
    );
    const replies = (await folded(projectId, sessionId)).items.flatMap(
      (item) => (item.kind === "assistant_message" ? [item.text] : []),
    );
    // Its thread never had the input: it starts over, the message after it.
    expect(replies.join("\n")).toContain("build the page and the footer");
  }, 40_000);

  it("reads a message the attempt never read with the retry of a rate-limited turn", async () => {
    const { projectId, sessionId } = await chat("Steer through a retry");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[rate-limit 1500]]",
    });
    await running(projectId, sessionId);
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "and the docs",
    });
    const itemId = String(sent.result?.itemId);
    await vi.waitFor(
      async () => {
        const [turn] = orderedTurns(await folded(projectId, sessionId));
        expect(turn?.retryAt).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    // Its backoff is over: a worker runs the retry.
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("session_id", "=", sessionId)
      .execute();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 20,
    });
    try {
      await vi.waitFor(
        async () => {
          const state = await folded(projectId, sessionId);
          expect(orderedTurns(state).map((turn) => turn.status)).toEqual([
            "completed",
          ]);
          expect(state.items.find((item) => item.id === itemId)?.status).toBe(
            "completed",
          );
          const reply = state.items.find(
            (item) => item.kind === "assistant_message",
          );
          expect(reply?.kind === "assistant_message" && reply.text).toContain(
            "and the docs",
          );
        },
        { timeout: 15_000 },
      );
    } finally {
      await worker.stop();
    }
  }, 40_000);

  it("runs a message a turn waiting to retry never read as its own once the person stops it", async () => {
    const { projectId, sessionId } = await chat("Stop while waiting to retry");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[rate-limit 800]]",
    });
    await running(projectId, sessionId);
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "check the footer",
    });
    const itemId = String(sent.result?.itemId);
    await vi.waitFor(
      async () => {
        const [turn] = orderedTurns(await folded(projectId, sessionId));
        expect(turn).toMatchObject({ status: "queued" });
        expect(turn?.retryAt).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, projectId, sessionId, {
      type: "interrupt",
      commandId: randomUUID(),
    });
    await vi.waitFor(
      async () => {
        const state = await folded(projectId, sessionId);
        const turns = orderedTurns(state);
        expect(turns.map((turn) => turn.status)).toEqual([
          "interrupted",
          "completed",
        ]);
        expect(turns[1]?.inputItemId).toBe(itemId);
        expect(state.items.find((item) => item.id === itemId)?.status).toBe(
          "completed",
        );
      },
      { timeout: 15_000 },
    );
  }, 30_000);

  it("carries on when the steer it stopped for was read meanwhile", async () => {
    const { projectId, sessionId } = await chat("Read meanwhile");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[read-on-stop]] [[hang]]",
    });
    await running(projectId, sessionId);
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "small thing",
    });
    // The attempt the person stops reads it as it stops.
    const itemId = String(sent.result?.itemId);
    await sessions.command(identity, projectId, sessionId, {
      type: "steer_now",
      commandId: randomUUID(),
      itemId,
    });
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await folded(projectId, sessionId)).map(
            (turn) => turn.status,
          ),
        ).toEqual(["completed"]),
      { timeout: 20_000 },
    );
    const replies = (await folded(projectId, sessionId)).items.flatMap(
      (item) => (item.kind === "assistant_message" ? [item.text] : []),
    );
    // It goes on, never handed the turn's own input (and its hang) again.
    expect(replies.join("\n")).toContain("Carry on where you left off.");
  }, 40_000);

  it("runs a notification the stopped turn never read with the turn that stopped it", async () => {
    const { projectId, sessionId } = await chat("Unread notification");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[hang]]",
    });
    await running(projectId, sessionId);
    const notified = await notifyTests(projectId, sessionId, "unit");
    expect(notified.mode).toBe("steer");
    // The person sends now (⌘↵): the working turn stops before it read it.
    const sent = await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "Chips use the same file, right?",
      dispatch: "interrupt",
    });
    await vi.waitFor(
      async () => {
        const turns = orderedTurns(await folded(projectId, sessionId));
        expect(
          turns
            .filter((turn) => turn.status !== "cancelled")
            .map((turn) => turn.status),
        ).toEqual(["interrupted", "completed"]);
      },
      { timeout: 20_000 },
    );
    const state = await folded(projectId, sessionId);
    const asked = String(sent.result?.turnId);
    // Read with the person's turn: nothing is left in the queue for it.
    expect(
      state.items.find((item) => item.id === notified.messageId),
    ).toMatchObject({ turnId: asked, status: "completed" });
    expect(
      orderedTurns(state).filter(
        (turn) => turn.status === "queued" || turn.status === "held",
      ),
    ).toEqual([]);
    const reply = state.items.find(
      (item) => item.kind === "assistant_message" && item.turnId === asked,
    );
    const text = reply?.kind === "assistant_message" ? reply.text : "";
    expect(text).toContain("All passed (unit)");
    expect(text).toContain("Chips use the same file, right?");
  }, 40_000);

  it("runs the notifications a stopped turn never read together, in one turn", async () => {
    const { projectId, sessionId } = await chat("Unread notifications");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[defer-steers]] [[hang]]",
    });
    await running(projectId, sessionId);
    await notifyTests(projectId, sessionId, "unit");
    await notifyTests(projectId, sessionId, "e2e");
    await sessions.command(identity, projectId, sessionId, {
      type: "interrupt",
      commandId: randomUUID(),
    });
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await folded(projectId, sessionId)).map(
            (turn) => turn.status,
          ),
        ).toEqual(["interrupted", "completed"]),
      { timeout: 20_000 },
    );
    const state = await folded(projectId, sessionId);
    const last = orderedTurns(state).at(-1);
    const reply = state.items.find(
      (item) => item.kind === "assistant_message" && item.turnId === last?.id,
    );
    const text = reply?.kind === "assistant_message" ? reply.text : "";
    expect(text.indexOf("All passed (unit)")).toBeGreaterThan(-1);
    expect(text.indexOf("All passed (unit)")).toBeLessThan(
      text.indexOf("All passed (e2e)"),
    );
  }, 40_000);

  it("restarts once with a steer the harness refused, and the agent reads it once", async () => {
    const project = await projects.create(identity, { name: "Stubborn" });
    const session = await sessions.create(identity, project.id, {
      agentId: "stubborn",
    });
    const projectId = project.id;
    const sessionId = session.id;
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 1500]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "also this",
      dispatch: "steer",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns.map((turn) => turn.status)).toEqual([
          "completed",
        ]);
      },
      { timeout: 20_000 },
    );
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .select(["reason", "status"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal")
      .execute();
    expect(attempts).toEqual([
      { reason: "initial", status: "superseded" },
      { reason: "steer_restart", status: "completed" },
    ]);
    const detail = await sessions.get(identity, projectId, sessionId);
    const replies = detail.snapshot.items.flatMap((item) =>
      item.kind === "assistant_message" ? [item.text] : [],
    );
    expect(replies.join("\n").split("also this")).toHaveLength(2);
    const open = await db
      .selectFrom("agent_turn_commands")
      .select("kind")
      .where("turn_id", "=", detail.snapshot.turns[0]?.id ?? "")
      .where("status", "in", ["pending", "sent"])
      .execute();
    expect(open).toEqual([]);
  }, 40_000);

  it("starts the turn's input over on a restart whose earlier attempt never reported its thread", async () => {
    const project = await projects.create(identity, { name: "Forgetful" });
    const session = await sessions.create(identity, project.id, {
      agentId: "forgetful",
    });
    const projectId = project.id;
    const sessionId = session.id;
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 1500]] build the page",
    });
    await running(projectId, sessionId);
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "and the footer",
      dispatch: "steer",
    });
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await folded(projectId, sessionId)).map(
            (turn) => turn.status,
          ),
        ).toEqual(["completed"]),
      { timeout: 20_000 },
    );
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .select(["reason", "status"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal")
      .execute();
    expect(attempts).toEqual([
      { reason: "initial", status: "superseded" },
      { reason: "steer_restart", status: "completed" },
    ]);
    const replies = (await folded(projectId, sessionId)).items.flatMap(
      (item) => (item.kind === "assistant_message" ? [item.text] : []),
    );
    // A fresh thread never had the turn's input: it starts over with it.
    expect(replies.join("\n")).toContain("build the page");
    expect(replies.join("\n")).toContain("and the footer");
  }, 40_000);

  it("runs a turn whose thread is gone again on a new thread, handed the conversation (ADR 0245)", async () => {
    const project = await projects.create(identity, { name: "Amnesiac" });
    const session = await sessions.create(identity, project.id, {
      agentId: "amnesiac",
    });
    const projectId = project.id;
    const sessionId = session.id;
    await sessions.sendMessage(identity, projectId, sessionId, "first words");
    const { reply } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "second words",
    );
    // A new thread, handed what came before, then asked.
    const said = reply?.kind === "assistant_message" ? reply.text : "";
    expect(said).toContain("This conversation started before you joined it");
    expect(said).toContain("Person: first words");
    expect(said).toMatch(/---\s*second words$/);
    const state = await folded(projectId, sessionId);
    expect(orderedTurns(state).map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    const second = orderedTurns(state)[1];
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .select(["reason", "status", "provider_thread_id"])
      .where("turn_id", "=", second?.id ?? "")
      .orderBy("ordinal")
      .execute();
    expect(attempts.map(({ reason, status }) => ({ reason, status }))).toEqual([
      { reason: "initial", status: "failed" },
      { reason: "retry", status: "completed" },
    ]);
    const threads = await db
      .selectFrom("agent_provider_threads")
      .select(["id", "status"])
      .where("session_id", "=", sessionId)
      .orderBy("created_at")
      .execute();
    expect(threads.map((thread) => thread.status)).toEqual([
      "unavailable",
      "active",
    ]);
    expect(attempts[0]?.provider_thread_id).toBe(threads[0]?.id);
    expect(attempts[1]?.provider_thread_id).toBe(threads[1]?.id);
    const items = state.items.filter((item) => item.turnId === second?.id);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "notice",
        code: "thread_lost",
        data: {
          providerThreadId: threads[0]?.id,
          reason: "Its session was deleted.",
        },
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "context_handoff",
        toProviderThreadId: threads[1]?.id,
        coveredTurnOrdinals: { from: 1, to: 1 },
      }),
    );
  });

  it("never resumes a replacement the harness opened for a lost thread: the next turn is handed everything", async () => {
    const project = await projects.create(identity, { name: "Midway" });
    const session = await sessions.create(identity, project.id, {
      agentId: "amnesiac",
    });
    const projectId = project.id;
    const sessionId = session.id;
    await sessions.sendMessage(identity, projectId, sessionId, "first words");
    // Lost, then carried on in a replacement: the turn ends as it does.
    const { reply } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[lost-midway]] second words",
    );
    expect(reply?.kind === "assistant_message" && reply.text).toContain(
      "second words",
    );
    await sessions.sendMessage(identity, projectId, sessionId, "third words");
    const state = await folded(projectId, sessionId);
    const [, , third] = orderedTurns(state);
    // The third turn resumed nothing: a new thread, handed both before it.
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .select(["reason", "status"])
      .where("turn_id", "=", third?.id ?? "")
      .execute();
    expect(attempts).toEqual([{ reason: "initial", status: "completed" }]);
    const threads = await db
      .selectFrom("agent_provider_threads")
      .select("status")
      .where("session_id", "=", sessionId)
      .orderBy("created_at")
      .execute();
    expect(threads.map((thread) => thread.status)).toEqual([
      "unavailable",
      "active",
    ]);
    expect(state.items).toContainEqual(
      expect.objectContaining({
        turnId: third?.id,
        kind: "context_handoff",
        coveredTurnOrdinals: { from: 1, to: 2 },
      }),
    );
  });

  it("runs a turn again on a new thread once, never in a loop", async () => {
    const project = await projects.create(identity, { name: "Doomed" });
    const session = await sessions.create(identity, project.id, {
      agentId: "amnesiac",
    });
    const projectId = project.id;
    const sessionId = session.id;
    await sessions.sendMessage(identity, projectId, sessionId, "first words");
    await sessions
      .sendMessage(identity, projectId, sessionId, "[[always-lost]] again")
      .catch(() => undefined);
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await folded(projectId, sessionId)).map(
            (turn) => turn.status,
          ),
        ).toEqual(["completed", "failed"]),
      { timeout: 15_000 },
    );
    const second = orderedTurns(await folded(projectId, sessionId))[1];
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .select(["reason", "status"])
      .where("turn_id", "=", second?.id ?? "")
      .orderBy("ordinal")
      .execute();
    expect(attempts).toEqual([
      { reason: "initial", status: "failed" },
      { reason: "retry", status: "failed" },
    ]);
  });

  it("settles a turn with what its harness stored on the way out", async () => {
    const { projectId, sessionId } = await chat("Late");
    const first = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "remember this [[late]]",
    );
    expect(first.turn.status).toBe("completed");
    // Stored by the time the turn settled, so the thread resumes anywhere.
    const thread = await db
      .selectFrom("agent_provider_threads")
      .select("id")
      .where("session_id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const stored = await db
      .selectFrom("agent_provider_thread_entries")
      .select("entry")
      .where("thread_id", "=", thread.id)
      .orderBy("seq")
      .execute();
    expect(stored.map((row) => row.entry)).toEqual([
      { turn: 1, text: "remember this [[late]]" },
    ]);
    // Exactly as written, key order included: a resumed harness sends its
    // model this history, and a reordered one misses the prompt cache.
    expect(JSON.stringify(stored[0]?.entry)).toBe(
      '{"turn":1,"text":"remember this [[late]]"}',
    );
    const second = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "again",
    );
    expect(
      second.reply?.kind === "assistant_message" && second.reply.text,
    ).toBe("Echo: again (turn 2)");
  });

  it("names the native turn a resumed thread ends with", async () => {
    const project = await projects.create(identity, { name: "Last turn" });
    const session = await sessions.create(identity, project.id, {
      agentId: "recording",
    });
    bindings.length = 0;
    await sessions.sendMessage(identity, project.id, session.id, "one");
    await sessions.sendMessage(identity, project.id, session.id, "two");
    const [first, second] = bindings;
    expect(first?.mode).toBe("fresh");
    const recorded = await db
      .selectFrom("agent_turn_attempts")
      .select("native_turn_ref")
      .where("session_id", "=", session.id)
      .orderBy("created_at")
      .executeTakeFirstOrThrow();
    // A harness kept warm since the first turn checks it ran that turn.
    expect(
      second?.mode === "resume" || second?.mode === "restore"
        ? second.lastTurnRef
        : undefined,
    ).toEqual(recorded.native_turn_ref);
    expect(recorded.native_turn_ref).toBeTruthy();
  });

  it("restarts for a refused steer on what the interrupted attempt stored on the way out", async () => {
    const project = await projects.create(identity, { name: "Late steer" });
    const session = await sessions.create(identity, project.id, {
      agentId: "stubborn",
    });
    await sessions.command(identity, project.id, session.id, {
      type: "send",
      commandId: randomUUID(),
      text: "[[hang]] [[late]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, project.id, session.id, {
      type: "send",
      commandId: randomUUID(),
      text: "also this",
      dispatch: "steer",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        expect(detail.snapshot.turns.map((turn) => turn.status)).toEqual([
          "completed",
        ]);
      },
      { timeout: 20_000 },
    );
    const detail = await sessions.get(identity, project.id, session.id);
    const replies = detail.snapshot.items.flatMap((item) =>
      item.kind === "assistant_message" ? [item.text] : [],
    );
    // The new attempt resumed the thread with the interrupted one in it.
    expect(replies.at(-1)).toContain("(turn 2)");
  }, 40_000);

  it("settles a turn whose harness never exits, refusing its late tool call", async () => {
    const project = await projects.create(identity, { name: "Lingering" });
    const session = await sessions.create(identity, project.id, {
      agentId: "lingering",
    });
    const started = Date.now();
    const { turn } = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "finish and stay",
    );
    expect(turn.status).toBe("completed");
    // Answered until the grace ran out, then ended.
    expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
    expect(lateTools).toEqual([
      "This turn already ended, so the tool did not run.",
    ]);
  }, 40_000);

  it("keeps a turn on its owner's sign-in to the owner's words (ADR 0199)", async () => {
    const { projectId, sessionId } = await chat("OwnerOnly");
    const admin: Identity = { ...identity, externalUserId: "admin" };
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 2000]]",
    });
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "then this",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    // As preparation records it for a sign-in or personal files.
    const running = (await sessions.get(identity, projectId, sessionId))
      .snapshot.turns[0];
    await db
      .updateTable("agent_turn_attempts")
      .set({ runner: sql`runner || '{"ownerOnly": true}'::jsonb` })
      .where("id", "=", running?.activeAttemptId ?? "")
      .execute();
    // Someone else's steer waits for a turn of its own.
    await sessions.command(admin, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "from the admin",
      dispatch: "steer",
    });
    const detail = await sessions.get(identity, projectId, sessionId);
    const adminItem = detail.snapshot.items.find(
      (item) => item.kind === "user_message" && item.text === "from the admin",
    );
    expect(adminItem?.turnId).not.toBe(running?.id);
    expect(adminItem?.kind === "user_message" && adminItem.dispatch).toBe(
      "queue",
    );
    // Nor can they put words in the owner's queued message.
    const queued = detail.snapshot.turns.find(
      (turn) => turn.status === "queued",
    );
    const edit = await sessions.command(admin, projectId, sessionId, {
      type: "edit_queued",
      commandId: randomUUID(),
      turnId: queued?.id ?? "",
      text: "rewritten",
    });
    expect(edit).toMatchObject({
      status: "rejected",
      error: { code: "not_author" },
    });
    await sessions.command(identity, projectId, sessionId, {
      type: "interrupt",
      commandId: randomUUID(),
    });
  }, 30_000);

  it("takes an answer to an owner-only turn's question from its owner alone", async () => {
    const { projectId, sessionId } = await chat("OwnerAnswers");
    const admin: Identity = { ...identity, externalUserId: "admin" };
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[ask Ship it?]]",
    });
    const pending = async () =>
      (
        await sessions.get(identity, projectId, sessionId)
      ).snapshot.requests.find((request) => request.status === "pending");
    await vi.waitFor(async () => expect(await pending()).toBeDefined(), {
      timeout: 10_000,
    });
    const request = await pending();
    await db
      .updateTable("agent_turn_attempts")
      .set({ runner: sql`runner || '{"ownerOnly": true}'::jsonb` })
      .where("id", "=", request?.attemptId ?? "")
      .execute();
    const refused = await sessions.command(admin, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request?.id ?? "",
      response: { kind: "question", answers: ["Yes"] },
    });
    expect(refused).toMatchObject({
      status: "rejected",
      error: { code: "owner_only" },
    });
    const answered = await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request?.id ?? "",
      response: { kind: "question", answers: ["Yes"] },
    });
    expect(answered.status).toBe("accepted");
  }, 30_000);

  it("keeps a held message's place: what was queued after it waits", async () => {
    const { projectId, sessionId } = await chat("Held");
    const send = (text: string) =>
      sessions.command(identity, projectId, sessionId, {
        type: "send",
        commandId: randomUUID(),
        text,
        dispatch: "queue",
      });
    await send("[[wait 800]] first");
    await send("second");
    await send("third");
    const turns = async () =>
      (await sessions.get(identity, projectId, sessionId)).snapshot.turns
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal);
    const second = (await turns())[1];
    await sessions.command(identity, projectId, sessionId, {
      type: "edit_queued",
      commandId: randomUUID(),
      turnId: second?.id ?? "",
      held: true,
    });
    await vi.waitFor(
      async () => expect((await turns())[0]?.status).toBe("completed"),
      { timeout: 10_000 },
    );
    // The first turn is done; the third still waits behind the held one.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await turns()).map((turn) => turn.status)).toEqual([
      "completed",
      "held",
      "queued",
    ]);
    await sessions.command(identity, projectId, sessionId, {
      type: "edit_queued",
      commandId: randomUUID(),
      turnId: second?.id ?? "",
      text: "second, edited",
      held: false,
    });
    await vi.waitFor(
      async () =>
        expect((await turns()).map((turn) => turn.status)).toEqual([
          "completed",
          "completed",
          "completed",
        ]),
      { timeout: 10_000 },
    );
    const [, edited, last] = await turns();
    expect(Date.parse(edited?.startedAt ?? "")).toBeLessThan(
      Date.parse(last?.startedAt ?? ""),
    );
  }, 30_000);

  it("ends a turn stopped while it restarts for a refused steer, and runs the steer after it", async () => {
    const project = await projects.create(identity, { name: "StopRestart" });
    const session = await sessions.create(identity, project.id, {
      agentId: "stubborn",
    });
    const projectId = project.id;
    const sessionId = session.id;
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 1500]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "steered while stopping",
      dispatch: "steer",
    });
    await sessions.command(identity, projectId, sessionId, {
      type: "interrupt",
      commandId: randomUUID(),
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const turns = detail.snapshot.turns
          .slice()
          .sort((a, b) => a.ordinal - b.ordinal);
        expect(turns.map((turn) => turn.status)).toEqual([
          "interrupted",
          "completed",
        ]);
      },
      { timeout: 20_000 },
    );
    const attempts = await db
      .selectFrom("agent_turn_attempts")
      .innerJoin("agent_turns", "agent_turns.id", "agent_turn_attempts.turn_id")
      .select(["agent_turns.ordinal", "agent_turn_attempts.reason"])
      .where("agent_turn_attempts.session_id", "=", sessionId)
      .orderBy("agent_turns.ordinal")
      .execute();
    // No restart of the stopped turn; the steer ran as a turn of its own.
    expect(attempts.map((attempt) => attempt.reason)).toEqual([
      "initial",
      "initial",
    ]);
  }, 40_000);

  it("never takes a person's message from the harness", async () => {
    const project = await projects.create(identity, { name: "Forger" });
    const session = await sessions.create(identity, project.id, {
      agentId: "forger",
    });
    const { reply } = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "my own words",
    );
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Echo: my own words",
    );
    const detail = await sessions.get(identity, project.id, session.id);
    const messages = detail.snapshot.items.flatMap((item) =>
      item.kind === "user_message"
        ? [{ text: item.text, author: item.author }]
        : [],
    );
    expect(messages).toEqual([
      {
        text: "my own words",
        author: { kind: "user", externalUserId: identity.externalUserId },
      },
    ]);
  });

  it("switches the agent right after a reply, while the turn only finalizes", async () => {
    const { projectId, sessionId } = await chat("SwitchAfterReply");
    const { turn } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "hello",
    );
    // As on a slow machine: the reply is in, the checkpoint still saving.
    const holdAs = (status: string) =>
      db
        .updateTable("agent_turns")
        .set({
          status,
          lease_expires_at: sql<Date>`now() + interval '1 minute'`,
        })
        .where("id", "=", turn.id)
        .execute();
    await holdAs("finalizing");
    const settle = setTimeout(() => {
      void db
        .updateTable("agent_turns")
        .set({ status: "completed", lease_expires_at: null })
        .where("id", "=", turn.id)
        .execute();
    }, 300);
    try {
      const updated = await sessions.update(identity, projectId, sessionId, {
        agentId: "guarded",
      });
      expect(updated.agentId).toBe("guarded");
    } finally {
      clearTimeout(settle);
    }
    // A turn still working is refused at once, as before.
    await holdAs("running");
    await expect(
      sessions.update(identity, projectId, sessionId, { agentId: "echo" }),
    ).rejects.toThrow("in progress");
    await db
      .updateTable("agent_turns")
      .set({ status: "completed", lease_expires_at: null })
      .where("id", "=", turn.id)
      .execute();
  });

  it("switches harnesses in one session, handing over history and resuming each native thread", async () => {
    const { projectId, sessionId } = await chat("SwitchHarness");
    await sessions.sendMessage(identity, projectId, sessionId, "first words");
    const first = await folded(projectId, sessionId);
    const originalThread = orderedTurns(first)[0]?.providerThreadId;
    await sessions.update(identity, projectId, sessionId, {
      model: "old-model",
      effort: "high",
    });
    const switched = await sessions.update(identity, projectId, sessionId, {
      agentId: "elsewhere",
    });
    expect(switched).toMatchObject({
      id: sessionId,
      agentId: "elsewhere",
      model: null,
      modelEffort: null,
    });
    const second = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "second words",
    );
    expect(second.turn.status).toBe("completed");
    expect(
      second.reply?.kind === "assistant_message" && second.reply.text,
    ).toContain("Person: first words");
    const away = await folded(projectId, sessionId);
    expect(away.session.harness).toBe("elsewhere");
    const awayThread = orderedTurns(away)[1]?.providerThreadId;
    expect(awayThread).not.toBe(originalThread);
    await sessions.update(identity, projectId, sessionId, { agentId: "echo" });
    const third = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "third words",
    );
    expect(third.turn.status).toBe("completed");
    expect(
      third.reply?.kind === "assistant_message" && third.reply.text,
    ).toContain("Person: second words");
    const back = await folded(projectId, sessionId);
    expect(back.session.harness).toBe("echo");
    expect(orderedTurns(back)[2]?.providerThreadId).toBe(originalThread);
    expect(
      back.items.filter((item) => item.kind === "context_handoff"),
    ).toMatchObject([
      {
        strategy: "full",
        coveredTurnOrdinals: { from: 1, to: 1 },
        toProviderThreadId: awayThread,
      },
      {
        strategy: "delta",
        coveredTurnOrdinals: { from: 2, to: 2 },
        toProviderThreadId: originalThread,
      },
    ]);
  });

  it("hands over earlier context again when the new harness made a thread but could not start", async () => {
    const { projectId, sessionId } = await chat("Failed first harness turn");
    await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "earlier conversation",
    );
    await sessions.update(identity, projectId, sessionId, {
      agentId: "elsewhere",
    });
    const refused = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[reject-before-start]]",
    );
    expect(refused.turn.status).toBe("failed");
    const empty = await db
      .selectFrom("agent_provider_threads")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("harness", "=", "elsewhere")
      .executeTakeFirstOrThrow();
    expect(empty.native_ref).not.toBeNull();
    expect(empty.last_turn_ordinal).toBeNull();
    const fork = await sessions.fork(identity, projectId, sessionId, {});
    const forked = await sessions.sendMessage(
      identity,
      projectId,
      fork.id,
      "continue the failed-start fork",
    );
    expect(forked.turn.status).toBe("completed");
    expect(
      forked.reply?.kind === "assistant_message" && forked.reply.text,
    ).toContain("Person: earlier conversation");

    const resumed = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "try now",
    );
    expect(resumed.turn.status).toBe("completed");
    expect(resumed.turn.providerThreadId).toBe(empty.id);
    const afterResume = await folded(projectId, sessionId);
    const failedMessage = afterResume.items.find(
      (item) => item.turnId === refused.turn.id && item.kind === "user_message",
    );
    if (!failedMessage) throw new Error("Expected the failed turn's message");
    const historicalFork = await sessions.fork(identity, projectId, sessionId, {
      messageId: failedMessage.id,
    });
    const historical = await sessions.sendMessage(
      identity,
      projectId,
      historicalFork.id,
      "continue only through the failed turn",
    );
    expect(historical.turn.status).toBe("completed");
    expect(
      historical.reply?.kind === "assistant_message" && historical.reply.text,
    ).toContain("Person: earlier conversation");
    expect(
      historical.reply?.kind === "assistant_message" && historical.reply.text,
    ).not.toContain("Person: try now");
    expect(
      resumed.reply?.kind === "assistant_message" && resumed.reply.text,
    ).toContain("Person: earlier conversation");
    expect((await folded(projectId, sessionId)).items).toContainEqual(
      expect.objectContaining({
        kind: "context_handoff",
        turnId: resumed.turn.id,
        strategy: "full",
        coveredTurnOrdinals: { from: 1, to: 2 },
      }),
    );
  });

  it("does not advance native coverage when the new harness stops before starting", async () => {
    const { projectId, sessionId } = await chat(
      "Interrupted first harness turn",
    );
    await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "earlier conversation",
    );
    await sessions.update(identity, projectId, sessionId, {
      agentId: "interrupted-start",
    });
    const stopped = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[interrupt-before-start]]",
    );
    expect(stopped.turn.status).toBe("interrupted");
    const empty = await db
      .selectFrom("agent_provider_threads")
      .select("last_turn_ordinal")
      .where("session_id", "=", sessionId)
      .where("harness", "=", "elsewhere")
      .executeTakeFirstOrThrow();
    expect(empty.last_turn_ordinal).toBeNull();
    const resumed = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "try after stopping",
    );
    expect(resumed.turn.status).toBe("completed");
    expect(
      resumed.reply?.kind === "assistant_message" && resumed.reply.text,
    ).toContain("Person: earlier conversation");
  });

  it("lets a fork switch harnesses while its source keeps its agent and thread", async () => {
    const { projectId, sessionId } = await chat("ForkHarness");
    await sessions.sendMessage(identity, projectId, sessionId, "hello");
    const fork = await sessions.fork(identity, projectId, sessionId, {});
    expect(fork.harness).toBe("echo");
    await sessions.update(identity, projectId, fork.id, {
      agentId: "elsewhere",
    });
    const { turn, reply } = await sessions.sendMessage(
      identity,
      projectId,
      fork.id,
      "continue the fork",
    );
    expect(turn.status).toBe("completed");
    expect(reply?.kind === "assistant_message" && reply.text).toContain(
      "Person: hello",
    );
    expect((await folded(projectId, fork.id)).session.harness).toBe(
      "elsewhere",
    );
    expect((await folded(projectId, sessionId)).session.harness).toBe("echo");
    await sessions.update(identity, projectId, fork.id, { agentId: "echo" });
    const returned = await sessions.sendMessage(
      identity,
      projectId,
      fork.id,
      "back to the fork's source harness",
    );
    expect(returned.turn.status).toBe("completed");
    expect(
      returned.reply?.kind === "assistant_message" && returned.reply.text,
    ).toContain("Person: continue the fork");
    expect((await folded(projectId, fork.id)).items).toContainEqual(
      expect.objectContaining({
        kind: "context_handoff",
        strategy: "delta",
        coveredTurnOrdinals: { from: 2, to: 2 },
      }),
    );
  });

  it("hands the conversation to a harness changed in its agent definition", async () => {
    const { projectId, sessionId } = await chat("MovedHarness");
    await sessions.sendMessage(identity, projectId, sessionId, "hello");
    await db
      .updateTable("agent_sessions")
      .set({ agent_id: "elsewhere" })
      .where("id", "=", sessionId)
      .execute();
    const { turn, reply } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "still there?",
    );
    expect(turn.status).toBe("completed");
    expect(reply?.kind === "assistant_message" && reply.text).toContain(
      "Person: hello",
    );
    expect((await folded(projectId, sessionId)).session.harness).toBe(
      "elsewhere",
    );
  });

  it("fails a turn on an agent that cannot run with its reason, binding nothing", async () => {
    const { projectId, sessionId } = await chat("Blocked");
    await sessions.update(identity, projectId, sessionId, {
      agentId: "blocked",
    });
    const { turn } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "hello",
    );
    expect(turn.status).toBe("failed");
    expect(turn.error?.message).toBe("Approve this agent first.");
    const detail = await sessions.get(identity, projectId, sessionId);
    expect(detail.snapshot.session.harness).toBeNull();
    // Nothing bound it: any agent can still take the chat.
    const moved = await sessions.update(identity, projectId, sessionId, {
      agentId: "elsewhere",
    });
    expect(moved.agentId).toBe("elsewhere");
  });

  it("streams the gap after a cursor, then live events, in order", async () => {
    const { projectId, sessionId } = await chat("Stream");
    await sessions.sendMessage(identity, projectId, sessionId, "first");
    const detail = await sessions.get(identity, projectId, sessionId);
    let state = sessionStateFromSnapshot(detail.snapshot);
    const received: SessionStreamMessage[] = [];
    const stop = await sessions.subscribe(identity, projectId, sessionId, {
      after: 1,
      send: (message) => {
        received.push(message);
        if (message.type === "events")
          state = applySessionEvents(state, message.events);
        return true;
      },
      onClose: () => {},
    });
    try {
      await sessions.sendMessage(identity, projectId, sessionId, "second");
      await vi.waitFor(
        () => {
          const turns = orderedTurns(state);
          expect(turns.map((turn) => turn.status)).toEqual([
            "completed",
            "completed",
          ]);
          expect(state.stale).toBe(false);
        },
        { timeout: 10_000 },
      );
    } finally {
      stop();
    }
    const sequences = received.flatMap((message) =>
      message.type === "events" ? message.events.map((e) => e.sequence) : [],
    );
    expect(sequences[0]).toBe(2);
    expect(sequences).toEqual(
      sequences.map((_, index) => (sequences[0] ?? 0) + index),
    );
  });

  it("forks settled history into a new session that continues on its own", async () => {
    const { projectId, sessionId } = await chat("Fork");
    await sessions.sendMessage(identity, projectId, sessionId, "one");
    await sessions.sendMessage(identity, projectId, sessionId, "two");
    const source = await sessions.get(identity, projectId, sessionId);
    const firstReply = source.snapshot.items.find(
      (item) => item.kind === "assistant_message",
    );
    const fork = await sessions.fork(identity, projectId, sessionId, {
      messageId: firstReply?.id ?? "",
    });
    const forked = await sessions.get(identity, projectId, fork.id);
    expect(forked.snapshot.turns).toHaveLength(1);
    expect(
      forked.snapshot.items.some(
        (item) => item.kind === "notice" && item.code === "session_fork",
      ),
    ).toBe(true);
    const { reply } = await sessions.sendMessage(
      identity,
      projectId,
      fork.id,
      "three",
    );
    // The fork's own conversation starts from the source's, through the
    // fork point: one turn, so this is its second.
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Echo: three (turn 2)",
    );
    const { reply: next } = await sessions.sendMessage(
      identity,
      projectId,
      fork.id,
      "four",
    );
    expect(next?.kind === "assistant_message" && next.text).toBe(
      "Echo: four (turn 3)",
    );
    // The source is untouched.
    const after = await sessions.get(identity, projectId, sessionId);
    expect(after.snapshot.turns).toHaveLength(2);
  });

  it("fails a turn the harness fails, with its reason", async () => {
    const { projectId, sessionId } = await chat("Failure");
    const { turn } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[fail Credentials revoked]]",
    );
    expect(turn.status).toBe("failed");
    expect(turn.error?.message).toContain("Credentials revoked");
  });

  it("never hands a thread back a turn it began, however that turn ended", async () => {
    const { projectId, sessionId } = await chat("Failed after working");
    await sessions.sendMessage(identity, projectId, sessionId, "first words");
    // The harness began it and did the work, then failed (a weekly limit).
    const failed = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[fail Weekly limit reached]]",
    );
    expect(failed.turn.status).toBe("failed");
    const { reply } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "third words",
    );
    const said = reply?.kind === "assistant_message" ? reply.text : "";
    expect(said).not.toContain("While you were away");
    expect(said).toContain("third words");
    const state = await folded(projectId, sessionId);
    expect(state.items.map((item) => item.kind)).not.toContain(
      "context_handoff",
    );
    const threads = await db
      .selectFrom("agent_provider_threads")
      .select("last_turn_ordinal")
      .where("session_id", "=", sessionId)
      .execute();
    expect(threads.map((thread) => thread.last_turn_ordinal)).toEqual([3]);
  });

  describe("a sign-in that can still refresh (ADR 0228)", () => {
    async function signInChat(name: string) {
      const project = await projects.create(identity, { name });
      const session = await sessions.create(identity, project.id, {
        agentId: "signed-in",
      });
      return { projectId: project.id, sessionId: session.id };
    }
    async function attemptsOf(turnId: string) {
      return db
        .selectFrom("agent_turn_attempts")
        .select(["reason", "status", "error"])
        .where("turn_id", "=", turnId)
        .orderBy("ordinal")
        .execute();
    }

    it("retries once, quietly, and the turn reads as if nothing failed", async () => {
      signIn.refreshable = true;
      signIn.afterMs = 50;
      signIn.asked = 0;
      const { projectId, sessionId } = await signInChat("Sign-in passing");
      const { turn, reply } = await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        "sign-in 1",
      );
      expect(turn.status).toBe("completed");
      expect(turn.error).toBeNull();
      expect(reply?.kind === "assistant_message" && reply.text).toContain(
        "Echo: sign-in 1",
      );
      expect(signIn.asked).toBe(1);
      const attempts = await attemptsOf(turn.id);
      expect(attempts.map(({ reason, status }) => [reason, status])).toEqual([
        ["initial", "failed"],
        ["retry", "completed"],
      ]);
      // Meanwhile the turn stayed active, saying what it did; it never
      // showed the failure.
      const events = await db
        .selectFrom("agent_session_events")
        .select("payload")
        .where("session_id", "=", sessionId)
        .orderBy("sequence")
        .execute();
      const turnStates = events
        .map((row) => row.payload as unknown as SessionEvent)
        .flatMap((event) =>
          event.type === "turn.changed" ? [event.turn] : [],
        );
      expect(
        turnStates.some(
          (state) =>
            state.status === "preparing" &&
            state.activity === "Reconnecting to Claude…",
        ),
      ).toBe(true);
      expect(turnStates.some((state) => state.error !== null)).toBe(false);
    });

    it("fails with the sign-in error when the one retry fails too, and a retry by hand is not retried again", async () => {
      signIn.refreshable = true;
      signIn.afterMs = 50;
      signIn.asked = 0;
      const { projectId, sessionId } = await signInChat("Sign-in stuck");
      const { turn } = await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        "sign-in 3",
      );
      expect(turn.status).toBe("failed");
      expect(turn.error).toMatchObject({ kind: "auth", retrySafe: true });
      expect(signIn.asked).toBe(1);
      expect((await attemptsOf(turn.id)).map(({ reason }) => reason)).toEqual([
        "initial",
        "retry",
      ]);
      // The person's own retry runs once more, without a quiet one.
      await sessions.command(identity, projectId, sessionId, {
        type: "retry",
        commandId: randomUUID(),
        turnId: turn.id,
      });
      await vi.waitFor(
        async () => {
          const detail = await sessions.get(identity, projectId, sessionId);
          const [settled] = orderedTurns(
            sessionStateFromSnapshot(detail.snapshot),
          );
          expect(settled?.status).toBe("failed");
          expect(settled?.attemptCount).toBe(3);
        },
        { timeout: 10_000 },
      );
      expect(signIn.asked).toBe(1);
      expect((await attemptsOf(turn.id)).map(({ status }) => status)).toEqual([
        "failed",
        "failed",
        "failed",
      ]);
    });

    it("fails at once when the host says the sign-in cannot refresh", async () => {
      signIn.refreshable = false;
      signIn.asked = 0;
      const { projectId, sessionId } = await signInChat("Sign-in expired");
      const { turn } = await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        "sign-in 1",
      );
      expect(turn.status).toBe("failed");
      expect(turn.error?.kind).toBe("auth");
      expect(signIn.asked).toBe(1);
      expect(await attemptsOf(turn.id)).toHaveLength(1);
      signIn.refreshable = true;
    });

    it("never asks about a failure that is not safe to send again", async () => {
      signIn.refreshable = true;
      signIn.asked = 0;
      const { projectId, sessionId } = await signInChat("Sign-in refused");
      const { turn } = await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        "sign-in 1 refused",
      );
      expect(turn.status).toBe("failed");
      expect(signIn.asked).toBe(0);
      expect(await attemptsOf(turn.id)).toHaveLength(1);
    });

    it("ends the turn interrupted when the person stops it during the pause", async () => {
      signIn.refreshable = true;
      signIn.afterMs = 30_000;
      const { projectId, sessionId } = await signInChat("Sign-in stopped");
      await sessions.command(identity, projectId, sessionId, {
        type: "send",
        commandId: randomUUID(),
        text: "sign-in 1",
      });
      const pausing = await vi.waitFor(
        async () => {
          const detail = await sessions.get(identity, projectId, sessionId);
          const [turn] = orderedTurns(
            sessionStateFromSnapshot(detail.snapshot),
          );
          expect(turn?.status).toBe("preparing");
          expect(turn?.activity).toBe("Reconnecting to Claude…");
          return turn;
        },
        { timeout: 10_000 },
      );
      await sessions.command(identity, projectId, sessionId, {
        type: "interrupt",
        commandId: randomUUID(),
      });
      await vi.waitFor(
        async () => {
          const detail = await sessions.get(identity, projectId, sessionId);
          const [turn] = orderedTurns(
            sessionStateFromSnapshot(detail.snapshot),
          );
          expect(turn).toMatchObject({
            id: pausing?.id,
            status: "interrupted",
          });
        },
        { timeout: 5_000 },
      );
      expect(await attemptsOf(pausing?.id ?? "")).toHaveLength(1);
      signIn.afterMs = 50;
    });

    it("lets the turn go at once when its lease is lost during the pause, for its next holder to retry", async () => {
      signIn.refreshable = true;
      signIn.afterMs = 30_000;
      const { projectId, sessionId } = await signInChat("Sign-in lease lost");
      await sessions.command(identity, projectId, sessionId, {
        type: "send",
        commandId: randomUUID(),
        text: "sign-in 1",
      });
      const pausing = await vi.waitFor(
        async () => {
          const detail = await sessions.get(identity, projectId, sessionId);
          const [turn] = orderedTurns(
            sessionStateFromSnapshot(detail.snapshot),
          );
          expect(turn?.activity).toBe("Reconnecting to Claude…");
          return turn;
        },
        { timeout: 10_000 },
      );
      const turnId = pausing?.id ?? "";
      const engine: unknown = Reflect.get(sessions, "engine");
      if (!(engine instanceof TurnEngine)) throw new Error("No turn engine");
      expect(engine.runningTurnIds()).toContain(turnId);
      // Its replica loses the lease, as when it is cut off: it stops
      // holding the turn well before the pause would have ended.
      await db
        .updateTable("agent_turns")
        .set({
          lease_owner: "gone",
          lease_expires_at: new Date(Date.now() - 1_000),
        })
        .where("id", "=", turnId)
        .execute();
      await vi.waitFor(
        () => expect(engine.runningTurnIds()).not.toContain(turnId),
        { timeout: 5_000 },
      );
      const survivor = makeService();
      const worker = survivor.startWorker({
        resolveIdentity: async () => identity,
        pollIntervalMs: 200,
      });
      try {
        await vi.waitFor(
          async () => {
            const detail = await survivor.get(identity, projectId, sessionId);
            const [turn] = orderedTurns(
              sessionStateFromSnapshot(detail.snapshot),
            );
            expect(turn?.status).toBe("completed");
          },
          { timeout: 15_000 },
        );
      } finally {
        await worker.stop();
        await survivor.stopLocalTurns();
        signIn.afterMs = 50;
      }
      expect(
        (await attemptsOf(turnId)).map(({ reason, status }) => [
          reason,
          status,
        ]),
      ).toEqual([
        ["initial", "failed"],
        ["retry", "completed"],
      ]);
    }, 40_000);

    it("waits a minute at most, and not at all for an answer that is no number", () => {
      expect(hostRetryDelay(3_000)).toBe(3_000);
      expect(hostRetryDelay(Number.POSITIVE_INFINITY)).toBe(60_000);
      expect(hostRetryDelay(-5)).toBe(0);
      expect(hostRetryDelay(Number.NaN)).toBe(0);
    });

    it("runs a host's retry only while its turn is still the chat's latest", async () => {
      signIn.refreshable = false;
      const { projectId, sessionId } = await signInChat("Sign-in overtaken");
      const { turn: failed } = await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        "sign-in 9",
      );
      expect(failed.status).toBe("failed");
      signIn.refreshable = true;
      // The person wrote again before the host's retry came.
      await sessions.sendMessage(identity, projectId, sessionId, "hello");
      const refused = await sessions.command(
        identity,
        projectId,
        sessionId,
        { type: "retry", commandId: randomUUID(), turnId: failed.id },
        { ifLatestTurnId: failed.id },
      );
      expect(refused).toMatchObject({
        status: "rejected",
        error: { code: "not_latest" },
      });
      const detail = await sessions.get(identity, projectId, sessionId);
      expect(
        orderedTurns(sessionStateFromSnapshot(detail.snapshot)).map(
          (turn) => turn.status,
        ),
      ).toEqual(["failed", "completed"]);

      // Still the latest: the retry runs.
      signIn.refreshable = false;
      const { turn: latest } = await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        "sign-in 1",
      );
      expect(latest.status).toBe("failed");
      const accepted = await sessions.command(
        identity,
        projectId,
        sessionId,
        { type: "retry", commandId: randomUUID(), turnId: latest.id },
        { ifLatestTurnId: latest.id },
      );
      expect(accepted.status).toBe("accepted");
      signIn.refreshable = true;
      await vi.waitFor(
        async () => {
          const after = await sessions.get(identity, projectId, sessionId);
          expect(
            orderedTurns(sessionStateFromSnapshot(after.snapshot)).at(-1)
              ?.status,
          ).toBe("completed");
        },
        { timeout: 10_000 },
      );
    });
  });

  it("continues a turn whose runner went away with its holder", async () => {
    const { projectId, sessionId } = await chat("Recovery");
    await sessions.sendMessage(identity, projectId, sessionId, "remember me");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 20000]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(
          orderedTurns(sessionStateFromSnapshot(detail.snapshot))[1]?.status,
        ).toBe("running");
      },
      { timeout: 10_000 },
    );
    // The holder's lease is taken from it, as when its replica dies: it
    // stops and its in-process runner goes with it.
    await db
      .updateTable("agent_turns")
      .set({
        lease_owner: "gone",
        lease_expires_at: new Date(Date.now() - 1_000),
      })
      .where("session_id", "=", sessionId)
      .where("status", "=", "running")
      .execute();
    const survivor = makeService();
    const worker = survivor.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 200,
    });
    try {
      await vi.waitFor(
        async () => {
          const detail = await survivor.get(identity, projectId, sessionId);
          const state = sessionStateFromSnapshot(detail.snapshot);
          const turns = orderedTurns(state);
          expect(turns.map((turn) => turn.status)).toEqual([
            "completed",
            "interrupted",
            "completed",
          ]);
          expect(turns[2]?.continuationOf).toBe(turns[1]?.id);
          expect(
            detail.snapshot.items.some(
              (item) =>
                item.kind === "notice" && item.code === "turn_continued",
            ),
          ).toBe(true);
        },
        { timeout: 20_000 },
      );
    } finally {
      await worker.stop();
      await survivor.stopLocalTurns();
    }
  }, 40_000);

  it("hands every turn back when its host restarts, and the next process continues it", async () => {
    const { projectId, sessionId } = await chat("Restart");
    const restarting = makeService();
    await restarting.sendMessage(identity, projectId, sessionId, "remember me");
    await restarting.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 20000]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await restarting.get(identity, projectId, sessionId);
        expect(
          orderedTurns(sessionStateFromSnapshot(detail.snapshot))[1]?.status,
        ).toBe("running");
      },
      { timeout: 10_000 },
    );
    // A host installing an update: its in-process runner goes with it.
    await restarting.stopLocalTurns({ handBack: "all" });
    const handedBack = await db
      .selectFrom("agent_turns")
      .select(["status", "lease_owner"])
      .where("session_id", "=", sessionId)
      .orderBy("ordinal", "desc")
      .executeTakeFirstOrThrow();
    // Not interrupted here: the turn is the next process's to take.
    expect(handedBack).toEqual({ status: "running", lease_owner: null });
    const commands = await db
      .selectFrom("agent_turn_commands")
      .innerJoin("agent_turns", "agent_turns.id", "agent_turn_commands.turn_id")
      .select("agent_turn_commands.kind")
      .where("agent_turns.session_id", "=", sessionId)
      .execute();
    expect(commands.map((command) => command.kind)).not.toContain("interrupt");

    const next = makeService();
    const worker = next.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 200,
    });
    try {
      await vi.waitFor(
        async () => {
          const detail = await next.get(identity, projectId, sessionId);
          const turns = orderedTurns(sessionStateFromSnapshot(detail.snapshot));
          expect(turns.map((turn) => turn.status)).toEqual([
            "completed",
            "interrupted",
            "completed",
          ]);
          expect(turns[2]?.continuationOf).toBe(turns[1]?.id);
        },
        { timeout: 20_000 },
      );
    } finally {
      await worker.stop();
      await next.stopLocalTurns();
    }
  }, 40_000);

  it("starts a turn over with its input when its host restarts before its harness began it", async () => {
    const project = await projects.create(identity, {
      name: "Restart before start",
    });
    const restarting = makeService();
    const { id: sessionId } = await restarting.create(identity, project.id, {
      agentId: "hesitant",
    });
    await restarting.sendMessage(
      identity,
      project.id,
      sessionId,
      "remember me",
    );
    await restarting.command(identity, project.id, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "plan the launch [[hesitate]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await restarting.get(identity, project.id, sessionId);
        expect(
          orderedTurns(sessionStateFromSnapshot(detail.snapshot))[1]?.status,
        ).toBe("running");
      },
      { timeout: 10_000 },
    );
    await restarting.stopLocalTurns({ handBack: "all" });

    const next = makeService();
    const worker = next.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 200,
    });
    try {
      await vi.waitFor(
        async () => {
          const detail = await next.get(identity, project.id, sessionId);
          const turns = orderedTurns(sessionStateFromSnapshot(detail.snapshot));
          // The same turn ran again with the person's message, rather than
          // being continued without it.
          expect(turns.map((turn) => turn.status)).toEqual([
            "completed",
            "completed",
          ]);
          expect(
            detail.snapshot.items.some(
              (item) =>
                item.kind === "assistant_message" &&
                item.text.startsWith("Echo: plan the launch"),
            ),
          ).toBe(true);
          expect(
            detail.snapshot.items.some(
              (item) =>
                item.kind === "notice" && item.code === "turn_continued",
            ),
          ).toBe(false);
        },
        { timeout: 20_000 },
      );
    } finally {
      await worker.stop();
      await next.stopLocalTurns();
    }
  }, 40_000);

  it("rolls back a turn and every later one", async () => {
    const { projectId, sessionId } = await chat("Rollback");
    await sessions.sendMessage(identity, projectId, sessionId, "one");
    await sessions.sendMessage(identity, projectId, sessionId, "two");
    await sessions.sendMessage(identity, projectId, sessionId, "three");
    const before = await sessions.get(identity, projectId, sessionId);
    const second = orderedTurns(sessionStateFromSnapshot(before.snapshot))[1];
    const receipt = await sessions.command(identity, projectId, sessionId, {
      type: "rollback",
      commandId: randomUUID(),
      turnId: second?.id ?? "",
    });
    expect(receipt.status).toBe("accepted");
    const after = await sessions.get(identity, projectId, sessionId);
    expect(
      orderedTurns(sessionStateFromSnapshot(after.snapshot)).map(
        (turn) => turn.status,
      ),
    ).toEqual(["completed", "rolled_back", "rolled_back"]);
    const { reply } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "four",
    );
    expect(reply?.kind === "assistant_message" && reply.text).toContain(
      "Echo: four",
    );
  });

  it("rolls back every harness's native history without mixing provider fork references", async () => {
    const { projectId, sessionId } = await chat("Rollback harnesses");
    await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "retained words",
    );
    await sessions.update(identity, projectId, sessionId, {
      agentId: "elsewhere",
    });
    await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "discard on elsewhere",
    );
    await sessions.update(identity, projectId, sessionId, { agentId: "echo" });
    await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "discard on echo",
    );
    const before = await folded(projectId, sessionId);
    const [first, second] = orderedTurns(before);
    const originalThreads = Object.values(before.providerThreads).map(
      (thread) => thread.id,
    );
    const receipt = await sessions.command(identity, projectId, sessionId, {
      type: "rollback",
      commandId: randomUUID(),
      turnId: second?.id ?? "",
    });
    expect(receipt.status).toBe("accepted");
    const closed = await db
      .selectFrom("agent_provider_threads")
      .select(["id", "status"])
      .where("id", "in", originalThreads)
      .execute();
    expect(closed.every((thread) => thread.status === "closed")).toBe(true);
    const fork = await db
      .selectFrom("agent_provider_threads")
      .select(["harness", "fork_source"])
      .where("session_id", "=", sessionId)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    expect(fork.harness).toBe("echo");
    expect(fork.fork_source).toMatchObject({
      threadId: first?.providerThreadId,
    });
    const resumed = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "after rollback",
    );
    expect(resumed.turn.status).toBe("completed");
    expect(resumed.turn.providerThreadId).not.toBe(first?.providerThreadId);
    await sessions.update(identity, projectId, sessionId, {
      agentId: "elsewhere",
    });
    const other = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "after rollback elsewhere",
    );
    expect(other.turn.status).toBe("completed");
    expect(other.turn.providerThreadId).not.toBe(second?.providerThreadId);
    expect(
      other.reply?.kind === "assistant_message" && other.reply.text,
    ).not.toContain("Person: discard on");
  });

  it("stops a turn waiting to retry as interrupted, and retries it by hand", async () => {
    const project = await projects.create(identity, { name: "Stop retrying" });
    const session = await sessions.create(identity, project.id, {
      agentId: "flaky",
    });
    await sessions.command(identity, project.id, session.id, {
      type: "send",
      commandId: randomUUID(),
      text: "hello",
    });
    const waiting = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        const [turn] = orderedTurns(sessionStateFromSnapshot(detail.snapshot));
        expect(turn?.status).toBe("queued");
        expect(turn?.retryAt).not.toBeNull();
        return turn;
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, project.id, session.id, {
      type: "interrupt",
      commandId: randomUUID(),
    });
    const stopped = await sessions.get(identity, project.id, session.id);
    const [turn] = orderedTurns(sessionStateFromSnapshot(stopped.snapshot));
    expect(turn).toMatchObject({
      id: waiting?.id,
      status: "interrupted",
      retryAt: null,
    });
    const retried = await sessions.command(identity, project.id, session.id, {
      type: "retry",
      commandId: randomUUID(),
      turnId: turn?.id ?? "",
    });
    expect(retried.status).toBe("accepted");
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        const [again] = orderedTurns(sessionStateFromSnapshot(detail.snapshot));
        expect(again?.status).toBe("completed");
      },
      { timeout: 10_000 },
    );
  });

  it("rolls back files past a later turn that changed none", async () => {
    const { projectId, sessionId } = await chat("Rollback files");
    await sessions.sendMessage(identity, projectId, sessionId, "change files");
    await sessions.sendMessage(identity, projectId, sessionId, "just talk");
    const before = await sessions.get(identity, projectId, sessionId);
    const [first] = orderedTurns(sessionStateFromSnapshot(before.snapshot));
    expect(first?.checkpoint.before).toBe("initial");
    const receipt = await sessions.command(identity, projectId, sessionId, {
      type: "rollback",
      commandId: randomUUID(),
      turnId: first?.id ?? "",
    });
    expect(receipt.error).toBeNull();
    expect(receipt.status).toBe("accepted");
    expect(heads.get(path.join(tmpDir, "checkouts", projectId))).toBe(
      "initial",
    );
  });

  it("asks the person to approve a host-guarded action on the working turn", async () => {
    const { projectId, sessionId } = await chat("Host approval");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[wait 20000]]",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        expect(detail.snapshot.turns[0]?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    const decision = sessions.askApproval({
      sessionId,
      title: "Allow push on github?",
      origin: {
        kind: "host",
        id: "connection_github",
        displayName: "Connection gateway",
      },
      approval: { action: "connection_github · push" },
      timeoutMs: 20_000,
    });
    const request = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const state = sessionStateFromSnapshot(detail.snapshot);
        expect(orderedTurns(state)[0]?.status).toBe("waiting");
        const [pending] = pendingRequests(state);
        expect(pending?.kind).toBe("approval");
        return pending;
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request?.id ?? "",
      response: { kind: "approval", decision: "approved" },
    });
    expect(await decision).toBe("allow");
    const detail = await sessions.get(identity, projectId, sessionId);
    expect(detail.snapshot.turns[0]?.status).toBe("running");
    await sessions.command(identity, projectId, sessionId, {
      type: "interrupt",
      commandId: randomUUID(),
    });
  });

  it("asks the chat's person before a guarded tool, and the harness goes on with the answer", async () => {
    const project = await projects.create(identity, { name: "Guarded" });
    const session = await sessions.create(identity, project.id, {
      agentId: "guarded",
    });
    const running = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "[[approve prod query]]",
    );
    const request = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        const [pending] = pendingRequests(
          sessionStateFromSnapshot(detail.snapshot),
        );
        expect(pending?.kind).toBe("approval");
        return pending;
      },
      { timeout: 10_000 },
    );
    // A person's own chat: they answer, within minutes.
    expect(request?.approvers).toEqual([]);
    expect(request?.expiresAt).not.toBeNull();
    await sessions.command(identity, project.id, session.id, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request?.id ?? "",
      response: { kind: "approval", decision: "approved" },
    });
    await running;
    const transcript = await sessions.transcript(
      identity,
      project.id,
      session.id,
    );
    expect(transcript.map((message) => message.content)).toContain(
      "Allowed query.",
    );
  });

  it("takes a reply sent while a question waits into the same turn, and keeps the question open (ADR 0195)", async () => {
    const { projectId, sessionId } = await chat("Reply while asked");
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "[[ask Which theme?]]",
    });
    const question = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const state = sessionStateFromSnapshot(detail.snapshot);
        expect(orderedTurns(state)[0]?.status).toBe("waiting");
        const [pending] = pendingRequests(state);
        expect(pending?.blocking).toBe(true);
        return pending;
      },
      { timeout: 10_000 },
    );
    // A plain message, not an answer: it steers the waiting turn.
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "What is the difference?",
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const state = sessionStateFromSnapshot(detail.snapshot);
        expect(orderedTurns(state).map((turn) => turn.status)).toEqual([
          "completed",
        ]);
        const [open] = pendingRequests(state);
        expect(open?.id).toBe(question?.id);
        expect(open?.blocking).toBe(false);
      },
      { timeout: 15_000 },
    );
    // The answer that comes later reaches the agent as a message, its
    // pills that message's attachments (ADR 0244).
    const swatch: AgentAttachment = {
      kind: "text",
      name: "swatch.css",
      text: "--bg: #0a0a0b;",
      source: { type: "paste" },
    };
    await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: question?.id ?? "",
      response: {
        kind: "question",
        answers: [`Dark ${ATTACHMENT_MARKER}`],
        attachments: [[swatch]],
      },
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const turns = orderedTurns(sessionStateFromSnapshot(detail.snapshot));
        expect(turns.map((turn) => turn.status)).toEqual([
          "completed",
          "completed",
        ]);
        const answer = detail.snapshot.items.find(
          (item) =>
            item.kind === "user_message" && item.text.includes("User answer:"),
        );
        expect(answer).toMatchObject({ attachments: [swatch] });
        expect(answer?.kind === "user_message" && answer.answer).toMatchObject({
          questions: question?.questions,
          answers: [`Dark ${ATTACHMENT_MARKER}`],
        });
      },
      { timeout: 15_000 },
    );
  });

  it("folds its log into exactly the rows it projected", async () => {
    const { projectId, sessionId } = await chat("Fold");
    await sessions.sendMessage(identity, projectId, sessionId, "one");
    const asked = sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[ask Which?]]",
    );
    const request = await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, sessionId);
        const [pending] = pendingRequests(
          sessionStateFromSnapshot(detail.snapshot),
        );
        if (!pending) throw new Error("No question yet");
        return pending;
      },
      { timeout: 10_000 },
    );
    await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: request.id,
      response: { kind: "question", answers: ["This"] },
    });
    await asked;
    await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "[[fail on purpose]]",
    );
    const full = await readFullSnapshot({ db, sessionId });
    const rows = await db
      .selectFrom("agent_session_events")
      .select(["sequence", "payload", "command_id", "created_at"])
      .where("session_id", "=", sessionId)
      .orderBy("sequence")
      .execute();
    const folded = applySessionEvents(
      sessionStateFromSnapshot({
        ...full,
        sequence: 0,
        turns: [],
        attempts: [],
        items: [],
        requests: [],
        providerThreads: [],
      }),
      rows.map((row) => ({
        sessionId,
        sequence: Number(row.sequence),
        at: row.created_at.toISOString(),
        commandId: row.command_id,
        event: row.payload as unknown as SessionEvent,
      })),
    );
    const projected = sessionStateFromSnapshot(full);
    expect(folded.stale).toBe(false);
    expect(folded.sequence).toBe(full.sequence);
    expect(folded.items).toEqual(projected.items);
    expect(folded.turns).toEqual(projected.turns);
    expect(folded.attempts).toEqual(projected.attempts);
    expect(folded.requests).toEqual(projected.requests);
    expect(folded.providerThreads).toEqual(projected.providerThreads);
  });
});
