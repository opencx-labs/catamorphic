import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type Item,
  orderedTurns,
  pendingRequests,
  type RuntimeRequest,
  sessionStateFromSnapshot,
  type Turn,
} from "@catamorphic/agent-protocol";
import type {
  AttemptControl,
  AttemptHost,
  AttemptStart,
  HarnessAdapter,
  HarnessCapabilities,
} from "@catamorphic/agent-protocol/runner";
import { RequestClosedError } from "@catamorphic/agent-protocol/runner";
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
import {
  AgentSessionsService,
  AgentTurnInProgressError,
} from "../services/agent-sessions-service.js";
import { projectChatIdentity } from "../services/chat-delivery.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import {
  type SessionActionOperation,
  SessionActionsService,
} from "../services/session-actions-service.js";
import { copySettledHistory } from "../services/sessions/session-copy.js";
import { SessionLog } from "../services/sessions/session-log.js";
import { readFullSnapshot } from "../services/sessions/session-reads.js";
import { sessionLogFixture } from "./session-fixtures.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * Coordination around agent sessions (ADRs 0090, 0173, 0176, 0179, 0195,
 * 0197): delegation, keyed chats, attention, actions, recovery and the
 * workflow-facing events, on a scripted harness.
 */

/**
 * A scripted harness: messages it recognizes run a script, anything else
 * the echo harness answers (so `[[ask ...]]` and friends work).
 */
class CoordinationAdapter implements HarnessAdapter {
  readonly id = "echo";
  private readonly echo = new EchoAdapter();
  interrupts = 0;
  /** Refuse steers, as a harness between steps of its own may. */
  refuseSteers = false;
  slowStarted: Promise<void> = Promise.resolve();
  private markSlowStarted: (() => void) | undefined;
  private releaseSlow: (() => void) | undefined;
  private connectionAttempts = 0;
  private transientAttempts = 0;
  switchCheckout?: () => string;
  /** A turn whose message starts with "questions:" runs this. */
  questions?: (input: {
    attempt: AttemptStart;
    host: AttemptHost;
    steered: string[];
    say: (text: string) => void;
  }) => Promise<void>;

  constructor() {
    this.resetSlow();
  }

  capabilities(): HarnessCapabilities {
    return this.echo.capabilities();
  }

  release(): void {
    this.releaseSlow?.();
    this.resetSlow();
  }

  private resetSlow(): void {
    this.slowStarted = new Promise<void>((resolve) => {
      this.markSlowStarted = resolve;
    });
  }

  start(attempt: AttemptStart, host: AttemptHost): AttemptControl {
    const text = attempt.input?.text ?? "";
    const scripted = [
      "Reconnect durable turn",
      "Run command with progress",
      "Truncated stream",
      "Permanent delegated failure",
      "Recover delegated work",
      "Prepare the Globex renewal deck",
      "Switch checkout and edit",
    ].some((marker) => text.includes(marker));
    const questions = text.includes("questions:") ? this.questions : undefined;
    if (!scripted && !questions) return this.echo.start(attempt, host);
    let interrupted = false;
    let wake = () => {};
    const steered: string[] = [];
    let said = 0;
    const say = (reply: string) => {
      said += 1;
      host.emit({
        type: "item.started",
        key: `say:${said}`,
        status: "completed",
        item: { kind: "assistant_message", text: reply, agentId: null },
      });
    };
    const done = (
      status: "completed" | "failed" | "interrupted" = "completed",
      error?: {
        message: string;
        kind?: "unavailable" | "auth";
        retrySafe?: boolean;
      },
    ) =>
      host.emit({
        type: "turn.completed",
        status,
        ...(error ? { error } : {}),
      });
    const run = async () => {
      host.emit({
        type: "thread",
        ref:
          attempt.thread.mode === "resume" || attempt.thread.mode === "restore"
            ? attempt.thread.nativeRef
            : { id: randomUUID(), strength: "strong" },
      });
      if (questions) {
        await questions({ attempt, host, steered, say });
        return done();
      }
      if (text.includes("Reconnect durable turn")) {
        this.connectionAttempts += 1;
        if (this.connectionAttempts % 2 === 1)
          return done("failed", {
            message: "Request rejected before execution",
            kind: "unavailable",
            retrySafe: true,
          });
        say("Connection restored");
        return done();
      }
      if (text.includes("Run command with progress")) {
        for (const key of ["first", "second"]) {
          host.emit({
            type: "item.started",
            key,
            item: {
              kind: "command",
              command: "bun test",
              description: null,
              output: "",
              exitCode: null,
            },
          });
          host.emit({ type: "item.delta", key, field: "output", text: "ok" });
          host.emit({
            type: "item.completed",
            key,
            status: "completed",
            item: { exitCode: 0 },
          });
        }
        say("Tests passed");
        return done();
      }
      if (text.includes("Truncated stream")) {
        // The harness goes away without finishing its turn.
        say("Partial work");
        return;
      }
      if (text.includes("Permanent delegated failure"))
        return done("failed", { message: "Credentials revoked", kind: "auth" });
      if (text.includes("Recover delegated work")) {
        this.transientAttempts += 1;
        if (this.transientAttempts === 1)
          return done("failed", {
            message: "Temporarily unavailable",
            kind: "unavailable",
            retrySafe: true,
          });
        say("Recovered");
        return done();
      }
      if (text.includes("Switch checkout and edit")) {
        const checkout = this.switchCheckout?.();
        if (checkout) {
          const target = path.join(checkout, "result.md");
          await fs.mkdir(checkout, { recursive: true });
          await fs.writeFile(target, "result\n");
          host.emit({
            type: "item.started",
            key: "edit",
            status: "completed",
            item: {
              kind: "file_change",
              path: target,
              change: "created",
              previousPath: null,
            },
          });
        }
        say("Edited");
        return done();
      }
      // Prepare the Globex renewal deck: works until released or stopped.
      this.markSlowStarted?.();
      await new Promise<void>((resolve) => {
        this.releaseSlow = resolve;
        wake = resolve;
      });
      if (interrupted) return done("interrupted");
      say("Deck ready");
      return done();
    };
    const finished = run().catch((error: unknown) =>
      done("failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      steer: async (input) => {
        if (this.refuseSteers) return false;
        steered.push(input.text);
        host.emit({ type: "input.consumed", itemIds: [input.itemId] });
        return true;
      },
      interrupt: () => {
        interrupted = true;
        this.interrupts += 1;
        wake();
      },
      finished,
    };
  }
}

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_coordination";
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

/** The workflow-facing events of a session, in order (ADR 0090). */
async function exportEvents(sessionId: string) {
  const rows = await db
    .selectFrom("project_events")
    .select(["id", "kind", "payload"])
    .where("source", "=", "session")
    .where(sql<string>`payload->>'sessionId'`, "=", sessionId)
    .orderBy("sequence")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: row.payload as Record<string, unknown>,
  }));
}

describe("agent session coordination", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let answerReceiver: AgentSessionsService;
  let projects: ProjectsService;
  const provider = new CoordinationAdapter();
  const checkpointedTurns: Array<{
    sessionId: string;
    workingDirectory: string;
  }> = [];
  const settledTurns: Array<{
    sessionId: string;
    workingDirectory: string;
    changedFiles: string[];
    notification?: { title?: string; body?: string };
  }> = [];
  const checkoutBySession = new Map<string, string>();

  const snapshot = async (sessionId: string, projectId: string) =>
    (await sessions.get(identity, projectId, sessionId)).snapshot;
  const turnsOf = async (
    sessionId: string,
    projectId: string,
  ): Promise<Turn[]> =>
    orderedTurns(
      sessionStateFromSnapshot(await snapshot(sessionId, projectId)),
    );
  const transcriptOf = async (sessionId: string, projectId: string) =>
    sessions.transcript(identity, projectId, sessionId);
  const send = (projectId: string, sessionId: string, text: string) =>
    sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text,
    });

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-core-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const registeredAgent = (
      id: string,
      input: Pick<RegisteredCodingAgent, "sandboxing" | "delegation"> = {},
    ): RegisteredCodingAgent => ({
      id,
      harness: {
        placement: "host",
        adapter: provider,
        // The host's delegation tool, which the delegation prompt names.
        hostTools: [
          {
            name: "spawn_subsession",
            description: "Start a subagent",
            parameters: {},
            execute: async () => null,
          },
        ],
      },
      topology: "native",
      ...input,
    });
    const agents = new Map(
      [
        registeredAgent("worker"),
        // A host that offers no delegation tool (a server's agent).
        {
          id: "plain",
          harness: { placement: "host", adapter: provider },
          topology: "native",
        } satisfies RegisteredCodingAgent,
        registeredAgent("small", { sandboxing: "contained" }),
        registeredAgent("builder", { sandboxing: "publish" }),
        registeredAgent("orchestrator", {
          sandboxing: "propose",
          delegation: {
            enabled: true,
            maxConcurrentChildren: 1,
            routes: [
              {
                id: "small-only",
                target: "small",
                allowFurtherDelegation: false,
              },
              { id: "any-lower", target: "*", allowFurtherDelegation: true },
              {
                id: "trusted-builder",
                target: "builder",
                allowFurtherDelegation: true,
              },
            ],
          },
        }),
      ].map((agent) => [agent.id, agent]),
    );
    const executionEnvironments = new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      testEnvironmentProvider(unusedSandbox),
    );
    const codingAgents = {
      defaultAgentId: () => "worker",
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    };
    const nativeAgentCheckout = {
      resolve: async ({
        projectId,
        sessionId,
      }: {
        projectId: string;
        sessionId: string;
      }) => {
        const checkout =
          checkoutBySession.get(sessionId) ?? path.join(tmpDir, projectId);
        await fs.mkdir(checkout, { recursive: true });
        return { path: checkout, owned: checkoutBySession.has(sessionId) };
      },
      checkpoint: ({
        sessionId,
        workingDirectory,
      }: {
        sessionId: string;
        workingDirectory: string;
      }) => {
        checkpointedTurns.push({ sessionId, workingDirectory });
        return Promise.resolve(null);
      },
    };
    answerReceiver = new AgentSessionsService(db, {
      hostId: "coordination-test-host",
      projectManager,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents,
      nativeAgentCheckout,
    });
    sessions = new AgentSessionsService(db, {
      hostId: "coordination-test-host",
      projectManager,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents,
      nativeAgentCheckout,
      onTurnSettled: (event) => {
        settledTurns.push({
          sessionId: event.sessionId,
          workingDirectory: event.workingDirectory,
          changedFiles: event.changedFiles,
          ...(event.notification ? { notification: event.notification } : {}),
        });
      },
    });
  }, 30_000);

  afterAll(async () => {
    provider.release();
    await sessions.stopLocalTurns({ timeoutMs: 2_000 });
    await answerReceiver.stopLocalTurns({ timeoutMs: 2_000 });
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Questions (ADRs 0122, 0195)

  it("steers a non-blocking question's answer into the turn still working, exactly once", async () => {
    const project = await projects.create(identity, {
      name: "Non-blocking questions",
    });
    const session = await sessions.create(identity, project.id);
    provider.questions = async ({ host, steered, say }) => {
      host
        .request("theme", {
          kind: "question",
          blocking: false,
          title: "Theme",
          origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
          questions: [
            {
              question: "Which theme?",
              header: "Theme",
              multiSelect: false,
              options: [],
            },
            {
              question: "Which layout?",
              header: "Layout",
              multiSelect: false,
              options: [],
            },
          ],
        })
        .catch(() => {});
      say("Continuing independent work");
      await vi.waitFor(() => expect(steered).toHaveLength(1), {
        timeout: 10_000,
      });
      expect(steered[0]).toContain("Orange and compact");
      say("Answer received in the original turn");
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: keep working",
    );
    const request = await vi.waitFor(
      async () => {
        const [pending] = pendingRequests(
          sessionStateFromSnapshot(await snapshot(session.id, project.id)),
        );
        expect(pending?.blocking).toBe(false);
        return pending;
      },
      { timeout: 10_000 },
    );
    expect(request?.questions).toHaveLength(2);
    const respond = {
      type: "respond" as const,
      commandId: randomUUID(),
      requestId: request?.id ?? "",
      response: { kind: "question" as const, answers: ["Orange and compact"] },
    };
    const [first, duplicate] = await Promise.all([
      sessions.command(identity, project.id, session.id, respond),
      sessions.command(identity, project.id, session.id, respond),
    ]);
    expect(duplicate).toEqual(first);
    const conflicting = await sessions.command(
      identity,
      project.id,
      session.id,
      {
        ...respond,
        commandId: randomUUID(),
        response: { kind: "question", answers: ["A conflicting answer"] },
      },
    );
    expect(conflicting).toMatchObject({
      status: "rejected",
      error: { code: "already_answered" },
    });
    const { reply } = await turn;
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Answer received in the original turn",
    );
    expect(await turnsOf(session.id, project.id)).toHaveLength(1);
    expect(
      (await transcriptOf(session.id, project.id)).filter((entry) =>
        entry.content.includes("User answer:"),
      ),
    ).toHaveLength(1);
    provider.questions = undefined;
  });

  it("waits for a message behind the chat's running turn, never calling its machine away", async () => {
    const project = await projects.create(identity, {
      name: "Behind a running turn",
    });
    const session = await sessions.create(identity, project.id);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.questions = async ({ say }) => {
      await released;
      say("First done");
    };
    const first = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: hold the turn",
    );
    await vi.waitFor(
      async () => {
        const [turn] = await turnsOf(session.id, project.id);
        expect(turn?.status).toBe("running");
      },
      { timeout: 10_000 },
    );
    const second = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Then this",
    );
    // Longer than a turn may wait for a machine to take it.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    release();
    provider.questions = undefined;
    await expect(first).resolves.toMatchObject({
      turn: { status: "completed" },
    });
    await expect(second).resolves.toMatchObject({
      turn: { status: "completed" },
    });
  }, 30_000);

  it("keeps unanswered questions after a turn, and a late answer runs as a turn", async () => {
    const project = await projects.create(identity, { name: "Late answers" });
    const session = await sessions.create(identity, project.id);
    provider.questions = async ({ host, say }) => {
      for (const id of ["color", "layout"])
        host
          .request(id, {
            kind: "question",
            blocking: false,
            title: id,
            origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
            questions: [
              {
                question: `Choose ${id}`,
                header: id,
                multiSelect: false,
                options: [],
              },
            ],
          })
          .catch(() => {});
      say("Independent work finished");
    };
    await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: finish first",
    );
    provider.questions = undefined;
    const open = pendingRequests(
      sessionStateFromSnapshot(await snapshot(session.id, project.id)),
    );
    expect(open.map((request) => request.title).sort()).toEqual([
      "color",
      "layout",
    ]);
    const layout = open.find((request) => request.title === "layout");
    const otherSession = await sessions.create(identity, project.id);
    expect(
      await sessions.command(identity, project.id, otherSession.id, {
        type: "respond",
        commandId: randomUUID(),
        requestId: layout?.id ?? "",
        response: { kind: "question", answers: ["Compact"] },
      }),
    ).toMatchObject({ status: "rejected", error: { code: "not_found" } });
    await sessions.command(identity, project.id, session.id, {
      type: "respond",
      commandId: randomUUID(),
      requestId: layout?.id ?? "",
      response: { kind: "question", answers: ["Compact"] },
    });
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(session.id, project.id)).map((turn) => turn.status),
        ).toEqual(["completed", "completed"]),
      { timeout: 10_000 },
    );
    expect(
      pendingRequests(
        sessionStateFromSnapshot(await snapshot(session.id, project.id)),
      ).map((request) => request.title),
    ).toEqual(["color"]);
    expect(
      (await transcriptOf(session.id, project.id)).some(
        (entry) =>
          entry.content.includes("Choose layout") &&
          entry.content.includes("Compact"),
      ),
    ).toBe(true);
  });

  it("delivers a blocking answer received by another service to the waiting harness", async () => {
    const project = await projects.create(identity, {
      name: "Blocking questions",
    });
    const session = await sessions.create(identity, project.id);
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "[[ask Choose a theme]]",
    );
    const request = await vi.waitFor(
      async () => {
        const state = sessionStateFromSnapshot(
          await snapshot(session.id, project.id),
        );
        expect(orderedTurns(state)[0]?.status).toBe("waiting");
        return pendingRequests(state)[0];
      },
      { timeout: 10_000 },
    );
    // While a turn waits, another service still refuses changes to the chat.
    await expect(
      answerReceiver.update(identity, project.id, session.id, {
        effort: "high",
      }),
    ).rejects.toBeInstanceOf(AgentTurnInProgressError);
    const receipt = await answerReceiver.command(
      identity,
      project.id,
      session.id,
      {
        type: "respond",
        commandId: randomUUID(),
        requestId: request?.id ?? "",
        response: { kind: "question", answers: ["Orange"] },
      },
    );
    expect(receipt.status).toBe("accepted");
    await turn;
    expect(await turnsOf(session.id, project.id)).toHaveLength(1);
    expect(
      (await transcriptOf(session.id, project.id)).map(
        (entry) => entry.content,
      ),
    ).toContain("You answered: Orange");
  });

  it("withdraws a question its harness withdrew, and refuses a stale answer", async () => {
    const project = await projects.create(identity, {
      name: "Withdrawn question",
    });
    const session = await sessions.create(identity, project.id);
    const withdraw = new AbortController();
    provider.questions = async ({ host }) => {
      await host
        .request(
          "consent",
          {
            kind: "question",
            blocking: true,
            title: "Permission",
            origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
            questions: [
              {
                question: "May I update this file?",
                header: "Permission",
                multiSelect: false,
                options: [],
              },
            ],
          },
          { signal: withdraw.signal },
        )
        .catch((error: unknown) => {
          if (!(error instanceof RequestClosedError)) throw error;
        });
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: consent",
    );
    const request = await vi.waitFor(
      async () => {
        const [pending] = pendingRequests(
          sessionStateFromSnapshot(await snapshot(session.id, project.id)),
        );
        if (!pending) throw new Error("No question yet");
        return pending;
      },
      { timeout: 10_000 },
    );
    withdraw.abort();
    await turn;
    provider.questions = undefined;
    expect(
      pendingRequests(
        sessionStateFromSnapshot(await snapshot(session.id, project.id)),
      ),
    ).toEqual([]);
    expect(
      await answerReceiver.command(identity, project.id, session.id, {
        type: "respond",
        commandId: randomUUID(),
        requestId: request.id,
        response: { kind: "question", answers: ["Allow once"] },
      }),
    ).toMatchObject({ status: "rejected" });
  });

  // -------------------------------------------------------------------------
  // Failures and recovery (ADR 0198)

  it("retries a turn its provider rejected before any work, without a second message", async () => {
    const project = await projects.create(identity, {
      name: "Durable reconnect",
    });
    const session = await sessions.create(identity, project.id);
    await send(project.id, session.id, "Reconnect durable turn");
    await vi.waitFor(
      async () => {
        const [turn] = await turnsOf(session.id, project.id);
        expect(turn).toMatchObject({ status: "queued", attemptCount: 1 });
        expect(turn?.retryAt).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 20,
    });
    try {
      await vi.waitFor(
        async () => {
          const [turn] = await turnsOf(session.id, project.id);
          expect(turn).toMatchObject({ status: "completed", attemptCount: 2 });
          const transcript = await transcriptOf(session.id, project.id);
          expect(transcript.at(-1)?.content).toBe("Connection restored");
          expect(
            transcript.filter((entry) => entry.role === "user"),
          ).toHaveLength(1);
        },
        { timeout: 10_000 },
      );
    } finally {
      await worker.stop();
    }
  });

  it("recovers a project chat's queued turn although nobody is its member", async () => {
    const project = await projects.create(identity, {
      name: "Project chat recovery",
    });
    const projectChat = projectChatIdentity({
      tenantId: identity.tenantId,
      projectId: project.id,
    });
    const session = await sessions.create(projectChat, project.id);
    await sessions.command(projectChat, project.id, session.id, {
      type: "send",
      commandId: randomUUID(),
      text: "Reconnect durable turn",
    });
    await vi.waitFor(
      async () => {
        const [turn] = orderedTurns(
          sessionStateFromSnapshot(
            (await sessions.get(projectChat, project.id, session.id)).snapshot,
          ),
        );
        expect(turn?.attemptCount).toBe(1);
        expect(turn?.status).toBe("queued");
      },
      { timeout: 10_000 },
    );
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    // The host's member lookup knows nobody for the project principal.
    const worker = sessions.startWorker({
      resolveIdentity: async () => null,
      pollIntervalMs: 20,
    });
    try {
      await vi.waitFor(
        async () => {
          const transcript = await sessions.transcript(
            projectChat,
            project.id,
            session.id,
          );
          expect(transcript.at(-1)?.content).toBe("Connection restored");
        },
        { timeout: 10_000 },
      );
    } finally {
      await worker.stop();
    }
  });

  it("records each command as one item that ends with its output", async () => {
    const project = await projects.create(identity, {
      name: "Command progress",
    });
    const session = await sessions.create(identity, project.id);
    const { turn } = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Run command with progress",
    );
    const items = (await snapshot(session.id, project.id)).items.filter(
      (item) => item.turnId === turn.id,
    );
    const commands = items.filter(
      (item): item is Extract<Item, { kind: "command" }> =>
        item.kind === "command",
    );
    expect(
      commands.map((item) => [item.status, item.output, item.exitCode]),
    ).toEqual([
      ["completed", "ok", 0],
      ["completed", "ok", 0],
    ]);
    expect(
      commands.every(
        (item) => item.startedAt !== null && item.endedAt !== null,
      ),
    ).toBe(true);
    expect(items.at(-1)).toMatchObject({
      kind: "assistant_message",
      text: "Tests passed",
    });
  });

  it("fails a turn whose harness stopped without finishing, keeping its partial reply", async () => {
    const project = await projects.create(identity, {
      name: "Truncated response",
    });
    const session = await sessions.create(identity, project.id);
    const { turn, reply } = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Truncated stream",
    );
    expect(turn.status).toBe("failed");
    expect(turn.error?.retrySafe).not.toBe(true);
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Partial work",
    );
    // Nothing retries it.
    expect(
      (await turnsOf(session.id, project.id)).map((entry) => entry.status),
    ).toEqual(["failed"]);
  });

  it("answers a replayed interrupting send with its first receipt, interrupting nothing", async () => {
    const project = await projects.create(identity, {
      name: "Lost acknowledgement",
    });
    const session = await sessions.create(identity, project.id);
    const command = {
      type: "send" as const,
      commandId: randomUUID(),
      text: "Prepare the Globex renewal deck",
      dispatch: "interrupt" as const,
    };
    const accepted = await sessions.command(
      identity,
      project.id,
      session.id,
      command,
    );
    await provider.slowStarted;
    try {
      const interruptsBefore = provider.interrupts;
      expect(
        await sessions.command(identity, project.id, session.id, command),
      ).toEqual(accepted);
      const [turn] = await turnsOf(session.id, project.id);
      expect(turn).toMatchObject({
        status: "running",
        cancellationRequested: false,
      });
      expect(provider.interrupts).toBe(interruptsBefore);
      expect(
        (await transcriptOf(session.id, project.id)).filter(
          (entry) => entry.role === "user",
        ),
      ).toHaveLength(1);
    } finally {
      provider.release();
    }
    await vi.waitFor(
      async () =>
        expect((await turnsOf(session.id, project.id))[0]?.status).toBe(
          "completed",
        ),
      {
        timeout: 10_000,
      },
    );
  });

  it.each(["direct", "mailbox"])(
    "does not interrupt accepted work when %s delivery is replayed",
    async (transport) => {
      const project = await projects.create(identity, {
        name: "Replayed delivery",
      });
      const session = await sessions.create(identity, project.id);
      const key = randomUUID();
      const content = "Prepare the Globex renewal deck";
      const mailboxItemId = randomUUID();
      const deliver = () =>
        transport === "direct"
          ? sessions.deliver(identity, project.id, session.id, {
              content,
              author: { kind: "user", externalUserId: identity.externalUserId },
              mode: "interrupt",
              idempotencyKey: key,
            })
          : sessions.importMailbox(identity, project.id, {
              id: key,
              projectId: project.id,
              sessionId: session.id,
              sourceHostId: "remote",
              destinationHostId: "coordination-test-host",
              authorityRevision: session.authorityRevision,
              messageId: mailboxItemId,
              content,
              author: { kind: "user", externalUserId: identity.externalUserId },
              mode: "interrupt",
              idempotencyKey: key,
              metadata: { ownerAuthored: true },
              createdAt: new Date().toISOString(),
            });
      const interruptsBefore = provider.interrupts;
      try {
        const accepted = await deliver();
        await provider.slowStarted;
        expect(await deliver()).toMatchObject({
          messageId: accepted.messageId,
          turnId: accepted.turnId,
          created: false,
        });
        expect(provider.interrupts).toBe(interruptsBefore);
        expect((await turnsOf(session.id, project.id))[0]).toMatchObject({
          status: "running",
          cancellationRequested: false,
        });
      } finally {
        provider.release();
      }
      await vi.waitFor(
        async () =>
          expect((await turnsOf(session.id, project.id))[0]?.status).toBe(
            "completed",
          ),
        {
          timeout: 10_000,
        },
      );
    },
  );

  it("fences a holder's late result after its lease was taken", async () => {
    const project = await projects.create(identity, { name: "Late executor" });
    const session = await sessions.create(identity, project.id);
    const settledBefore = settledTurns.length;
    await send(project.id, session.id, "Prepare the Globex renewal deck");
    await provider.slowStarted;
    // Another holder took the turn while this one worked.
    await db
      .updateTable("agent_turns")
      .set({
        lease_owner: "another-holder",
        lease_token: randomUUID(),
        lease_expires_at: sql<Date>`now() + interval '1 hour'`,
      })
      .where("session_id", "=", session.id)
      .execute();
    provider.release();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const [turn] = await turnsOf(session.id, project.id);
    expect(turn?.status).toBe("running");
    expect(settledTurns).toHaveLength(settledBefore);
    // The other holder never comes: settle it for the tests after.
    await db
      .updateTable("agent_turns")
      .set({
        status: "interrupted",
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      })
      .where("session_id", "=", session.id)
      .execute();
  });

  it("runs a turn again after its holder died before the harness started", async () => {
    const project = await projects.create(identity, {
      name: "Pre-reply crash",
    });
    const session = await sessions.create(identity, project.id);
    const fixture = sessionLogFixture(db);
    await db
      .updateTable("agent_sessions")
      .set({ authority_host_id: "coordination-test-host" })
      .where("id", "=", session.id)
      .execute();
    await fixture.queueTurn({
      sessionId: session.id,
      text: "Accepted before crash",
      externalUserId: identity.externalUserId,
    });
    // A holder claims it, then dies.
    const claimed = await fixture.queue.claim({
      workerId: "dead",
      sessionId: session.id,
    });
    expect(claimed?.turn.status).toBe("preparing");
    await db
      .updateTable("agent_turns")
      .set({ lease_expires_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    // Reading never moves the turn.
    expect((await turnsOf(session.id, project.id))[0]?.status).toBe(
      "preparing",
    );
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 20,
    });
    try {
      await vi.waitFor(
        async () => {
          const [turn] = await turnsOf(session.id, project.id);
          expect(turn).toMatchObject({ status: "completed", attemptCount: 1 });
          expect(
            (await transcriptOf(session.id, project.id)).filter(
              (entry) => entry.role === "user",
            ),
          ).toHaveLength(1);
        },
        { timeout: 10_000 },
      );
    } finally {
      await worker.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Peers and delegation (ADR 0090)

  it("shows same-project peers with hierarchy, visibility, and live running state", async () => {
    const project = await projects.create(identity, { name: "Acme" });
    const otherProject = await projects.create(identity, { name: "Other" });
    const first = await sessions.create(identity, project.id);
    const second = await sessions.create(identity, project.id);
    await sessions.create(identity, otherProject.id);
    await sessions.setActivity(
      identity,
      project.id,
      second.id,
      " Editing   presentations/globex-renewal.pptx ",
    );
    const turn = sessions.sendMessage(
      identity,
      project.id,
      second.id,
      "Prepare the Globex renewal deck",
    );
    await provider.slowStarted;
    expect(await sessions.listPeers(identity, project.id, first.id)).toEqual([
      expect.objectContaining({
        id: second.id,
        projectId: project.id,
        running: true,
        task: "Prepare the Globex renewal deck",
        activity: "Editing presentations/globex-renewal.pptx",
      }),
    ]);
    provider.release();
    await turn;
    expect(checkpointedTurns.map((entry) => entry.sessionId)).toContain(
      second.id,
    );
    await sessions.setActivity(identity, project.id, second.id, null);
    expect(
      (await sessions.listPeers(identity, project.id, first.id))[0]?.activity,
    ).toBeNull();
    await db
      .updateTable("agent_sessions")
      .set({ updated_at: new Date(Date.now() - 31 * 60 * 1000) })
      .where("id", "=", second.id)
      .execute();
    expect(await sessions.listPeers(identity, project.id, first.id)).toEqual([
      expect.objectContaining({ id: second.id, running: false }),
    ]);
  });

  it("creates latent subsessions and promotes them on direct user interaction", async () => {
    const project = await projects.create(identity, { name: "Delegation" });
    const parent = await sessions.create(identity, project.id);
    const delegated = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        task: "Check the release notes",
      },
    );
    expect(delegated.session).toMatchObject({
      parentSessionId: parent.id,
      forkedFromSessionId: null,
      visibility: "latent",
    });
    await vi.waitFor(
      async () =>
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("completed"),
      { timeout: 10_000 },
    );
    await vi.waitFor(
      async () => {
        const items = (await snapshot(parent.id, project.id)).items;
        expect(
          items.some(
            (item) =>
              item.kind === "user_message" &&
              item.author.kind === "agent" &&
              item.author.sessionId === delegated.session.id,
          ),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    await send(
      project.id,
      delegated.session.id,
      "Please expand the conclusion",
    );
    expect(
      await sessions.get(identity, project.id, delegated.session.id),
    ).toMatchObject({
      visibility: "promoted",
    });
  });

  it("names an untitled chat by its first message as it is sent, until its harness names it", async () => {
    const project = await projects.create(identity, { name: "Chat names" });
    const session = await sessions.create(identity, project.id);
    // Context that starts no work names nothing.
    await sessions.deliver(identity, project.id, session.id, {
      content: "For context: the offsite is in May",
      author: { kind: "user", externalUserId: identity.externalUserId },
      mode: "message_only",
    });
    expect((await sessions.get(identity, project.id, session.id)).title).toBe(
      null,
    );
    // Named while its first turn still runs, not when the turn settles.
    await send(project.id, session.id, "Plan the offsite\n\n[[wait 2000]]");
    expect((await sessions.get(identity, project.id, session.id)).title).toBe(
      "Plan the offsite [[wait 2000]]",
    );
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(session.id, project.id)).map((turn) => turn.status),
        ).toEqual(["completed"]),
      { timeout: 10_000 },
    );
    // A later message keeps the name; a harness's own title replaces it.
    await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "And the budget [[title Offsite plan]]",
    );
    expect((await sessions.get(identity, project.id, session.id)).title).toBe(
      "Offsite plan",
    );
  });

  it("steers a subsession's result into its parent's working turn, like a subagent's", async () => {
    const project = await projects.create(identity, { name: "Subagents" });
    const parent = await sessions.create(identity, project.id);
    const children: string[] = [];
    provider.questions = async ({ steered, say }) => {
      const child = await sessions.createSubsession(
        identity,
        project.id,
        parent.id,
        { task: "Summarize the release notes" },
      );
      children.push(child.session.id);
      // The parent waits as it would on a subagent; the result reaches it
      // in this same turn.
      await sessions.waitForSubsessions(identity, project.id, parent.id, {
        timeoutMs: 10_000,
      });
      await vi.waitFor(
        () =>
          expect(steered.some((text) => text.includes(child.session.id))).toBe(
            true,
          ),
        { timeout: 10_000 },
      );
      say("Combined the child's summary");
    };
    try {
      const { reply } = await sessions.sendMessage(
        identity,
        project.id,
        parent.id,
        "questions: delegate and combine",
      );
      expect(reply?.kind === "assistant_message" && reply.text).toBe(
        "Combined the child's summary",
      );
      // No second turn: the parent already had the result.
      expect(
        (await turnsOf(parent.id, project.id)).map((turn) => turn.status),
      ).toEqual(["completed"]);
      expect(
        (await snapshot(parent.id, project.id)).items.filter(
          (item) =>
            item.kind === "user_message" &&
            item.author.kind === "agent" &&
            item.author.sessionId === children[0],
        ),
      ).toHaveLength(1);
    } finally {
      provider.questions = undefined;
    }
  });

  it("runs a refused subsession result as the parent's next turn, without stopping its work", async () => {
    const project = await projects.create(identity, {
      name: "Refused subagent results",
    });
    const parent = await sessions.create(identity, project.id);
    let child = "";
    provider.questions = async ({ attempt, say }) => {
      provider.refuseSteers = true;
      child = (
        await sessions.createSubsession(identity, project.id, parent.id, {
          task: "Count the open issues",
        })
      ).session.id;
      // The harness refuses the result's steer; the work goes on.
      await vi.waitFor(
        async () =>
          expect(
            await db
              .selectFrom("agent_turn_commands")
              .select("status")
              .where("turn_id", "=", attempt.turnId)
              .where("kind", "=", "steer")
              .execute(),
          ).toEqual([{ status: "acknowledged" }]),
        { timeout: 10_000 },
      );
      say("Finished my own part");
    };
    try {
      const { reply } = await sessions.sendMessage(
        identity,
        project.id,
        parent.id,
        "questions: delegate and keep going",
      );
      expect(reply?.kind === "assistant_message" && reply.text).toBe(
        "Finished my own part",
      );
    } finally {
      provider.questions = undefined;
      provider.refuseSteers = false;
    }
    // The work was not restarted to take the result in.
    expect((await turnsOf(parent.id, project.id))[0]?.attemptCount).toBe(1);
    // The result was never lost: it ran as a turn of its own after.
    await vi.waitFor(
      async () => {
        const turns = await turnsOf(parent.id, project.id);
        expect(turns.map((turn) => turn.status)).toEqual([
          "completed",
          "completed",
        ]);
        const items = (await snapshot(parent.id, project.id)).items;
        const result = items.find(
          (item) =>
            item.kind === "user_message" &&
            item.author.kind === "agent" &&
            item.author.sessionId === child,
        );
        expect(turns[1]?.inputItemId).toBe(result?.id);
      },
      { timeout: 10_000 },
    );
  });

  it("waits on the subsessions still running, not one that settled before", async () => {
    const project = await projects.create(identity, {
      name: "Waiting on subagents",
    });
    const parent = await sessions.create(identity, project.id);
    const done = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Answer quickly" },
    );
    await vi.waitFor(
      async () =>
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("completed"),
      { timeout: 10_000 },
    );
    // A fresh start signal: no earlier test's slow turn can answer for it.
    provider.release();
    const slowStarted = provider.slowStarted;
    const slow = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Prepare the Globex renewal deck" },
    );
    try {
      await slowStarted;
      const started = Date.now();
      const waited = await sessions.waitForSubsessions(
        identity,
        project.id,
        parent.id,
        { timeoutMs: 600 },
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect(waited.map((child) => [child.session.id, child.status])).toEqual([
        [slow.session.id, "running"],
      ]);
      expect(waited.map((child) => child.session.id)).not.toContain(
        done.session.id,
      );
    } finally {
      provider.release();
    }
    await vi.waitFor(
      async () =>
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id)).map(
            (child) => child.status,
          ),
        ).toEqual(["completed", "completed"]),
      { timeout: 10_000 },
    );
  });

  it("tells only an agent given spawn_subsession about its subagents", async () => {
    const project = await projects.create(identity, {
      name: "Subagent prompt",
    });
    const promptOf = async (agentId: string) =>
      (
        await db
          .selectFrom("agent_sessions")
          .select("system_prompt")
          .where(
            "id",
            "=",
            (
              await sessions.create(identity, project.id, { agentId })
            ).id,
          )
          .executeTakeFirstOrThrow()
      ).system_prompt ?? "";
    expect(await promptOf("worker")).toContain(
      "Subsessions are your subagents",
    );
    expect(await promptOf("plain")).not.toContain("subsession");
  });

  it("inherits the parent agent for a manually created subsession", async () => {
    const project = await projects.create(identity, {
      name: "Manual subsession agent",
    });
    const parent = await sessions.create(identity, project.id, {
      agentId: "small",
    });
    const child = await sessions.create(identity, project.id, {
      parentSessionId: parent.id,
    });
    expect(child.agentId).toBe("small");
  });

  it("enforces delegation routes, concurrency, onward grants, and sandboxing ceilings", async () => {
    const project = await projects.create(identity, {
      name: "Delegation policy",
    });
    const parent = await sessions.create(identity, project.id, {
      agentId: "orchestrator",
    });
    const attempts = await Promise.allSettled([
      sessions.createSubsession(identity, project.id, parent.id, {
        routeId: "small-only",
        task: "Prepare the Globex renewal deck A",
      }),
      sessions.createSubsession(identity, project.id, parent.id, {
        routeId: "small-only",
        task: "Prepare the Globex renewal deck B",
      }),
    ]);
    const accepted = attempts.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/already has 1 active subsessions/),
      }),
    });
    const child = accepted[0];
    if (!child) throw new Error("Expected a child");
    await provider.slowStarted;
    const parentRow = await db
      .selectFrom("agent_sessions")
      .select("system_prompt")
      .where("id", "=", parent.id)
      .executeTakeFirstOrThrow();
    expect(parentRow.system_prompt).toContain("small-only: small");
    await expect(
      sessions.createSubsession(identity, project.id, parent.id, {
        routeId: "any-lower",
        agentId: "builder",
        task: "Escalate through wildcard",
      }),
    ).rejects.toThrow(/cannot grant an agent with wider sandboxing/);
    provider.release();
    await vi.waitFor(
      async () =>
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("completed"),
      { timeout: 10_000 },
    );
    await expect(
      sessions.createSubsession(identity, project.id, child.session.id, {
        task: "Delegate again",
      }),
    ).rejects.toThrow(/not allowed to delegate further/);
    const childRow = await db
      .selectFrom("agent_sessions")
      .select("system_prompt")
      .where("id", "=", child.session.id)
      .executeTakeFirstOrThrow();
    expect(childRow.system_prompt).toContain(
      "Delegation is disabled for this subsession",
    );
    const trusted = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        routeId: "trusted-builder",
        task: "Implement the approved fix",
      },
    );
    expect(trusted.session.agentId).toBe("builder");
  });

  it("promotes failed delegated work and informs its parent", async () => {
    const project = await projects.create(identity, {
      name: "Failed child visibility",
    });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        task: "Permanent delegated failure",
      },
    );
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(
          identity,
          project.id,
          child.session.id,
        );
        expect(detail.visibility).toBe("promoted");
        expect(detail.attentionRequired).toBe(true);
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("failed");
      },
      { timeout: 10_000 },
    );
  });

  it("keeps a delegation running across a transient child failure", async () => {
    const project = await projects.create(identity, {
      name: "Delegation retry",
    });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        task: "Recover delegated work",
      },
    );
    await vi.waitFor(
      async () => {
        const [turn] = await turnsOf(child.session.id, project.id);
        expect(turn).toMatchObject({ status: "queued", attemptCount: 1 });
      },
      { timeout: 10_000 },
    );
    expect(
      (await sessions.listSubsessions(identity, project.id, parent.id))[0]
        ?.status,
    ).toBe("running");
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("session_id", "=", child.session.id)
      .execute();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 20,
    });
    try {
      await vi.waitFor(
        async () =>
          expect(
            (await sessions.listSubsessions(identity, project.id, parent.id))[0]
              ?.status,
          ).toBe("completed"),
        { timeout: 10_000 },
      );
    } finally {
      await worker.stop();
    }
  });

  it("delivers a child's result again after a failed publication, without rerunning it", async () => {
    const project = await projects.create(identity, {
      name: "Durable child result",
    });
    const parent = await sessions.create(identity, project.id);
    const delivery = vi
      .spyOn(sessions, "deliver")
      .mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    let worker: ReturnType<AgentSessionsService["startWorker"]> | undefined;
    try {
      const child = await sessions.createSubsession(
        identity,
        project.id,
        parent.id,
        {
          task: "Publish this result reliably",
        },
      );
      await vi.waitFor(
        async () => {
          expect(
            (await turnsOf(child.session.id, project.id)).map(
              (turn) => turn.status,
            ),
          ).toEqual(["completed"]);
          expect(delivery).toHaveBeenCalled();
        },
        { timeout: 10_000 },
      );
      delivery.mockRestore();
      worker = sessions.startWorker({
        resolveIdentity: async () => identity,
        pollIntervalMs: 20,
      });
      await vi.waitFor(
        async () => {
          expect(
            (await sessions.listSubsessions(identity, project.id, parent.id))[0]
              ?.status,
          ).toBe("completed");
          const items = (await snapshot(parent.id, project.id)).items;
          expect(
            items.filter(
              (item) =>
                item.kind === "user_message" &&
                item.author.kind === "agent" &&
                item.author.sessionId === child.session.id,
            ),
          ).toHaveLength(1);
        },
        { timeout: 10_000 },
      );
      expect(
        (await turnsOf(child.session.id, project.id)).map(
          (turn) => turn.attemptCount,
        ),
      ).toEqual([1]);
    } finally {
      delivery.mockRestore();
      await worker?.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Closing and archiving (ADR 0173)

  it("sweeps resources again after closing a session to fence late watcher admission", async () => {
    const project = await projects.create(identity, {
      name: "Close admission",
    });
    const session = await sessions.create(identity, project.id);
    const cleanupStatus: string[] = [];
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 0 }),
      stop: async () => {
        const row = await db
          .selectFrom("agent_sessions")
          .select("status")
          .where("id", "=", session.id)
          .executeTakeFirstOrThrow();
        cleanupStatus.push(row.status);
      },
    });
    try {
      await sessions.close(identity, project.id, session.id);
      expect(cleanupStatus).toEqual(["active", "closed"]);
    } finally {
      sessions.setArchiveResourcesHandler({
        impact: async () => ({ activeProcessCount: 0 }),
        stop: async () => {},
      });
    }
  });

  it("archives a whole session tree and confirms only when live resources stop", async () => {
    const project = await projects.create(identity, { name: "Archive tree" });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.create(identity, project.id, {
      parentSessionId: parent.id,
    });
    const runningChild = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        task: "Prepare the Globex renewal deck before archiving",
      },
    );
    await provider.slowStarted;
    const cleanupVisibility: string[] = [];
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 1 }),
      stop: async () => {
        cleanupVisibility.push(
          (await sessions.get(identity, project.id, parent.id)).visibility,
        );
      },
    });
    await expect(
      sessions.archive(identity, project.id, parent.id),
    ).rejects.toMatchObject({
      impact: expect.objectContaining({
        sessionIds: expect.arrayContaining([
          parent.id,
          child.id,
          runningChild.session.id,
        ]),
        runningSessionIds: [runningChild.session.id],
        activeProcessCount: 1,
        requiresConfirmation: true,
      }),
    });
    const archived = await sessions.archive(identity, project.id, parent.id, {
      confirmStop: true,
    });
    expect(cleanupVisibility).toEqual(["promoted", "archived"]);
    expect(archived.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.id,
          status: "active",
          visibility: "archived",
        }),
        expect.objectContaining({
          id: child.id,
          status: "active",
          visibility: "archived",
        }),
        expect.objectContaining({
          id: runningChild.session.id,
          status: "active",
          visibility: "archived",
        }),
      ]),
    );
    // Its running turn was stopped.
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(runningChild.session.id, project.id))[0]?.status,
        ).toBe("interrupted"),
      { timeout: 10_000 },
    );
    const restored = await sessions.unarchive(identity, project.id, parent.id);
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: parent.id, visibility: "promoted" }),
        expect.objectContaining({ id: child.id, visibility: "promoted" }),
        expect.objectContaining({
          id: runningChild.session.id,
          visibility: "latent",
        }),
      ]),
    );
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 0 }),
      stop: async () => {},
    });
    const idleArchive = await sessions.archive(identity, project.id, parent.id);
    expect(idleArchive.impact.requiresConfirmation).toBe(false);

    const notifyProject = await projects.create(identity, {
      name: "Archive child notification",
    });
    const notifyParent = await sessions.create(identity, notifyProject.id);
    const notifyChild = await sessions.createSubsession(
      identity,
      notifyProject.id,
      notifyParent.id,
      {
        task: "Prepare the Globex renewal deck until archived",
      },
    );
    await provider.slowStarted;
    await sessions.archive(identity, notifyProject.id, notifyChild.session.id, {
      confirmStop: true,
    });
    await vi.waitFor(
      async () => {
        const transcript = await sessions.transcript(
          identity,
          notifyProject.id,
          notifyParent.id,
        );
        expect(
          transcript.some(
            (message) =>
              message.content ===
              `Subsession ${notifyChild.session.id} was archived by the user.`,
          ),
        ).toBe(true);
        expect(
          (await turnsOf(notifyParent.id, notifyProject.id)).at(-1)?.status,
        ).toBe("completed");
      },
      { timeout: 10_000 },
    );
  });

  it("settles and checkpoints a checkout selected during the turn", async () => {
    const project = await projects.create(identity, { name: "Switching" });
    const chat = await sessions.create(identity, project.id);
    const worktree = path.join(tmpDir, project.id, "worktrees", chat.id);
    provider.switchCheckout = () => {
      checkoutBySession.set(chat.id, worktree);
      return worktree;
    };
    try {
      await sessions.sendMessage(
        identity,
        project.id,
        chat.id,
        "Switch checkout and edit",
      );
      expect(checkpointedTurns).toContainEqual({
        sessionId: chat.id,
        workingDirectory: worktree,
      });
      await vi.waitFor(() =>
        expect(settledTurns).toContainEqual({
          sessionId: chat.id,
          workingDirectory: worktree,
          changedFiles: ["result.md"],
        }),
      );
    } finally {
      provider.switchCheckout = undefined;
    }
  });

  // -------------------------------------------------------------------------
  // Keyed chats and attention (ADRs 0173, 0179)

  it("reuses the chat for a workflow key and requests attention when its turn settles", async () => {
    const project = await projects.create(identity, { name: "Daily brief" });
    const chatKey = "daily";
    const deliverToKey = async (input: {
      content: string;
      title?: string;
      notification?: { title?: string; body?: string };
    }) => {
      const chat = await sessions.chatForKey(identity, project.id, {
        key: chatKey,
        workflowName: "gmail-summary",
        ...(input.title ? { title: input.title } : {}),
      });
      const runId = randomUUID();
      const receipt = await sessions.deliver(
        identity,
        project.id,
        chat.sessionId,
        {
          content: input.content,
          author: { kind: "workflow", runId, workflowName: "gmail-summary" },
          mode: "queue",
          idempotencyKey: `workflow:${runId}:${chatKey}`,
          metadata: { workflowNotification: input.notification ?? {} },
        },
      );
      return { ...receipt, ...chat };
    };
    const first = await deliverToKey({
      content: "Summarize my inbox",
      title: "Daily inbox summary",
      notification: {
        title: "Your inbox summary is ready",
        body: "Open the chat to read it.",
      },
    });
    expect(first.sessionCreated).toBe(true);
    await vi.waitFor(
      async () =>
        expect(
          (await sessions.list(identity, project.id)).items[0],
        ).toMatchObject({
          id: first.sessionId,
          title: "Daily inbox summary",
          attentionRevision: 1,
          attentionSeenRevision: 0,
          attentionRequired: true,
        }),
      { timeout: 10_000 },
    );
    expect(settledTurns.at(-1)?.notification).toEqual({
      title: "Your inbox summary is ready",
      body: "Open the chat to read it.",
    });
    const acknowledged = await sessions.acknowledgeAttention(
      identity,
      project.id,
      first.sessionId,
    );
    expect(acknowledged.attentionRequired).toBe(false);
    const second = await deliverToKey({ content: "Summarize my inbox again" });
    expect(second).toMatchObject({
      sessionId: first.sessionId,
      sessionCreated: false,
    });
    await vi.waitFor(
      async () =>
        expect(
          (await sessions.list(identity, project.id)).items[0],
        ).toMatchObject({
          attentionRevision: 2,
          attentionSeenRevision: 1,
          attentionRequired: true,
        }),
      { timeout: 10_000 },
    );
  });

  it("keys belong to the project: two workflows reach one chat and are recorded on it", async () => {
    const project = await projects.create(identity, { name: "Project keys" });
    const opened = await sessions.chatForKey(identity, project.id, {
      key: "pr-42",
      workflowName: "reviewOnOpen",
      title: "Review: pull request 42",
    });
    const merged = await sessions.chatForKey(identity, project.id, {
      key: "pr-42",
      workflowName: "cleanupOnMerge",
    });
    const again = await sessions.chatForKey(identity, project.id, {
      key: "pr-42",
      workflowName: "reviewOnOpen",
    });
    expect(opened.sessionCreated).toBe(true);
    expect(merged).toEqual({
      sessionId: opened.sessionId,
      sessionCreated: false,
    });
    expect(again.sessionId).toBe(opened.sessionId);
    expect(
      await sessions.get(identity, project.id, opened.sessionId),
    ).toMatchObject({
      key: "pr-42",
      keyWorkflows: ["reviewOnOpen", "cleanupOnMerge"],
      placement: {
        environment: "default",
        reason: "project_default",
        machine: { id: "local", label: "Test Environment" },
      },
    });
    const other = await projects.create(identity, { name: "Other keys" });
    const elsewhere = await sessions.chatForKey(identity, other.id, {
      key: "pr-42",
      workflowName: "reviewOnOpen",
    });
    expect(elsewhere.sessionId).not.toBe(opened.sessionId);
  });

  it("finds by key without creating, closes by key to free it, and keeps the transcript", async () => {
    const project = await projects.create(identity, { name: "Close by key" });
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const author = {
      kind: "workflow" as const,
      runId: randomUUID(),
      workflowName: "cleanupOnMerge",
    };
    const act = (operation: SessionActionOperation, args: unknown) =>
      actions.execute({
        identity,
        projectId: project.id,
        operation,
        args,
        author,
      });
    expect(await act("find", { key: "pr-7" })).toBeNull();
    expect(
      await act("close", { key: "pr-7", idempotencyKey: "early" }),
    ).toEqual({ sessionId: null, closed: false });
    expect(
      await sessions.keyedChatId({
        projectId: project.id,
        ownerId: identity.externalUserId,
        key: "pr-7",
      }),
    ).toBeUndefined();
    const first = await sessions.chatForKey(identity, project.id, {
      key: "pr-7",
      workflowName: "reviewOnOpen",
    });
    await sessions.deliver(identity, project.id, first.sessionId, {
      content: "Review pull request 7",
      author: { ...author, workflowName: "reviewOnOpen" },
      mode: "message_only",
      idempotencyKey: "review-7",
    });
    expect(await act("find", { key: "pr-7" })).toMatchObject({
      id: first.sessionId,
      key: "pr-7",
      status: "active",
    });
    expect(await act("inspect", { key: "pr-7" })).toMatchObject({
      id: first.sessionId,
    });
    await act("complete", {
      key: "pr-7",
      content: "Reviewed",
      idempotencyKey: "done-7",
    });
    expect(await act("inspect", { key: "pr-7" })).toMatchObject({
      workStatus: "completed",
    });
    await act("reopen", { key: "pr-7", idempotencyKey: "again-7" });
    expect(await act("inspect", { key: "pr-7" })).toMatchObject({
      workStatus: "open",
    });
    await expect(
      act("inspect", { key: "pr-7", sessionId: first.sessionId }),
    ).rejects.toThrow("exactly one of sessionId or key");
    await expect(act("inspect", { key: "pr-8" })).rejects.toThrow(
      "No open chat has the key pr-8",
    );
    const closed = { sessionId: first.sessionId, closed: true };
    expect(
      await act("close", { key: "pr-7", idempotencyKey: "merged-7" }),
    ).toEqual(closed);
    expect(
      await act("close", { key: "pr-7", idempotencyKey: "merged-7" }),
    ).toEqual(closed);
    expect(await act("find", { key: "pr-7" })).toBeNull();
    const detail = await sessions.get(identity, project.id, first.sessionId);
    expect(detail.status).toBe("closed");
    expect(
      (await transcriptOf(first.sessionId, project.id)).map(
        (message) => message.content,
      ),
    ).toEqual(
      expect.arrayContaining(["Review pull request 7", "Closed this chat"]),
    );
    const allocation = await db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason"])
      .where("id", "=", detail.allocationId ?? "")
      .executeTakeFirstOrThrow();
    expect(allocation).toEqual({
      status: "released",
      release_reason: "retired",
    });
    await expect(
      sessions.deliver(identity, project.id, first.sessionId, {
        content: "Too late",
        author,
        mode: "queue",
      }),
    ).rejects.toThrow();
    // Every event of a keyed chat carries its key (ADR 0181).
    const events = await exportEvents(first.sessionId);
    expect(events.map((event) => event.kind)).toContain(
      "session.state-changed",
    );
    for (const event of events)
      expect(event.payload).toMatchObject({ session: { key: "pr-7" } });
    const reopened = await sessions.chatForKey(identity, project.id, {
      key: "pr-7",
      workflowName: "reviewOnOpen",
    });
    expect(reopened.sessionCreated).toBe(true);
    expect(reopened.sessionId).not.toBe(first.sessionId);
  });

  it("delivering to an archived keyed chat brings it back and runs the turn", async () => {
    const project = await projects.create(identity, { name: "Archived key" });
    const chat = await sessions.chatForKey(identity, project.id, {
      key: "incident-9",
      workflowName: "pageOnCall",
    });
    await sessions.archive(identity, project.id, chat.sessionId, {
      confirmStop: true,
    });
    expect(
      (await sessions.get(identity, project.id, chat.sessionId)).visibility,
    ).toBe("archived");
    expect(
      await sessions.chatForKey(identity, project.id, {
        key: "incident-9",
        workflowName: "pageOnCall",
      }),
    ).toEqual({ sessionId: chat.sessionId, sessionCreated: false });
    expect(
      (await sessions.get(identity, project.id, chat.sessionId)).visibility,
    ).toBe("promoted");
    const receipt = await sessions.deliver(
      identity,
      project.id,
      chat.sessionId,
      {
        content: "The incident fired again",
        author: {
          kind: "workflow",
          runId: randomUUID(),
          workflowName: "pageOnCall",
        },
        mode: "queue",
      },
    );
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(chat.sessionId, project.id)).find(
            (turn) => turn.id === receipt.turnId,
          )?.status,
        ).toBe("completed"),
      { timeout: 10_000 },
    );
    await sessions.archive(identity, project.id, chat.sessionId, {
      confirmStop: true,
    });
    const byId = await sessions.deliver(identity, project.id, chat.sessionId, {
      content: "Still firing",
      author: { kind: "system", code: "test" },
      mode: "queue",
    });
    await vi.waitFor(
      async () =>
        expect(
          (await turnsOf(chat.sessionId, project.id)).find(
            (turn) => turn.id === byId.turnId,
          )?.status,
        ).toBe("completed"),
      { timeout: 10_000 },
    );
    expect(
      (await sessions.get(identity, project.id, chat.sessionId)).visibility,
    ).toBe("promoted");
  });

  it("publishes durable lifecycle events atomically and distinguishes work from turns", async () => {
    const project = await projects.create(identity, {
      name: "Lifecycle events",
    });
    const session = await sessions.create(identity, project.id);
    const before = await exportEvents(session.id);
    expect(before.map((event) => event.kind)).toEqual(["session.created"]);
    await expect(
      db.transaction().execute(async (trx) => {
        await trx
          .updateTable("agent_sessions")
          .set({ work_status: "completed" })
          .where("id", "=", session.id)
          .execute();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await exportEvents(session.id)).toEqual(before);
    const author = {
      kind: "workflow" as const,
      workflowName: "review",
      displayName: "Review pull requests",
      runId: randomUUID(),
    };
    const delivery = {
      content: "A durable observation",
      mode: "message_only" as const,
      author,
      idempotencyKey: "event-once",
      metadata: { causation: ["activation-1"] },
    };
    await sessions.deliver(identity, project.id, session.id, delivery);
    await sessions.deliver(identity, project.id, session.id, delivery);
    expect(
      (await snapshot(session.id, project.id)).items.find(
        (item) =>
          item.kind === "user_message" && item.text === "A durable observation",
      ),
    ).toMatchObject({ author });
    const events = await exportEvents(session.id);
    expect(
      events.filter((event) => event.kind === "session.message-received"),
    ).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({
      actor: author,
      causation: ["activation-1"],
      session: { key: null, workStatus: "open" },
    });
    await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Finish this turn",
    );
    const settled = await exportEvents(session.id);
    expect(
      settled.some(
        (event) =>
          event.kind === "session.turn-changed" &&
          JSON.stringify(event.payload).includes('"completed"'),
      ),
    ).toBe(true);
    expect(
      settled.filter((event) => event.kind === "session.message-sent"),
    ).toHaveLength(1);
    expect(settled.some((event) => event.kind === "session.work-changed")).toBe(
      false,
    );
    // A reply the harness adds already settled (no stream) is sent once too.
    await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Run command with progress",
    );
    const sent = (await exportEvents(session.id)).filter(
      (event) => event.kind === "session.message-sent",
    );
    expect(sent.map((event) => event.payload.detail)).toMatchObject([
      { status: "completed" },
      { content: "Tests passed", status: "completed" },
    ]);
  });

  it("retains message attention without push subscriptions, respects scope, and never acknowledges unseen revisions", async () => {
    const project = await projects.create(identity, {
      name: "Durable attention",
    });
    const session = await sessions.create(identity, project.id);
    const reminder = (idempotencyKey: string) =>
      sessions.deliver(identity, project.id, session.id, {
        author: { kind: "system", code: "reminder" },
        mode: "message_only",
        attention: "required",
        content: "Submit application",
        idempotencyKey,
      });
    const first = await reminder("first");
    expect(
      (await sessions.attention({ identity })).find(
        (item) => item.id === session.id,
      )?.attentionMessage,
    ).toEqual({ id: first.messageId, content: "Submit application" });
    expect(
      await sessions.attention({ identity: { ...identity, scope: [] } }),
    ).toEqual([]);
    expect(
      await sessions.attention({
        identity: { ...identity, externalUserId: "another-user" },
      }),
    ).toEqual([]);
    const event = await db
      .selectFrom("user_notification_events")
      .selectAll()
      .where("session_id", "=", session.id)
      .executeTakeFirstOrThrow();
    expect(event.route).toContain(`message=${first.messageId}`);
    await reminder("second");
    await sessions.acknowledgeAttention(identity, project.id, session.id, {
      observedRevision: 1,
    });
    expect(
      (await sessions.get(identity, project.id, session.id)).attentionRequired,
    ).toBe(true);
    await sessions.acknowledgeAttention(identity, project.id, session.id, {
      observedRevision: 2,
    });
    expect(
      (await sessions.attention({ identity })).some(
        (item) => item.id === session.id,
      ),
    ).toBe(false);
    await reminder("third");
    await sessions.archive(identity, project.id, session.id);
    expect(
      (await sessions.attention({ identity })).some(
        (item) => item.id === session.id,
      ),
    ).toBe(false);
  });

  it.each(["message_only", "queue", "interrupt"] as const)(
    "attention is atomic with %s delivery and does not survive a rollback",
    async (mode) => {
      const project = await projects.create(identity, {
        name: "Atomic delivery",
      });
      const session = await sessions.create(identity, project.id);
      const input = {
        sessionId: session.id,
        author: { kind: "system" as const, code: "test" },
        content: "Rollback reminder",
        mode,
        idempotencyKey: "rollback",
        metadata: { attention: "required" },
      };
      await expect(
        db.transaction().execute(async (trx) => {
          await sessions.deliverWithin(trx, input);
          throw new Error("Rollback");
        }),
      ).rejects.toThrow("Rollback");
      expect(
        (await sessions.get(identity, project.id, session.id))
          .attentionRevision,
      ).toBe(0);
      expect(
        await db
          .selectFrom("user_notification_events")
          .select("id")
          .where("session_id", "=", session.id)
          .execute(),
      ).toHaveLength(0);
      const receipt = await db.transaction().execute((trx) =>
        sessions.deliverWithin(trx, {
          ...input,
          content: "Committed reminder",
        }),
      );
      expect(receipt.created).toBe(true);
      expect(Boolean(receipt.turnId)).toBe(mode !== "message_only");
      expect(
        (await sessions.get(identity, project.id, session.id))
          .attentionRevision,
      ).toBe(1);
    },
  );

  // -------------------------------------------------------------------------
  // Session actions (ADR 0179)

  it("records attributed actions once, fences stale state, and retains archive history", async () => {
    const project = await projects.create(identity, {
      name: "Session actions",
    });
    const session = await sessions.create(identity, project.id);
    await db
      .insertInto("push_subscriptions")
      .values({
        tenant_id: identity.tenantId,
        external_user_id: identity.externalUserId,
        endpoint_hash: "session-action-test",
        endpoint: "https://push.invalid/qa",
        p256dh: "test",
        auth_secret: "test",
      })
      .execute();
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const author = {
      kind: "workflow" as const,
      runId: randomUUID(),
      workflowName: "finishReview",
    };
    const base = {
      identity,
      projectId: project.id,
      author,
      causation: ["activation-review"],
    };
    const notificationInput = {
      author,
      metadata: { causation: base.causation },
      content: "Review ready",
      mode: "message_only" as const,
      attention: "required" as const,
      idempotencyKey: "notify",
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        sessions.deliver(identity, project.id, session.id, notificationInput),
      ),
    );
    expect(new Set(results.map((result) => result.messageId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.turnId === null)).toBe(true);
    const notifications = await db
      .selectFrom("user_notification_events")
      .select("id")
      .where("session_id", "=", session.id)
      .execute();
    expect(notifications).toHaveLength(1);
    expect(
      (await sessions.get(identity, project.id, session.id)).attentionRevision,
    ).toBe(1);
    await expect(
      actions.execute({
        ...base,
        operation: "complete",
        args: {
          sessionId: session.id,
          content: "Done",
          idempotencyKey: "stale",
          expectedStateRevision: 0,
        },
      }),
    ).rejects.toThrow("Session state changed");
    await actions.execute({
      ...base,
      operation: "complete",
      args: {
        sessionId: session.id,
        content: "Work finished",
        idempotencyKey: "complete",
      },
    });
    const completeEvent = (await exportEvents(session.id)).find(
      (event) => event.kind === "session.work-changed",
    );
    expect(completeEvent?.payload).toMatchObject({
      actor: { kind: "workflow", runId: author.runId },
      causation: ["activation-review"],
      session: { workStatus: "completed" },
    });
    await actions.execute({
      ...base,
      operation: "archive",
      args: { sessionId: session.id, idempotencyKey: "archive" },
    });
    const detail = await sessions.get(identity, project.id, session.id);
    expect(detail.visibility).toBe("archived");
    expect(
      detail.snapshot.items.filter(
        (item) =>
          item.kind === "user_message" &&
          item.metadata.sessionAction !== undefined,
      ),
    ).toHaveLength(2);
    await actions.execute({
      ...base,
      operation: "unarchive",
      args: { sessionId: session.id, idempotencyKey: "unarchive" },
    });
    expect(
      (await sessions.get(identity, project.id, session.id)).visibility,
    ).toBe("promoted");
  });

  it("routes actions to the authoritative host and imports them once", async () => {
    const project = await projects.create(identity, {
      name: "Remote session actions",
    });
    const session = await sessions.create(identity, project.id);
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const author = {
      kind: "workflow" as const,
      runId: randomUUID(),
      workflowName: "remoteReview",
    };
    await db
      .updateTable("agent_sessions")
      .set({ authority_host_id: "remote-host" })
      .where("id", "=", session.id)
      .execute();
    await sessions.deliver(identity, project.id, session.id, {
      author,
      content: "Remote result",
      mode: "message_only",
      attention: "required",
      idempotencyKey: "remote-notify",
    });
    expect(
      (await sessions.get(identity, project.id, session.id)).attentionRevision,
    ).toBe(0);
    const items = await sessions.mailboxes.list(identity, project.id, {
      destinationHostId: "remote-host",
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.metadata?.attention).toBe("required");
    await db
      .updateTable("agent_sessions")
      .set({ authority_host_id: sessions.hostId })
      .where("id", "=", session.id)
      .execute();
    const mailboxItem = items[0];
    if (!mailboxItem) throw new Error("Expected a mailbox item");
    const item = { ...mailboxItem, destinationHostId: sessions.hostId };
    sessions.setSessionActionHandler((input) => actions.execute(input));
    await sessions.importMailbox(identity, project.id, item);
    await sessions.importMailbox(identity, project.id, item);
    expect(
      (await sessions.get(identity, project.id, session.id)).attentionRevision,
    ).toBe(1);
    expect(
      (await transcriptOf(session.id, project.id)).filter(
        (message) => message.content === "Remote result",
      ),
    ).toHaveLength(1);
  });

  it("runs only what the owner wrote from another host's mailbox; the rest is delivered to read", async () => {
    const project = await projects.create(identity, { name: "Mailbox owner" });
    const session = await sessions.create(identity, project.id);
    const base = {
      projectId: project.id,
      sessionId: session.id,
      sourceHostId: "remote",
      destinationHostId: sessions.hostId,
      authorityRevision: session.authorityRevision,
      idempotencyKey: null,
      createdAt: new Date().toISOString(),
    };
    const other = await sessions.importMailbox(identity, project.id, {
      ...base,
      id: randomUUID(),
      messageId: randomUUID(),
      content: "From someone else",
      author: { kind: "user", externalUserId: "someone-else" },
      mode: "queue",
      metadata: { ownerAuthored: false, deliveredBy: "someone-else" },
    });
    expect(other).toMatchObject({ mode: "message_only", turnId: null });
    const own = await sessions.importMailbox(identity, project.id, {
      ...base,
      id: randomUUID(),
      messageId: randomUUID(),
      content: "From the owner",
      author: { kind: "user", externalUserId: identity.externalUserId },
      mode: "queue",
      metadata: { ownerAuthored: true },
    });
    expect(own.mode).toBe("queue");
    expect(own.turnId).not.toBeNull();
    // The flag is the server's word for the item, never kept on it.
    const items = (await snapshot(session.id, project.id)).items;
    expect(
      items.some(
        (item) =>
          item.kind === "user_message" && "ownerAuthored" in item.metadata,
      ),
    ).toBe(false);
  });

  it("a retried interrupt action never interrupts a later turn", async () => {
    const project = await projects.create(identity, {
      name: "Action recovery",
    });
    const session = await sessions.create(identity, project.id);
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const base = {
      identity,
      projectId: project.id,
      author: {
        kind: "workflow" as const,
        runId: randomUUID(),
        workflowName: "recover",
      },
    };
    const input = {
      ...base,
      operation: "interrupt" as const,
      args: { sessionId: session.id, idempotencyKey: "interrupt" },
    };
    await actions.execute(input);
    // A crash after the effect but before completion was persisted.
    await db
      .updateTable("session_actions")
      .set({ status: "running", lease_expires_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    await send(project.id, session.id, "Prepare the Globex renewal deck");
    await provider.slowStarted;
    try {
      await actions.execute(input);
      expect(
        (await turnsOf(session.id, project.id))[0]?.cancellationRequested,
      ).toBe(false);
    } finally {
      provider.release();
    }
  });

  it("reads a chat's history through one message and names the chat's key (ADR 0179)", async () => {
    const project = await projects.create(identity, { name: "History" });
    const session = await sessions.create(identity, project.id);
    await db
      .updateTable("agent_sessions")
      .set({ chat_key: "slack:C1:1.2" })
      .where("id", "=", session.id)
      .execute();
    const ids: string[] = [];
    for (const content of ["first", "second", "third"]) {
      const delivered = await sessions.deliver(
        identity,
        project.id,
        session.id,
        {
          content,
          author: { kind: "user", externalUserId: identity.externalUserId },
          mode: "message_only",
          idempotencyKey: content,
        },
      );
      ids.push(delivered.messageId);
    }
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const history = (args: Record<string, unknown>) =>
      actions.execute({
        identity,
        projectId: project.id,
        operation: "history",
        args: { sessionId: session.id, ...args },
        author: { kind: "user", externalUserId: identity.externalUserId },
      });
    const contents = (result: unknown) =>
      JSON.stringify(result).match(/"content":"(first|second|third)"/g);
    expect(await history({ limit: 2 })).toMatchObject({
      sessionId: session.id,
      key: "slack:C1:1.2",
    });
    expect(contents(await history({ limit: 2 }))).toEqual([
      '"content":"second"',
      '"content":"third"',
    ]);
    expect(contents(await history({ through: ids[1], limit: 1 }))).toEqual([
      '"content":"second"',
    ]);
    expect(contents(await history({ through: ids[1] }))).toEqual([
      '"content":"first"',
      '"content":"second"',
    ]);
    await expect(history({ through: randomUUID() })).rejects.toThrow(
      "No message in this chat has that id",
    );
  });

  it("retries workflow child creation without duplicating a delegated session", async () => {
    const project = await projects.create(identity, {
      name: "Workflow delegation",
    });
    const session = await sessions.create(identity, project.id, {
      agentId: "orchestrator",
    });
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const input = {
      identity,
      projectId: project.id,
      author: {
        kind: "workflow" as const,
        runId: randomUUID(),
        workflowName: "delegate",
      },
      causation: ["delegate-activation"],
      operation: "spawn" as const,
      args: {
        sessionId: session.id,
        task: "Inspect the result",
        routeId: "small-only",
        idempotencyKey: "child",
      },
    };
    const first = await actions.execute(input);
    expect(await actions.execute(input)).toEqual(first);
    const children = await sessions.listSubsessions(
      identity,
      project.id,
      session.id,
    );
    expect(children).toHaveLength(1);
    const events = await exportEvents(children[0]?.session.id ?? "");
    expect(
      events.find((event) => event.kind === "session.created")?.payload,
    ).toMatchObject({
      actor: { kind: "workflow", runId: input.author.runId },
      causation: input.causation,
    });
  });

  // -------------------------------------------------------------------------
  // Copies of a log: mirrors and forks (ADR 0197)

  it("mirrors a session's log once, with its original workflow events, and refuses others' events", async () => {
    const project = await projects.create(identity, { name: "Mirrored log" });
    // The source: a real session's settled history, as a desktop holds it.
    const source = await sessions.create(identity, project.id);
    await sessions.sendMessage(identity, project.id, source.id, "Mirror me");
    const sessionId = randomUUID();
    const copy = copySettledHistory({
      snapshot: await readFullSnapshot({ db, sessionId: source.id }),
      sessionId,
    });
    if (!copy) throw new Error("Expected a copy");
    const event = {
      id: randomUUID(),
      kind: "session.work-changed",
      occurredAt: new Date().toISOString(),
      payload: {
        sessionId,
        externalUserId: "source-user",
        agentId: null,
        session: { id: sessionId, workStatus: "completed", stateRevision: 7 },
        actor: { kind: "workflow", workflowName: "review" },
        causation: ["upstream"],
      },
    };
    const input = {
      authority: { hostId: "desktop-origin", revision: 1 },
      todos: [],
      workStatus: "completed" as const,
      base: copy.snapshot,
      events: [],
      projectEvents: [event],
    };
    const first = await sessions.mirror(identity, project.id, sessionId, input);
    expect(first).toMatchObject({
      workStatus: "completed",
      sequence: copy.snapshot.sequence,
    });
    const { base: _base, ...again } = input;
    await sessions.mirror(identity, project.id, sessionId, again);
    const events = await exportEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: event.id,
      payload: {
        externalUserId: identity.externalUserId,
        causation: ["upstream"],
      },
    });
    expect(
      (await transcriptOf(sessionId, project.id)).map(
        (message) => message.content,
      ),
    ).toContain("Mirror me");
    await expect(
      sessions.mirror(identity, project.id, sessionId, {
        ...again,
        projectEvents: [
          {
            ...event,
            id: randomUUID(),
            payload: { ...event.payload, sessionId: randomUUID() },
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("forks settled history without publishing it as newly received messages", async () => {
    const project = await projects.create(identity, {
      name: "Fork event history",
    });
    const parent = await sessions.create(identity, project.id);
    await sessions.deliver(identity, project.id, parent.id, {
      content: "Historical message",
      author: { kind: "user", externalUserId: identity.externalUserId },
      mode: "message_only",
      idempotencyKey: "history",
    });
    const child = await sessions.fork(identity, project.id, parent.id);
    expect(
      (await exportEvents(child.id)).some((event) =>
        JSON.stringify(event.payload).includes("Historical message"),
      ),
    ).toBe(false);
    expect(
      (await transcriptOf(child.id, project.id)).some(
        (message) => message.content === "Historical message",
      ),
    ).toBe(true);
  });

  it("keeps a mirror inside its own session: no foreign records, no settings beyond presentation", async () => {
    const project = await projects.create(identity, { name: "Mirror fence" });
    const victim = await sessions.create(identity, project.id);
    await sessions.sendMessage(identity, project.id, victim.id, "Private work");
    const victimItem = (await snapshot(victim.id, project.id)).items[0];
    if (!victimItem) throw new Error("Expected an item");
    const sessionId = randomUUID();
    const source = await sessions.create(identity, project.id);
    await sessions.sendMessage(identity, project.id, source.id, "Mine");
    const copy = copySettledHistory({
      snapshot: await readFullSnapshot({ db, sessionId: source.id }),
      sessionId,
    });
    if (!copy) throw new Error("Expected a copy");
    const push = {
      authority: { hostId: "desktop-origin", revision: 1 },
      todos: [],
      base: copy.snapshot,
      events: [],
    };
    // An item of another session, under its own id or carried in the base.
    const injected = { ...victimItem, text: "Rewritten" };
    await expect(
      sessions.mirror(identity, project.id, sessionId, {
        ...push,
        base: {
          ...copy.snapshot,
          items: [...copy.snapshot.items, { ...injected, sessionId }],
        },
      }),
    ).rejects.toThrow("another session");
    await expect(
      sessions.mirror(identity, project.id, sessionId, {
        ...push,
        base: { ...copy.snapshot, items: [...copy.snapshot.items, injected] },
      }),
    ).rejects.toThrow("another session");
    expect((await snapshot(victim.id, project.id)).items[0]).toMatchObject({
      text: victimItem.kind === "user_message" ? victimItem.text : "",
    });
    // A request under another session's request id: lookups by that id
    // must never find the copy's instead.
    const now = new Date().toISOString();
    const victimRequest: RuntimeRequest = {
      id: randomUUID(),
      sessionId: victim.id,
      turnId: null,
      attemptId: null,
      itemId: null,
      kind: "approval",
      status: "pending",
      answerable: true,
      blocking: true,
      title: "Deploy?",
      description: null,
      origin: { kind: "host", id: "gateway", displayName: "Gateway" },
      questions: null,
      approval: { action: "deploy" },
      elicitation: null,
      approvers: [],
      expiresAt: null,
      response: null,
      resolvedBy: null,
      reason: null,
      createdAt: now,
      resolvedAt: null,
    };
    await db.transaction().execute((trx) =>
      new SessionLog(db).append(trx, {
        sessionId: victim.id,
        events: [{ type: "request.changed", request: victimRequest }],
      }),
    );
    await expect(
      sessions.mirror(identity, project.id, sessionId, {
        ...push,
        base: {
          ...copy.snapshot,
          requests: [
            {
              ...victimRequest,
              sessionId,
              status: "resolved",
              response: { kind: "approval", decision: "approved" },
            },
          ],
        },
      }),
    ).rejects.toThrow("another session");
    // A clean copy, then a session change naming another agent and host.
    const first = await sessions.mirror(identity, project.id, sessionId, push);
    await sessions.mirror(identity, project.id, sessionId, {
      authority: push.authority,
      events: [
        {
          sessionId,
          sequence: first.sequence + 1,
          at: new Date().toISOString(),
          commandId: null,
          event: {
            type: "session.changed",
            session: {
              title: "Renamed",
              agentId: "builder",
              authorityHostId: sessions.hostId,
              parentSessionId: victim.id,
            },
          },
        },
      ],
    });
    const row = await db
      .selectFrom("agent_sessions")
      .select(["title", "agent_id", "authority_host_id", "parent_session_id"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      title: "Renamed",
      authority_host_id: "desktop-origin",
      parent_session_id: null,
    });
    expect(row.agent_id).not.toBe("builder");
  });

  it("replaces a mirror that logged nothing with its source's base, and never one with a log of its own", async () => {
    const project = await projects.create(identity, {
      name: "Converted mirror",
    });
    const source = await sessions.create(identity, project.id);
    await sessions.sendMessage(identity, project.id, source.id, "Before");
    const sessionId = randomUUID();
    const baseOf = async () => {
      const copy = copySettledHistory({
        snapshot: await readFullSnapshot({ db, sessionId: source.id }),
        sessionId,
      });
      if (!copy) throw new Error("Expected a copy");
      return copy.snapshot;
    };
    const authority = { hostId: "desktop-origin", revision: 1 };
    await sessions.mirror(identity, project.id, sessionId, {
      authority,
      todos: [],
      base: await baseOf(),
      events: [],
    });
    // As migration 045 leaves a mirror: its history and a sequence that
    // means nothing to the source, with nothing logged.
    await db
      .updateTable("agent_sessions")
      .set({ event_sequence: 1_000 })
      .where("id", "=", sessionId)
      .execute();
    await sessions.sendMessage(identity, project.id, source.id, "After");
    const base = await baseOf();
    expect(base.sequence).toBeLessThan(1_000);
    const change = (sequence: number, title: string) => ({
      sessionId,
      sequence,
      at: new Date().toISOString(),
      commandId: null,
      event: { type: "session.changed" as const, session: { title } },
    });

    // The base replaces the converted copy whole; the log continues from it.
    const replaced = await sessions.mirror(identity, project.id, sessionId, {
      authority,
      base,
      events: [change(base.sequence + 1, "Continued")],
    });
    expect(replaced).toMatchObject({
      sequence: base.sequence + 1,
      title: "Continued",
    });
    const texts = (await snapshot(sessionId, project.id)).items.flatMap(
      (item) => (item.kind === "user_message" ? [item.text] : []),
    );
    expect(texts).toEqual(["Before", "After"]);

    // Now it has a log of its own: a stale base changes nothing.
    await sessions.mirror(identity, project.id, sessionId, {
      authority,
      base: { ...base, items: [] },
      events: [],
    });
    expect(
      (await snapshot(sessionId, project.id)).items.flatMap((item) =>
        item.kind === "user_message" ? [item.text] : [],
      ),
    ).toEqual(["Before", "After"]);
  });
});
