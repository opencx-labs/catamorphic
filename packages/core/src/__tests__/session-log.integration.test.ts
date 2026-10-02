import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applySessionEvents,
  itemsOfTurn,
  orderedTurns,
  pendingRequests,
  type SessionEvent,
  type SessionStreamMessage,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import type { HarnessAdapter } from "@catamorphic/agent-protocol/runner";
import { EchoAdapter } from "@catamorphic/agent-runner";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
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
import { readFullSnapshot } from "../services/sessions/session-reads.js";
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
  let makeService: () => AgentSessionsService;
  /** Each checkout's commit, as the host reports it. */
  const heads = new Map<string, string>();

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
    // Refuses a steer on its first attempt, as a harness that cannot take
    // input mid-turn: the turn restarts with it.
    const inner = new EchoAdapter();
    let started = 0;
    const stubbornAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        started += 1;
        const control = inner.start(attempt, host);
        const first = started === 1;
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
    // Its tools on `prod` ask the person first (ADR 0054).
    const guarded: RegisteredCodingAgent = {
      ...echo,
      id: "guarded",
      toolPolicies: { prod: [{ default: "ask" }] },
    };
    makeService = () =>
      new AgentSessionsService(db, {
        hostId: "session-log-host",
        projectManager,
        executionEnvironments: new ExecutionEnvironmentsService(
          new ProjectEnvironmentsService(db, projectManager),
          testEnvironmentProvider(unusedSandbox),
        ),
        executionAllocations: new ExecutionAllocationsService(db),
        codingAgents: {
          defaultAgentId: () => "echo",
          get: (id) =>
            id === "echo"
              ? echo
              : id === "guarded"
                ? guarded
                : id === "stubborn"
                  ? stubborn
                  : id === "flaky"
                    ? flaky
                    : undefined,
          list: () => [echo, guarded, stubborn, flaky],
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

  it("steers a running turn without a new one", async () => {
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
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "also this",
      dispatch: "steer",
    });
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
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Echo: three",
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
    // The answer that comes later reaches the agent as a message.
    await sessions.command(identity, projectId, sessionId, {
      type: "respond",
      commandId: randomUUID(),
      requestId: question?.id ?? "",
      response: { kind: "question", answers: ["Dark"] },
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
        expect(
          answer?.kind === "user_message" && answer.metadata.question,
        ).toEqual({
          questions: question?.questions,
          answers: ["Dark"],
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
