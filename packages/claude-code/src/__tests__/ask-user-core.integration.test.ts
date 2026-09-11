import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn((config: { name: string }) => ({
    type: "sdk",
    name: config.name,
  })),
  tool: vi.fn((name: string) => ({ name })),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentSessionsService,
  type CodingAgentRegistry,
  ExecutionAllocationsService,
  ExecutionEnvironmentsService,
  ProjectEnvironmentsService,
  ProjectsService,
} from "@catamorphic/core";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { ClaudeCodeAgent } from "../claude-code-agent.js";

/** Real core, Postgres and Claude adapter; only the SDK model stream is scripted.
 * A native blocking question remains durable while the same turn waits for its answer.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_askuser_${crypto.randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const queryMock = vi.mocked(query);

const identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "ask-user-tester",
};

const ASK_INPUT = {
  questions: [
    {
      question: "Which database should we use?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "PostgreSQL", description: "Relational, battle-tested" },
        { label: "SQLite", description: "Embedded, zero-ops" },
      ],
    },
  ],
};

describeIf("ask_user across ClaudeCodeAgent + AgentSessionsService", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projectId: string;

  beforeAll(async () => {
    if (!db) throw new Error("unreachable: describeIf gates on DATABASE_URL");
    await migrateToLatest({ db, schema });

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-askuser-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager);
    const rootPath = path.join(tmpDir, "the-project");
    const project = await projects.create(identity, {
      name: "ask-user-project",
    });
    projectId = project.id;

    const agent = new ClaudeCodeAgent();
    const registered = {
      id: "claude-code",
      provider: agent,
      topology: "native" as const,
    };
    const registry: CodingAgentRegistry = {
      defaultAgentId: () => registered.id,
      get: (id) => (id === registered.id ? registered : undefined),
      list: () => [registered],
    };
    const environmentProvider = {
      get: ({ bindingId }: { bindingId: string }) =>
        bindingId === "local"
          ? {
              descriptor: {
                id: "local",
                label: "Test Environment",
                trust: "local" as const,
                isolation: "none" as const,
                workloads: ["agent", "workflow"] as const,
                agentTopologies: [
                  "controller",
                  "native",
                  "contained",
                  "external",
                ] as const,
                capabilities: [],
                resources: {},
              },
            }
          : undefined,
    };
    const executionEnvironments = new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db, projectManager),
      environmentProvider,
    );

    sessions = new AgentSessionsService(db, {
      hostId: "ask-user-test-host",
      projectManager,
      codingAgents: registry,
      executionEnvironments,
      executionAllocations: new ExecutionAllocationsService(db),
      nativeAgentCheckout: { resolve: () => rootPath },
    });
  });

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a blocking question and answers it without starting another turn", async () => {
    let decision: unknown;
    queryMock.mockImplementationOnce((params) => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "cli-1" };
        yield {
          type: "assistant",
          session_id: "cli-1",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "text", text: "One question before I start." },
              {
                type: "tool_use",
                id: "ask_1",
                name: "AskUserQuestion",
                input: ASK_INPUT,
              },
            ],
          },
        };
        // The CLI blocks on the permission round-trip, exactly like the
        // real SDK: the stream continues only once the host resolves it.
        decision = await params.options?.canUseTool?.(
          "AskUserQuestion",
          ASK_INPUT,
          {
            signal: new AbortController().signal,
            toolUseID: "ask_1",
            requestId: "req_ask",
          } as never,
        );
        yield {
          type: "assistant",
          session_id: "cli-1",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: "PostgreSQL it is — starting." }],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "cli-1",
          is_error: false,
          result: "ok",
        };
      })() as unknown as ReturnType<typeof query>;
    });

    const session = await sessions.create(identity, projectId);

    const turn = sessions.sendMessage(
      identity,
      projectId,
      session.id,
      "Ask me what you need to know",
    );
    // Native checkout preparation and durable event writes can exceed the
    // default one-second wait when integration suites run concurrently.
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, projectId, session.id);
        expect(detail.questions?.[0]?.questions).toEqual(ASK_INPUT.questions);
      },
      { timeout: 10_000 },
    );
    expect(decision).toBeUndefined();
    const detail = await sessions.get(identity, projectId, session.id);
    const request = detail.questions?.[0];
    if (!request) throw new Error("Missing question");
    expect(request.blocking).toBe(true);
    const receipt = await sessions.answerQuestion({
      identity,
      projectId,
      sessionId: session.id,
      requestId: request.requestId,
      answer: "Which database should we use?\n→ PostgreSQL",
    });
    expect(receipt.turnId).not.toBeNull();
    const answered = await turn;
    expect(answered.metadata?.status).toBe("completed");
    expect(answered.content).toBe("PostgreSQL it is — starting.");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: {
        ...ASK_INPUT,
        answers: { "Which database should we use?": "PostgreSQL" },
      },
    });
  });
});
