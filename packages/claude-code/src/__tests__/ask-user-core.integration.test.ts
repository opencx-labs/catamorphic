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
  DbSandboxStore,
  DevSandboxService,
  ProjectsService,
} from "@catamorphic/core";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { ClaudeCodeAgent } from "../claude-code-agent.js";

/**
 * Pins the harness ↔ core seam of the ask_user flow for Claude Code
 * sessions — the layer that has regressed repeatedly. The harness unit
 * tests mock query() and stop at AgentEvents; the desktop e2e drives the
 * fake agent, which never touches this harness. This test runs the REAL
 * ClaudeCodeAgent inside the REAL AgentSessionsService against a real
 * Postgres schema, with only the SDK's query() scripted, and asserts the
 * full contract:
 *
 *   AskUserQuestion tool call → parked permission → `question` event →
 *   assistant row persisted as awaiting_input with the questions →
 *   the user's answer turn → parked promise resolved with the answers →
 *   the SAME query stream continues → turn completes.
 *
 * If AskUserQuestion is ever allowlisted past canUseTool again (the last
 * regression), the question event never fires and this fails.
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

/** Host-execution agents never touch the sandbox; fail loudly if one does. */
const unusedSandboxProvider = new Proxy({} as SandboxProvider, {
  get(_target, prop) {
    if (prop === "workspaceRoot") return "/unused";
    return () => {
      throw new Error(
        `SandboxProvider.${String(prop)} must not be called for host agents`,
      );
    };
  },
});

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
      rootPath,
    });
    projectId = project.id;

    const agent = new ClaudeCodeAgent();
    const registered = {
      id: "claude-code",
      provider: agent,
      execution: "host" as const,
    };
    const registry: CodingAgentRegistry = {
      defaultAgentId: () => registered.id,
      get: (id) => (id === registered.id ? registered : undefined),
      list: () => [registered],
    };

    sessions = new AgentSessionsService(db, {
      projectManager,
      sandboxProvider: unusedSandboxProvider,
      codingAgents: registry,
      devSandboxes: new DevSandboxService({
        projectManager,
        provider: unusedSandboxProvider,
        store: new DbSandboxStore(db),
      }),
      hostProjectPath: () => rootPath,
    });
  });

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists awaiting_input with the questions, then resumes the same stream with the answers", async () => {
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

    // Turn 1: the question turn must SETTLE as awaiting_input — that is
    // what makes the panel render and survive an app restart.
    const asked = await sessions.sendMessage(
      identity,
      projectId,
      session.id,
      "Ask me what you need to know",
    );
    expect(asked.metadata?.status).toBe("awaiting_input");
    expect(asked.metadata?.questions).toEqual(ASK_INPUT.questions);
    // Not yet answered: the parked permission is still pending.
    expect(decision).toBeUndefined();

    // The persisted read shows the same settled state (refresh safety):
    // a reload must not settle it as failed or lose the questions.
    const detail = await sessions.get(identity, projectId, session.id);
    const persisted = detail.messages.at(-1);
    expect(persisted?.metadata?.status).toBe("awaiting_input");
    expect(persisted?.metadata?.questions).toEqual(ASK_INPUT.questions);

    // Turn 2: the panel's formatted answer resolves the parked call and
    // the SAME query stream continues — no second CLI spawn.
    const answered = await sessions.sendMessage(
      identity,
      projectId,
      session.id,
      "Which database should we use?\n→ PostgreSQL",
    );
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
