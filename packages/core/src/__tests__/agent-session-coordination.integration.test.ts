import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  SandboxProvider,
  StartSessionOpts,
  TurnOptions,
} from "@catamorphic/sandbox";
import { isQuestionReply } from "@catamorphic/sandbox";
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
import { testEnvironmentProvider } from "./test-environment.js";

class DeferredProvider implements CodingAgentProvider {
  readonly name = "deferred";
  questionTurn?: (options: TurnOptions) => AsyncIterable<AgentEvent>;
  private releaseSlow: (() => void) | undefined;
  private transientAttempts = 0;
  private connectionAttempts = 0;
  slowStarted: Promise<void> = Promise.resolve();
  private markSlowStarted: (() => void) | undefined;
  switchCheckout?: (session: ProviderSession) => string;

  constructor() {
    this.resetSlow();
  }

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    return {
      providerSessionId: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
    options?: TurnOptions,
  ): AsyncIterable<AgentEvent> {
    if (message.startsWith("questions:") && this.questionTurn && options) {
      yield* this.questionTurn(options);
      return;
    }
    if (message === "Run command with progress") {
      for (const toolUseId of ["first", "second"]) {
        yield {
          type: "command",
          toolUseId,
          status: "started",
          content: "bun test",
        };
        yield {
          type: "command",
          toolUseId,
          status: "ended",
          content: "bun test\nok",
        };
      }
      yield { type: "text", content: "Tests passed" };
    }
    if (message.includes("Reconnect durable turn")) {
      this.connectionAttempts += 1;
      if (this.connectionAttempts === 1) {
        yield {
          type: "error",
          content: "Request rejected before execution",
          errorKind: "unavailable",
          retrySafe: true,
        };
        yield { type: "done" };
        return;
      }
      yield { type: "text", content: "Connection restored" };
    }
    if (message.includes("Truncated stream")) {
      yield { type: "text", content: "Partial work" };
      return;
    }
    if (message.includes("Permanent delegated failure")) {
      yield {
        type: "error",
        content: "Credentials revoked",
        errorKind: "auth",
      };
      yield { type: "done" };
      return;
    }
    if (message.includes("Recover delegated work")) {
      this.transientAttempts += 1;
      if (this.transientAttempts === 1) {
        yield {
          type: "error",
          content: "Temporarily unavailable",
          errorKind: "unavailable",
          retrySafe: true,
        };
        yield { type: "done" };
        return;
      }
    }
    if (message.includes("Prepare the Globex renewal deck")) {
      this.markSlowStarted?.();
      await new Promise<void>((resolve) => {
        this.releaseSlow = resolve;
      });
    }
    if (message === "Switch checkout and edit") {
      const checkout = this.switchCheckout?.(session);
      if (checkout) {
        yield {
          type: "file_edit",
          content: "write",
          filePath: path.join(checkout, "result.md"),
        };
      }
    }
    yield { type: "done" };
  }

  release(): void {
    this.releaseSlow?.();
    this.resetSlow();
  }

  interrupt(): void {
    this.release();
  }

  async dispose(): Promise<void> {}

  private resetSlow(): void {
    this.slowStarted = new Promise<void>((resolve) => {
      this.markSlowStarted = resolve;
    });
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

describe("agent session coordination", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let answerReceiver: AgentSessionsService;
  let projects: ProjectsService;
  let provider: DeferredProvider;
  const checkpointedSessions: string[] = [];
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

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-core-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    provider = new DeferredProvider();
    const registeredAgent = (
      id: string,
      input: Pick<RegisteredCodingAgent, "sandboxing" | "delegation"> = {},
    ): RegisteredCodingAgent => ({
      id,
      provider,
      topology: "native",
      ...input,
    });
    const agents = new Map(
      [
        registeredAgent("worker"),
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
              {
                id: "any-lower",
                target: "*",
                allowFurtherDelegation: true,
              },
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
    answerReceiver = new AgentSessionsService(db, {
      hostId: "coordination-test-host",
      projectManager,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "worker",
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
      },
    });
    sessions = new AgentSessionsService(db, {
      hostId: "coordination-test-host",
      projectManager,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "worker",
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
      },
      nativeAgentCheckout: {
        resolve: ({ projectId, sessionId }) => ({
          path:
            checkoutBySession.get(sessionId) ?? path.join(tmpDir, projectId),
          owned: checkoutBySession.has(sessionId),
        }),
        checkpoint: ({ sessionId, workingDirectory }) => {
          checkpointedSessions.push(sessionId);
          checkpointedTurns.push({ sessionId, workingDirectory });
          return Promise.resolve(null);
        },
      },
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

  it("persists non-blocking batches and delivers answers during the running turn exactly once", async () => {
    const project = await projects.create(identity, {
      name: "Non-blocking questions",
    });
    const session = await sessions.create(identity, project.id);
    const proceed = deferred<void>();
    provider.questionTurn = async function* (options) {
      await options.askQuestion?.({
        requestId: "theme",
        blocking: false,
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
      });
      yield { type: "text", content: "Continuing independent work" };
      yield { type: "tool_call", toolName: "read" };
      await proceed.promise;
      const messages = (await options.readPendingMessages?.()) ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toContain("Orange and compact");
      await options.acknowledgeMessages?.({
        ids: messages.map((entry) => entry.id),
      });
      yield { type: "text", content: "Answer received in the original turn" };
      yield { type: "done" };
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: keep working",
    );
    try {
      await vi.waitFor(async () =>
        expect(
          (await sessions.get(identity, project.id, session.id)).questions,
        ).toHaveLength(1),
      );
      const detail = await sessions.get(identity, project.id, session.id);
      const request = detail.questions?.[0];
      if (!request) throw new Error("Question was not persisted");
      expect(request.blocking).toBe(false);
      expect(request.questions).toHaveLength(2);
      const args = {
        identity,
        projectId: project.id,
        sessionId: session.id,
        requestId: request.requestId,
        answer: "Orange and compact",
      };
      const [first, duplicate] = await Promise.all([
        sessions.answerQuestion(args),
        sessions.answerQuestion(args),
      ]);
      expect(first.messageId).toBe(duplicate.messageId);
      await expect(
        sessions.answerQuestion({ ...args, answer: "A conflicting answer" }),
      ).rejects.toThrow("no longer pending");
      expect(
        (await sessions.get(identity, project.id, session.id)).questions,
      ).toHaveLength(0);
    } finally {
      proceed.resolve();
    }
    const result = await turn;
    expect(result.content).toBe("Answer received in the original turn");
    expect(
      (await sessions.get(identity, project.id, session.id)).pendingTurns,
    ).toHaveLength(0);
    expect(
      (await sessions.get(identity, project.id, session.id)).messages.filter(
        (entry) => entry.content.includes("User answer:"),
      ),
    ).toHaveLength(1);
  });

  it("keeps unanswered requests after a turn and continues when a late answer arrives", async () => {
    const project = await projects.create(identity, { name: "Late answers" });
    const session = await sessions.create(identity, project.id);
    provider.questionTurn = async function* (options) {
      for (const requestId of ["color", "layout"]) {
        await options.askQuestion?.({
          requestId,
          blocking: false,
          questions: [
            {
              question: `Choose ${requestId}`,
              header: requestId,
              multiSelect: false,
              options: [],
            },
          ],
        });
      }
      yield { type: "text", content: "Independent work finished" };
      yield { type: "done" };
    };
    await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: finish first",
    );
    const detail = await sessions.get(identity, project.id, session.id);
    expect(detail.questions).toHaveLength(2);
    const request = detail.questions?.[1];
    if (!request) throw new Error("Question was not persisted");
    const otherSession = await sessions.create(identity, project.id);
    await expect(
      sessions.answerQuestion({
        identity,
        projectId: project.id,
        sessionId: otherSession.id,
        requestId: request.requestId,
        answer: "Compact",
      }),
    ).rejects.toThrow("not found");
    const receipt = await sessions.answerQuestion({
      identity,
      projectId: project.id,
      sessionId: session.id,
      requestId: request.requestId,
      answer: "Compact",
    });
    expect(receipt.turnId).not.toBeNull();
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).pendingTurns,
      ).toHaveLength(0),
    );
    const resumed = await sessions.get(identity, project.id, session.id);
    expect(resumed.questions?.map((entry) => entry.title)).toEqual(["color"]);
    expect(
      resumed.messages.some(
        (entry) =>
          entry.role === "user" &&
          entry.content.includes("Choose layout") &&
          entry.content.includes("Compact"),
      ),
    ).toBe(true);
  });

  it("consumes a blocking answer received by another service without steering or starting another turn", async () => {
    const project = await projects.create(identity, {
      name: "Blocking questions",
    });
    const session = await sessions.create(identity, project.id);
    const continued = vi.fn();
    provider.questionTurn = async function* (options) {
      const answer = await options.askQuestion?.({
        requestId: "choice",
        blocking: true,
        questions: [
          {
            question: "Choose a theme",
            header: "Theme",
            multiSelect: false,
            options: [],
          },
        ],
      });
      expect(await options.readPendingMessages?.()).toEqual([]);
      continued(answer);
      yield { type: "text", content: `Using ${answer}` };
      yield { type: "done" };
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: wait",
    );
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).questions,
      ).toHaveLength(1),
    );
    expect(continued).not.toHaveBeenCalled();
    // A blocking ask waits inside the running harness: the turn runs, and
    // another service refuses changes to the chat (ADR 0193).
    expect(
      (await answerReceiver.get(identity, project.id, session.id)).running,
    ).toBe(true);
    await expect(
      answerReceiver.update(identity, project.id, session.id, {
        effort: "high",
      }),
    ).rejects.toBeInstanceOf(AgentTurnInProgressError);
    await expect(
      answerReceiver.retry(identity, project.id, session.id),
    ).rejects.toBeInstanceOf(AgentTurnInProgressError);
    const request = (await sessions.get(identity, project.id, session.id))
      .questions?.[0];
    if (!request) throw new Error("Question was not persisted");
    const receipt = await answerReceiver.answerQuestion({
      identity,
      projectId: project.id,
      sessionId: session.id,
      requestId: request.requestId,
      answer: "Orange",
    });
    expect(receipt.turnId).not.toBeNull();
    await turn;
    expect(continued).toHaveBeenCalledExactlyOnceWith("Orange");
    const detail = await sessions.get(identity, project.id, session.id);
    expect(detail.pendingTurns).toEqual([]);
    expect(
      detail.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
    const delivery = await db
      .selectFrom("agent_turns")
      .select(["status", "result_message_id"])
      .where("id", "=", receipt.turnId!)
      .executeTakeFirstOrThrow();
    expect(delivery.status).toBe("completed");
    expect(delivery.result_message_id).toBe(
      detail.messages.find((message) => message.role === "assistant")?.id,
    );
  });

  it("withdraws cancelled blocking questions and rejects stale answers", async () => {
    const project = await projects.create(identity, {
      name: "Cancelled consent",
    });
    const session = await sessions.create(identity, project.id);
    const abort = new AbortController();
    provider.questionTurn = async function* (options) {
      await options.askQuestion?.({
        requestId: "consent",
        blocking: true,
        signal: abort.signal,
        questions: [
          {
            header: "Permission",
            question: "May I update this file?",
            multiSelect: false,
            options: [],
          },
        ],
      });
      yield { type: "done" };
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: consent",
    );
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).questions,
      ).toHaveLength(1),
    );
    const request = (await sessions.get(identity, project.id, session.id))
      .questions?.[0];
    if (!request) throw new Error("Consent was not persisted");
    abort.abort();
    await turn;
    expect(
      (await sessions.get(identity, project.id, session.id)).questions,
    ).toEqual([]);
    await expect(
      answerReceiver.answerQuestion({
        identity,
        projectId: project.id,
        sessionId: session.id,
        requestId: request.requestId,
        answer: "Allow once",
      }),
    ).rejects.toThrow();
  });

  it("gives way to a chat message: the question stays open, the message steers in order, and a later answer still arrives (ADR 0196)", async () => {
    const project = await projects.create(identity, {
      name: "Replies during questions",
    });
    const session = await sessions.create(identity, project.id);
    const steered: Array<{ content: string; attachments?: unknown }> = [];
    let reply: string | undefined;
    provider.questionTurn = async function* (options) {
      try {
        await options.askQuestion?.({
          requestId: "layout",
          blocking: true,
          questions: [
            {
              question: "Grid or list?",
              header: "Layout",
              multiSelect: false,
              options: [
                { label: "Grid", description: "" },
                { label: "List", description: "" },
              ],
            },
          ],
        });
      } catch (error) {
        if (!isQuestionReply(error)) throw error;
        reply = error.message;
      }
      const input = (await options.readPendingMessages?.()) ?? [];
      steered.push(
        ...input.map(({ content, attachments }) => ({ content, attachments })),
      );
      await options.acknowledgeMessages?.({
        ids: input.map((entry) => entry.id),
      });
      yield { type: "text", content: "Grid packs more in." };
      yield { type: "done" };
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: reply",
    );
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).questions,
      ).toHaveLength(1),
    );
    const attachment = {
      kind: "text" as const,
      name: "notes.md",
      text: "Context",
      source: { type: "paste" as const },
    };
    await sessions.enqueueMessage(
      identity,
      project.id,
      session.id,
      "What is the difference?",
      { attachments: [attachment] },
    );
    await turn;
    expect(reply).toContain("stays open");
    expect(steered).toEqual([
      { content: "What is the difference?", attachments: [attachment] },
    ]);
    const detail = await sessions.get(identity, project.id, session.id);
    expect(detail.pendingTurns).toEqual([]);
    expect(detail.questions).toEqual([
      expect.objectContaining({ blocking: false }),
    ]);
    // The reply reads after the message it answers.
    const contents = detail.messages.map((message) => message.content);
    expect(contents.indexOf("What is the difference?")).toBeLessThan(
      contents.indexOf("Grid packs more in."),
    );
    const requestId = detail.questions?.[0]?.requestId ?? "";
    const receipt = await sessions.answerQuestion({
      identity,
      projectId: project.id,
      sessionId: session.id,
      requestId,
      answer: "Grid",
    });
    expect(receipt.turnId).not.toBeNull();
    const answer = await db
      .selectFrom("agent_messages")
      .select("metadata")
      .where("idempotency_key", "=", `question-answer:${requestId}`)
      .executeTakeFirstOrThrow();
    expect(answer.metadata).toMatchObject({
      inTurn: true,
      question: {
        answer: "Grid",
        questions: [expect.objectContaining({ question: "Grid or list?" })],
      },
    });
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).pendingTurns,
      ).toEqual([]),
    );
  });

  it("withdraws a consent request a chat message arrives during, and closes only the agent's own questions", async () => {
    const project = await projects.create(identity, {
      name: "Replies during consent",
    });
    const session = await sessions.create(identity, project.id);
    const outcomes: string[] = [];
    let closed: string | undefined;
    provider.questionTurn = async function* (options) {
      await options.askQuestion?.({
        requestId: "later",
        blocking: false,
        questions: [
          {
            question: "Any naming preference?",
            header: "Naming",
            multiSelect: false,
            options: [],
          },
        ],
      });
      try {
        await options.askQuestion?.({
          requestId: "permission",
          blocking: true,
          consent: true,
          questions: [
            {
              question: "May I delete the branch?",
              header: "Permission",
              multiSelect: false,
              options: [{ label: "Allow once", description: "" }],
            },
          ],
        });
        outcomes.push("answered");
      } catch (error) {
        outcomes.push(isQuestionReply(error) ? "withdrawn" : "failed");
      }
      closed = await options.closeQuestions?.({});
      yield { type: "done" };
    };
    const turn = sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "questions: consent reply",
    );
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).questions,
      ).toHaveLength(2),
    );
    expect(
      (await sessions.get(identity, project.id, session.id)).questions?.map(
        (request) => request.consent === true,
      ),
    ).toEqual([false, true]);
    await sessions.enqueueMessage(
      identity,
      project.id,
      session.id,
      "Keep the branch",
    );
    await turn;
    expect(outcomes).toEqual(["withdrawn"]);
    expect(closed).toMatch(/^Closed .*:later\.$/);
    expect(
      (await sessions.get(identity, project.id, session.id)).questions,
    ).toEqual([]);
    // The message the consent gave way to still runs as its own turn.
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).pendingTurns,
      ).toEqual([]),
    );
    expect(
      (await sessions.get(identity, project.id, session.id)).messages.some(
        (message) => message.content === "Keep the branch",
      ),
    ).toBe(true);
  });

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("recovers a persisted reconnect through the worker without duplicating the user message", async () => {
    const project = await projects.create(identity, {
      name: "Durable reconnect",
    });
    const session = await sessions.create(identity, project.id);
    const failed = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Reconnect durable turn",
    );
    expect(failed.metadata).toMatchObject({
      status: "failed",
      errorKind: "unavailable",
    });
    const pending = await sessions.turns.listPending({ sessionId: session.id });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: "queued",
      attempt: 1,
      resultMessageId: failed.id,
    });
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        expect(detail.messages.at(-1)?.content).toBe("Connection restored");
        expect(
          detail.messages.filter((message) => message.role === "user"),
        ).toHaveLength(1);
        expect(
          await sessions.turns.listPending({ sessionId: session.id }),
        ).toEqual([]);
      });
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
    await sessions.sendMessage(
      projectChat,
      project.id,
      session.id,
      "Reconnect durable turn",
    );
    await db
      .updateTable("agent_turns")
      .set({ available_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    // The host's member lookup knows nobody for the project principal.
    const worker = sessions.startWorker({
      resolveIdentity: async () => null,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(async () => {
        const detail = await sessions.get(projectChat, project.id, session.id);
        expect(detail.messages.at(-1)?.content).toBe("Connection restored");
        expect(
          await sessions.turns.listPending({ sessionId: session.id }),
        ).toEqual([]);
      });
    } finally {
      await worker.stop();
    }
  });

  it("enriches started command rows without duplicating completed steps", async () => {
    const project = await projects.create(identity, {
      name: "Command progress",
    });
    const session = await sessions.create(identity, project.id);
    const reply = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Run command with progress",
    );
    // Each row keeps when its command started and when it ended.
    const at = expect.any(Number);
    expect(reply.metadata?.events).toEqual([
      {
        type: "command",
        toolUseId: "first",
        status: "ended",
        content: "bun test\nok",
        at,
        endedAt: at,
      },
      {
        type: "command",
        toolUseId: "second",
        status: "ended",
        content: "bun test\nok",
        at,
        endedAt: at,
      },
      { type: "text", content: "Tests passed", at },
      { type: "done", at },
    ]);
  });

  it("marks a truncated stream failed instead of treating its preamble as success", async () => {
    const project = await projects.create(identity, {
      name: "Truncated response",
    });
    const session = await sessions.create(identity, project.id);
    const failed = await sessions.sendMessage(
      identity,
      project.id,
      session.id,
      "Truncated stream",
    );
    expect(failed.metadata).toMatchObject({
      status: "failed",
      errorKind: "unavailable",
    });
    expect(await sessions.turns.listPending({ sessionId: session.id })).toEqual(
      [],
    );
    await sessions.interrupt(identity, project.id, session.id);
    expect(await sessions.turns.listPending({ sessionId: session.id })).toEqual(
      [],
    );
  });

  it("replays a send-now receipt without interrupting the accepted turn", async () => {
    const project = await projects.create(identity, {
      name: "Lost acknowledgement",
    });
    const session = await sessions.create(identity, project.id);
    const input = {
      deliveryMode: "interrupt" as const,
      idempotencyKey: crypto.randomUUID(),
    };
    const accepted = await sessions.enqueueMessage(
      identity,
      project.id,
      session.id,
      "Prepare the Globex renewal deck",
      input,
    );
    await provider.slowStarted;
    try {
      const replay = await sessions.enqueueMessage(
        identity,
        project.id,
        session.id,
        "Prepare the Globex renewal deck",
        input,
      );
      expect(replay).toMatchObject({
        messageId: accepted.messageId,
        turnId: accepted.turnId,
        created: false,
      });
      const detail = await sessions.get(identity, project.id, session.id);
      expect(detail.execution).toMatchObject({
        status: "running",
        cancellationRequested: false,
      });
      expect(
        detail.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
    } finally {
      provider.release();
    }
    await vi.waitFor(async () =>
      expect(
        (await sessions.get(identity, project.id, session.id)).execution
          ?.status,
      ).toBe("completed"),
    );
  });

  it.each(["direct", "mailbox"])(
    "does not interrupt accepted work when %s delivery is replayed",
    async (transport) => {
      const project = await projects.create(identity, {
        name: "Replayed delivery",
      });
      const session = await sessions.create(identity, project.id);
      const key = crypto.randomUUID();
      const content = "Prepare the Globex renewal deck";
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
              messageId: crypto.randomUUID(),
              content,
              author: { kind: "user", externalUserId: identity.externalUserId },
              mode: "interrupt",
              idempotencyKey: key,
              metadata: null,
              createdAt: new Date().toISOString(),
            });
      const interrupted = vi.spyOn(provider, "interrupt");
      try {
        const accepted = await deliver();
        await provider.slowStarted;
        expect(await deliver()).toMatchObject({
          messageId: accepted.messageId,
          turnId: accepted.turnId,
          created: false,
        });
        expect(interrupted).not.toHaveBeenCalled();
        expect(
          (await sessions.get(identity, project.id, session.id)).execution,
        ).toMatchObject({ status: "running", cancellationRequested: false });
      } finally {
        interrupted.mockRestore();
        provider.release();
      }
      await vi.waitFor(async () =>
        expect(
          (await sessions.get(identity, project.id, session.id)).execution
            ?.status,
        ).toBe("completed"),
      );
    },
  );

  it("recovers expired execution even when its local provider has not returned", async () => {
    const project = await projects.create(identity, {
      name: "Stalled executor",
    });
    const session = await sessions.create(identity, project.id);
    const outcome = sessions
      .sendMessage(
        identity,
        project.id,
        session.id,
        "Prepare the Globex renewal deck",
      )
      .catch(() => null);
    await provider.slowStarted;
    await db
      .updateTable("agent_turns")
      .set({ lease_expires_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        expect(detail.execution?.status).toBe("failed");
        expect(detail.messages.at(-1)?.metadata).toMatchObject({
          status: "failed",
          unexpectedStop: true,
        });
      });
    } finally {
      await worker.stop();
      provider.release();
      await outcome;
    }
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
      { task: "Permanent delegated failure" },
    );
    await vi.waitFor(async () => {
      const detail = await sessions.get(identity, project.id, child.session.id);
      expect(detail.visibility).toBe("promoted");
      expect(detail.attentionRequired).toBe(true);
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("failed");
    });
  });

  it("recovers child result delivery without replaying completed work", async () => {
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
        { task: "Publish this result reliably" },
      );
      await vi.waitFor(async () => {
        const turns = await db
          .selectFrom("agent_turns")
          .selectAll()
          .where("session_id", "=", child.session.id)
          .execute();
        expect(turns).toEqual([
          expect.objectContaining({ status: "completed", attempt: 1 }),
        ]);
        expect(delivery).toHaveBeenCalled();
      });
      delivery.mockRestore();
      worker = sessions.startWorker({
        resolveIdentity: async () => identity,
        pollIntervalMs: 10,
      });
      await vi.waitFor(async () => {
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("completed");
        const parentDetail = await sessions.get(
          identity,
          project.id,
          parent.id,
        );
        expect(
          parentDetail.messages.filter(
            (message) =>
              message.author.kind === "agent" &&
              message.author.sessionId === child.session.id,
          ),
        ).toHaveLength(1);
      });
      expect(
        await db
          .selectFrom("agent_turns")
          .select(["status", "attempt"])
          .where("session_id", "=", child.session.id)
          .execute(),
      ).toEqual([{ status: "completed", attempt: 1 }]);
    } finally {
      delivery.mockRestore();
      await worker?.stop();
    }
  });

  it.each(["expired", "recovered"])(
    "fences a late provider result after execution ownership is %s",
    async (state) => {
      const project = await projects.create(identity, {
        name: "Late executor",
      });
      const session = await sessions.create(identity, project.id);
      const settledBefore = settledTurns.length;
      const outcome = sessions
        .sendMessage(
          identity,
          project.id,
          session.id,
          "Prepare the Globex renewal deck",
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      await provider.slowStarted;
      try {
        const turn = await db
          .selectFrom("agent_turns")
          .selectAll()
          .where("session_id", "=", session.id)
          .executeTakeFirstOrThrow();
        if (!turn.result_message_id) throw new Error("Missing live reply");
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable("agent_turns")
            .set({
              lease_expires_at: new Date(0),
              ...(state === "recovered"
                ? { status: "failed", lease_token: null }
                : {}),
            })
            .where("id", "=", turn.id)
            .execute();
          await trx
            .updateTable("agent_messages")
            .set({
              content: "Recovery owns this outcome",
              metadata: { status: "failed", unexpectedStop: true },
            })
            .where("id", "=", turn.result_message_id)
            .execute();
        });
      } finally {
        provider.release();
      }
      await outcome;
      const detail = await sessions.get(identity, project.id, session.id);
      expect(detail.messages.at(-1)).toMatchObject({
        content: "Recovery owns this outcome",
        metadata: { status: "failed", unexpectedStop: true },
      });
      expect(settledTurns).toHaveLength(settledBefore);
    },
  );

  it("makes a crash before the first reply visible without rerunning the request", async () => {
    const project = await projects.create(identity, {
      name: "Pre-reply crash",
    });
    const session = await sessions.create(identity, project.id);
    const receipt = await sessions.turns.deliver({
      sessionId: session.id,
      content: "Accepted before crash",
      author: { kind: "user", externalUserId: identity.externalUserId },
      mode: "queue",
    });
    await sessions.turns.claimNextForSession({
      sessionId: session.id,
      workerId: "dead",
    });
    await db
      .updateTable("agent_turns")
      .set({ lease_expires_at: new Date(0) })
      .where("id", "=", receipt.turnId)
      .execute();
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        expect(detail.execution).toMatchObject({
          status: "failed",
          attempt: 1,
        });
        expect(detail.messages).toHaveLength(2);
        expect(detail.messages.at(-1)?.metadata).toMatchObject({
          status: "failed",
          unexpectedStop: true,
        });
      });
    } finally {
      await worker.stop();
    }
  });

  it("does not settle another executor's live lease when reading its session", async () => {
    const project = await projects.create(identity, { name: "Live lease" });
    const session = await sessions.create(identity, project.id);
    await sessions.turns.deliver({
      sessionId: session.id,
      content: "Pending",
      author: { kind: "user", externalUserId: identity.externalUserId },
      mode: "queue",
    });
    await sessions.turns.claimNextForSession({
      sessionId: session.id,
      workerId: "other-process",
    });
    const reply = await db
      .insertInto("agent_messages")
      .values({
        session_id: session.id,
        role: "assistant",
        content: "Working",
        author_kind: "agent",
        author_payload: { kind: "agent", sessionId: session.id, agentId: null },
        metadata: {
          status: "in_progress",
          partialContent: "Actual partial answer",
        },
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(
      (await sessions.get(identity, project.id, session.id)).messages.at(-1)
        ?.metadata?.status,
    ).toBe("in_progress");
    await db
      .updateTable("agent_turns")
      .set({ lease_expires_at: new Date(0), result_message_id: reply.id })
      .where("session_id", "=", session.id)
      .execute();
    // Even an expired lease cannot make a read mutate execution.
    const expired = await sessions.get(identity, project.id, session.id);
    expect(expired.messages.at(-1)?.metadata?.status).toBe("in_progress");
    expect(expired.execution).toMatchObject({
      status: "running",
      executorHealthy: false,
    });
    const worker = sessions.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(async () => {
        expect(
          (await sessions.get(identity, project.id, session.id)).messages.at(-1)
            ?.metadata,
        ).toMatchObject({
          status: "failed",
          unexpectedStop: true,
          partialContent: "Actual partial answer",
        });
      });
    } finally {
      await worker.stop();
    }
  });

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
    expect(checkpointedSessions).toContain(second.id);

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
      { task: "Check the release notes" },
    );

    expect(delegated.session).toMatchObject({
      parentSessionId: parent.id,
      forkedFromSessionId: null,
      visibility: "latent",
    });
    await vi.waitFor(async () => {
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("completed");
    });
    await vi.waitFor(async () => {
      expect(
        (await sessions.get(identity, project.id, parent.id)).messages,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            author: expect.objectContaining({
              kind: "agent",
              sessionId: delegated.session.id,
            }),
          }),
        ]),
      );
    });

    await sessions.enqueueMessage(
      identity,
      project.id,
      delegated.session.id,
      "Please expand the conclusion",
    );
    expect(
      await sessions.get(identity, project.id, delegated.session.id),
    ).toMatchObject({ visibility: "promoted" });
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
    const accepted = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof sessions.createSubsession>>
      > => result.status === "fulfilled",
    );
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/already has 1 active subsessions/),
      }),
    });
    const child = accepted[0]!.value;
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
    await vi.waitFor(async () => {
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("completed");
    });
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

  it("keeps a delegation active across a transient child failure", async () => {
    const project = await projects.create(identity, {
      name: "Delegation retry",
    });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Recover delegated work" },
    );
    try {
      await vi.waitFor(async () => {
        const detail = await sessions.get(
          identity,
          project.id,
          child.session.id,
        );
        expect(detail.running).toBe(false);
        expect(detail.messages.at(-1)?.metadata).toMatchObject({
          status: "failed",
          errorKind: "unavailable",
        });
      });
      expect(
        (await sessions.listSubsessions(identity, project.id, parent.id))[0]
          ?.status,
      ).toBe("running");

      await sessions.retry(identity, project.id, child.session.id);
      await vi.waitFor(async () => {
        expect(
          (await sessions.listSubsessions(identity, project.id, parent.id))[0]
            ?.status,
        ).toBe("completed");
        expect(
          (await sessions.get(identity, project.id, parent.id)).running,
        ).toBe(false);
      });
    } finally {
      await sessions.interrupt(identity, project.id, child.session.id, {
        notifyParent: false,
      });
    }
  });

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
      { task: "Prepare the Globex renewal deck before archiving" },
    );
    await provider.slowStarted;
    const cleanupVisibility: string[] = [];
    const stop = vi.fn(async () => {
      cleanupVisibility.push(
        (await sessions.get(identity, project.id, parent.id)).visibility,
      );
    });
    sessions.setArchiveResourcesHandler({
      impact: async () => ({ activeProcessCount: 1 }),
      stop,
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
    expect(
      (
        await sessions.get(identity, project.id, runningChild.session.id)
      ).messages.at(-1)?.metadata,
    ).toMatchObject({ status: "failed", interrupted: true });

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
    const artifact = await db
      .insertInto("deployment_artifacts")
      .values({
        project_id: project.id,
        commit_sha: "a".repeat(40),
        artifact_digest: "b".repeat(64),
        plugin_digest: "c".repeat(64),
        transform_version: "test",
        runtime_version: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const pausedWatcher = await db
      .insertInto("watchers")
      .values({
        project_id: project.id,
        session_id: parent.id,
        owner_external_user_id: identity.externalUserId,
        owner_identity: {
          tenantId: identity.tenantId,
          externalUserId: identity.externalUserId,
        },
        workflow_name: "pausedWatcher",
        source_path: ".work/workflows/src/watchers/paused.ts",
        remote_branch: "work/watchers/paused",
        commit_sha: "a".repeat(40),
        deployment_artifact_id: artifact.id,
        status: "paused",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(
      await sessions.archiveImpact(identity, project.id, parent.id),
    ).toMatchObject({
      activeWatcherCount: 1,
      requiresConfirmation: true,
      watchers: [
        expect.objectContaining({
          id: pausedWatcher.id,
          name: "pausedWatcher",
        }),
      ],
    });
    await db
      .deleteFrom("watchers")
      .where("id", "=", pausedWatcher.id)
      .execute();
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
      { task: "Prepare the Globex renewal deck until archived" },
    );
    await provider.slowStarted;
    await sessions.archive(identity, notifyProject.id, notifyChild.session.id, {
      confirmStop: true,
    });
    await vi.waitFor(async () => {
      const detail = await sessions.get(
        identity,
        notifyProject.id,
        notifyParent.id,
      );
      expect(detail.running).toBe(false);
      expect(
        detail.messages.some(
          (message) =>
            message.content ===
            `Subsession ${notifyChild.session.id} was archived by the user.`,
        ),
      ).toBe(true);
      expect(detail.messages.at(-1)?.metadata).toMatchObject({
        status: "completed",
      });
    });
  });

  it("settles and checkpoints a checkout selected during the turn", async () => {
    const project = await projects.create(identity, { name: "Switching" });
    const chat = await sessions.create(identity, project.id);
    const worktree = path.join(tmpDir, project.id, "worktrees", chat.id);
    provider.switchCheckout = () => {
      checkoutBySession.set(chat.id, worktree);
      return worktree;
    };

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
    await vi.waitFor(() => {
      expect(settledTurns).toContainEqual({
        sessionId: chat.id,
        workingDirectory: worktree,
        changedFiles: ["result.md"],
      });
    });
    provider.switchCheckout = undefined;
  });

  it("reuses the chat for a workflow key and requests attention when its turn settles", async () => {
    const project = await projects.create(identity, { name: "Daily brief" });
    const chatKey = "daily";
    // What catamorphic.sessions.deliver does for a chat named by key.
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
      const runId = crypto.randomUUID();
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

    await vi.waitFor(async () => {
      const item = (await sessions.list(identity, project.id)).items[0];
      expect(item).toMatchObject({
        id: first.sessionId,
        title: "Daily inbox summary",
        attentionRevision: 1,
        attentionSeenRevision: 0,
        attentionRequired: true,
      });
    });
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
    await vi.waitFor(async () => {
      const item = (await sessions.list(identity, project.id)).items[0];
      expect(item).toMatchObject({
        attentionRevision: 2,
        attentionSeenRevision: 1,
        attentionRequired: true,
      });
    });
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
    const chat = await sessions.get(identity, project.id, opened.sessionId);
    expect(chat).toMatchObject({
      key: "pr-42",
      keyWorkflows: ["reviewOnOpen", "cleanupOnMerge"],
      placement: {
        environment: "default",
        reason: "project_default",
        machine: { id: "local", label: "Test Environment" },
      },
    });
    // Another project's `pr-42` is a different chat.
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
      runId: crypto.randomUUID(),
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
    // Closing a key nobody opened has nothing to do.
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
    // A retry after the chat is gone answers with the recorded result.
    expect(
      await act("close", { key: "pr-7", idempotencyKey: "merged-7" }),
    ).toEqual(closed);
    expect(await act("find", { key: "pr-7" })).toBeNull();
    const transcript = await sessions.get(
      identity,
      project.id,
      first.sessionId,
    );
    expect(transcript.status).toBe("closed");
    expect(transcript.messages.map((message) => message.content)).toEqual(
      expect.arrayContaining(["Review pull request 7", "Closed this chat"]),
    );
    const allocation = await db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason"])
      .where("id", "=", transcript.allocationId ?? "")
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

    // Every event of a keyed chat carries its key, closing included, so a
    // workflow selects a key namespace with `where` (ADR 0181).
    const events = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId: first.sessionId,
    });
    expect(events.map((event) => event.kind)).toContain(
      "session.state-changed",
    );
    for (const event of events)
      expect(event.payload).toMatchObject({ session: { key: "pr-7" } });

    // The pull request reopened: the key starts a fresh chat.
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
    const again = await sessions.chatForKey(identity, project.id, {
      key: "incident-9",
      workflowName: "pageOnCall",
    });
    expect(again).toEqual({ sessionId: chat.sessionId, sessionCreated: false });
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
          runId: crypto.randomUUID(),
          workflowName: "pageOnCall",
        },
        mode: "queue",
      },
    );
    await vi.waitFor(async () => {
      const turn = await db
        .selectFrom("agent_turns")
        .select("status")
        .where("id", "=", receipt.turnId ?? "")
        .executeTakeFirstOrThrow();
      expect(turn.status).toBe("completed");
    });

    // Work delivered by id to an archived chat runs too, never held silently.
    await sessions.archive(identity, project.id, chat.sessionId, {
      confirmStop: true,
    });
    const byId = await sessions.deliver(identity, project.id, chat.sessionId, {
      content: "Still firing",
      author: { kind: "system", code: "test" },
      mode: "queue",
    });
    await vi.waitFor(async () => {
      const turn = await db
        .selectFrom("agent_turns")
        .select("status")
        .where("id", "=", byId.turnId ?? "")
        .executeTakeFirstOrThrow();
      expect(turn.status).toBe("completed");
    });
    expect(
      (await sessions.get(identity, project.id, chat.sessionId)).visibility,
    ).toBe("promoted");
  });

  it("publishes durable lifecycle events atomically and distinguishes work from turns", async () => {
    const project = await projects.create(identity, {
      name: "Lifecycle events",
    });
    const session = await sessions.create(identity, project.id);
    const before = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId: session.id,
    });
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
    expect(
      await sessions.exportEvents({
        identity,
        projectId: project.id,
        sessionId: session.id,
      }),
    ).toEqual(before);
    const author = {
      kind: "workflow" as const,
      workflowName: "review",
      displayName: "Review pull requests",
      runId: crypto.randomUUID(),
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
    // The display name travels with the message for people to read.
    expect(
      (await sessions.get(identity, project.id, session.id)).messages.find(
        (message) => message.content === "A durable observation",
      )?.author,
    ).toEqual(author);
    const events = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId: session.id,
    });
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
    const settled = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId: session.id,
    });
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
  });

  it("retains message attention without push subscriptions, respects scope, and never acknowledges unseen revisions", async () => {
    const project = await projects.create(identity, {
      name: "Durable attention",
    });
    const session = await sessions.create(identity, project.id);
    const send = (idempotencyKey: string) =>
      sessions.deliver(identity, project.id, session.id, {
        author: { kind: "system", code: "reminder" },
        mode: "message_only",
        attention: "required",
        content: "Submit application",
        idempotencyKey,
      });
    const first = await send("first");
    const pending = await sessions.attention({ identity });
    expect(
      pending.find((item) => item.id === session.id)?.attentionMessage,
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
    await send("second");
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
    await send("third");
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
      await expect(
        db.transaction().execute(async (transaction) => {
          await sessions.turns.deliver({
            sessionId: session.id,
            author: { kind: "system", code: "test" },
            content: "Rollback reminder",
            mode,
            attention: "required",
            idempotencyKey: "rollback",
            transaction,
          });
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
      const receipt = await sessions.turns.deliver({
        sessionId: session.id,
        author: { kind: "system", code: "test" },
        content: "Committed reminder",
        mode,
        attention: "required",
        idempotencyKey: "rollback",
      });
      expect(receipt.created).toBe(true);
      expect(Boolean(receipt.turnId)).toBe(mode !== "message_only");
      expect(
        (await sessions.get(identity, project.id, session.id))
          .attentionRevision,
      ).toBe(1);
    },
  );

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
      runId: crypto.randomUUID(),
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
    const attentionEvents = await db
      .selectFrom("project_events")
      .select("payload")
      .where("project_id", "=", project.id)
      .where("kind", "=", "session.state-changed")
      .execute();
    expect(attentionEvents).toEqual(
      expect.arrayContaining([
        {
          payload: expect.objectContaining({
            sessionId: session.id,
            actor: expect.objectContaining(author),
            causation: base.causation,
          }),
        },
      ]),
    );
    const notifications = await db
      .selectFrom("user_notification_events")
      .select("id")
      .where("session_id", "=", session.id)
      .execute();
    expect(notifications).toHaveLength(1);
    expect(
      await db
        .selectFrom("notification_deliveries")
        .select("event_id")
        .where("event_id", "=", notifications[0]!.id)
        .execute(),
    ).toHaveLength(1);
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
    const completeEvent = (
      await sessions.exportEvents({
        identity,
        projectId: project.id,
        sessionId: session.id,
      })
    ).find((event) => event.kind === "session.work-changed");
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
      detail.messages.filter((message) => message.metadata?.sessionAction),
    ).toHaveLength(2);
    await actions.execute({
      ...base,
      operation: "unarchive",
      args: { sessionId: session.id, idempotencyKey: "unarchive" },
    });
    expect(
      (await sessions.get(identity, project.id, session.id)).visibility,
    ).toBe("promoted");
    const visibilityEvents = (
      await sessions.exportEvents({
        identity,
        projectId: project.id,
        sessionId: session.id,
      })
    ).filter(
      (event) =>
        event.kind === "session.state-changed" &&
        JSON.stringify(event.payload).includes('"visibility"'),
    );
    expect(visibilityEvents).toHaveLength(2);
    for (const event of visibilityEvents)
      expect(event.payload).toMatchObject({
        actor: { kind: "workflow", runId: author.runId },
        causation: base.causation,
      });
  });

  it.each([false, true])(
    "fences a replaced action executor's late result (failure: %s)",
    async (lateFailure) => {
      const project = await projects.create(identity, {
        name: "Action lease recovery",
      });
      const session = await sessions.create(identity, project.id);
      const actions = new SessionActionsService(db, sessions, () => undefined);
      const started = deferred<void>();
      const release = deferred<void>();
      const original = sessions.archive.bind(sessions);
      const archive = vi
        .spyOn(sessions, "archive")
        .mockImplementationOnce(async (...args) => {
          started.resolve();
          await release.promise;
          if (lateFailure) throw new Error("Late executor failure");
          return original(...args);
        });
      const input: Parameters<SessionActionsService["execute"]>[0] = {
        identity,
        projectId: project.id,
        operation: "archive",
        args: { sessionId: session.id, idempotencyKey: "archive-once" },
        author: {
          kind: "workflow",
          workflowName: "cleanup",
          runId: crypto.randomUUID(),
        },
      };
      const stale = actions.execute(input).then(
        () => "unexpected success",
        (error: unknown) => String(error),
      );
      try {
        await started.promise;
        await db
          .updateTable("session_actions")
          .set({ lease_expires_at: new Date(0) })
          .where("session_id", "=", session.id)
          .execute();
        await actions.execute(input);
        release.resolve();
        expect(await stale).toContain(
          lateFailure ? "Late executor failure" : "lease was replaced",
        );
        expect(
          await db
            .selectFrom("session_actions")
            .select(["status", "error", "lease_owner"])
            .where("session_id", "=", session.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: "completed", error: null, lease_owner: null });
        const detail = await sessions.get(identity, project.id, session.id);
        expect(
          detail.messages.filter(
            (message) => message.content === "Archived this session",
          ),
        ).toHaveLength(1);
        expect(
          detail.messages.some((message) =>
            message.content.includes("failed:"),
          ),
        ).toBe(false);
      } finally {
        release.resolve();
        await stale;
        archive.mockRestore();
      }
    },
  );

  it("routes actions to the authoritative host and imports them once", async () => {
    const project = await projects.create(identity, {
      name: "Remote session actions",
    });
    const session = await sessions.create(identity, project.id);
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const author = {
      kind: "workflow" as const,
      runId: crypto.randomUUID(),
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
    const item = { ...items[0]!, destinationHostId: sessions.hostId };
    sessions.setSessionActionHandler((input) => actions.execute(input));
    await sessions.importMailbox(identity, project.id, item);
    await sessions.importMailbox(identity, project.id, item);
    expect(
      (await sessions.get(identity, project.id, session.id)).attentionRevision,
    ).toBe(1);
    expect(
      (await sessions.get(identity, project.id, session.id)).messages.filter(
        (message) => message.content === "Remote result",
      ),
    ).toHaveLength(1);
  });

  it("retains failure attribution and a retry never interrupts a later turn", async () => {
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
        runId: crypto.randomUUID(),
        workflowName: "recover",
      },
    };
    const input = {
      ...base,
      operation: "interrupt" as const,
      args: { sessionId: session.id, idempotencyKey: "interrupt" },
    };
    await actions.execute(input);
    // Simulate a crash after the effect but before completion was persisted.
    await db
      .updateTable("session_actions")
      .set({ status: "running", lease_expires_at: new Date(0) })
      .where("session_id", "=", session.id)
      .execute();
    await sessions.enqueueMessage(
      identity,
      project.id,
      session.id,
      "Prepare the Globex renewal deck",
    );
    await provider.slowStarted;
    try {
      await actions.execute(input);
      expect(
        (await sessions.get(identity, project.id, session.id)).execution
          ?.cancellationRequested,
      ).toBe(false);
      await expect(
        actions.execute({
          ...base,
          operation: "archive",
          args: { sessionId: session.id, idempotencyKey: "unsafe-archive" },
        }),
      ).rejects.toThrow();
      const detail = await sessions.get(identity, project.id, session.id);
      expect(
        detail.messages.some(
          (message) =>
            message.author.kind === "workflow" &&
            JSON.stringify(message.metadata?.sessionAction).includes(
              '"failed"',
            ),
        ),
      ).toBe(true);
      expect(detail.visibility).toBe("promoted");
    } finally {
      provider.release();
    }
  });

  it("mirrors work state and original event identities without emitting duplicate lifecycle events", async () => {
    const project = await projects.create(identity, {
      name: "Mirrored domain events",
    });
    const sessionId = crypto.randomUUID();
    const event = {
      id: crypto.randomUUID(),
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
      messages: [],
      workStatus: "completed" as const,
      stateRevision: 7,
      events: [event],
    };
    const first = await sessions.mirror(identity, project.id, sessionId, input);
    expect(first).toMatchObject({ workStatus: "completed", stateRevision: 7 });
    await sessions.mirror(identity, project.id, sessionId, input);
    const events = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: event.id,
      payload: {
        externalUserId: identity.externalUserId,
        causation: ["upstream"],
      },
    });
    await expect(
      sessions.mirror(identity, project.id, sessionId, {
        ...input,
        events: [
          {
            ...event,
            id: crypto.randomUUID(),
            payload: { ...event.payload, sessionId: crypto.randomUUID() },
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
    const events = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId: child.id,
    });
    expect(
      events.some((event) =>
        JSON.stringify(event.payload).includes("Historical message"),
      ),
    ).toBe(false);
    expect(
      (await sessions.get(identity, project.id, child.id)).messages.some(
        (message) => message.content === "Historical message",
      ),
    ).toBe(true);
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
    await expect(history({ through: crypto.randomUUID() })).rejects.toThrow(
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
        runId: crypto.randomUUID(),
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
    expect(
      await sessions.listSubsessions(identity, project.id, session.id),
    ).toHaveLength(1);
    const child = (
      await sessions.listSubsessions(identity, project.id, session.id)
    )[0];
    if (!child) throw new Error("Expected delegated child");
    const events = await sessions.exportEvents({
      identity,
      projectId: project.id,
      sessionId: child.session.id,
    });
    expect(
      events.find((event) => event.kind === "session.created")?.payload,
    ).toMatchObject({
      actor: { kind: "workflow", runId: input.author.runId },
      causation: input.causation,
    });
  });
});

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
