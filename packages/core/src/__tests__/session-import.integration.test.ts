import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ImportedTranscript,
  ImportedTurn,
  JsonValue,
} from "@catamorphic/agent-protocol";
import type { AttemptStart } from "@catamorphic/agent-protocol/runner";
import { EchoAdapter } from "@catamorphic/agent-runner";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * Sessions imported from Claude Code and Codex (ADR 0233): another tool's
 * transcript becomes a session kept up to date as the tool writes, that
 * an agent continues, resuming its own thread or receiving a context handoff.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_import";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "33333333-3333-4333-8333-333333333333",
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

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 15, 12, minute)).toISOString();

function firstTurn(input: { done: boolean }): ImportedTurn {
  return {
    key: "prompt-1",
    input: { key: "prompt-1", text: "Why does the build fail?", at: at(0) },
    status: "completed",
    error: null,
    startedAt: at(0),
    completedAt: input.done ? at(2) : null,
    items: [
      {
        key: "prompt-1/toolu_1",
        status: input.done ? "completed" : "in_progress",
        at: at(1),
        item: {
          kind: "command",
          command: "bun run build",
          description: "Build",
          output: input.done ? "error TS2345" : "",
          exitCode: input.done ? 1 : null,
        },
      },
      ...(input.done
        ? [
            {
              key: "prompt-1/msg_1:0",
              status: "completed" as const,
              at: at(2),
              item: {
                kind: "assistant_message" as const,
                text: "A type error in schemas.ts.",
                agentId: null,
              },
            },
          ]
        : []),
    ],
  };
}

const secondTurn: ImportedTurn = {
  key: "prompt-2",
  input: { key: "prompt-2", text: "Fix it", at: at(5) },
  status: "completed",
  error: null,
  startedAt: at(5),
  completedAt: at(6),
  items: [
    {
      key: "prompt-2/msg_2:0",
      status: "completed",
      at: at(6),
      item: { kind: "assistant_message", text: "Fixed.", agentId: null },
    },
  ],
};

function transcript(
  turns: ImportedTurn[],
  overrides: Partial<ImportedTranscript> = {},
): ImportedTranscript {
  return {
    harness: "claude-code",
    nativeSessionId: "2ebf8a23-ac48-4e8a-81c8-ec5437df893a",
    cwd: "/work/web",
    title: null,
    model: "claude-opus-5-5",
    startedAt: at(0),
    turns,
    ...overrides,
  };
}

describe("imported sessions", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let projects: ProjectsService;

  const loggedEvents = async (sessionId: string) =>
    (
      await db
        .selectFrom("agent_session_events")
        .select("payload")
        .where("session_id", "=", sessionId)
        .orderBy("sequence")
        .execute()
    ).map((row) => (row.payload as { type: string }).type);

  const importInto = (
    projectId: string,
    imported: ImportedTranscript,
    contentSha256: string,
    extra: {
      agentId?: string;
      native?: { offset: number; entries: JsonValue[] };
    } = {},
  ) =>
    sessions.importTranscript(identity, projectId, {
      transcript: imported,
      sourcePath: `/home/me/.claude/projects/-work-web/${imported.nativeSessionId}.jsonl`,
      contentSha256,
      sourceModifiedAt: at(10),
      source: "desktop",
      ...extra,
    });
  /** What each attempt on the tools' agents started with. */
  const attempts: AttemptStart[] = [];

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-import-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const agent: RegisteredCodingAgent = {
      id: "worker",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    // Agents on Claude Code's and Codex's harnesses, run by the echo adapter.
    const toolAgent = (harness: string): RegisteredCodingAgent => {
      const echo = new EchoAdapter();
      return {
        id: `${harness}-agent`,
        harness: {
          placement: "host",
          adapter: {
            id: harness,
            capabilities: () => echo.capabilities(),
            start: (attempt, host) => {
              attempts.push(attempt);
              return echo.start(attempt, host);
            },
          },
        },
        topology: "native",
      };
    };
    const agents = [agent, toolAgent("claude-code"), toolAgent("codex")];
    sessions = new AgentSessionsService(db, {
      hostId: "import-test-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(unusedSandbox),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "worker",
        get: (id: string) => agents.find((each) => each.id === id),
        list: () => agents,
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId }: { projectId: string }) => {
          const checkout = path.join(tmpDir, projectId);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
      },
    });
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns({ timeoutMs: 2_000 });
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a transcript as a session bound to its tool, titled by its first words", async () => {
    const project = await projects.create(identity, { name: "Import" });
    const result = await importInto(
      project.id,
      transcript([firstTurn({ done: true })]),
      "sha-1",
    );
    expect(result.outcome).toBe("created");
    const sessionId = result.sessionId ?? "";
    const detail = await sessions.get(identity, project.id, sessionId);
    expect(detail.title).toBe("Why does the build fail?");
    expect(detail.harness).toBe("claude-code");
    expect(detail.imported).toMatchObject({
      harness: "claude-code",
      nativeSessionId: "2ebf8a23-ac48-4e8a-81c8-ec5437df893a",
      contentSha256: "sha-1",
    });
    expect(detail.snapshot.session.imported?.harness).toBe("claude-code");
    expect(detail.snapshot.turns.map((turn) => turn.status)).toEqual([
      "completed",
    ]);
    expect(
      detail.snapshot.items.map((item) => [item.kind, item.status]),
    ).toEqual([
      ["user_message", "completed"],
      ["command", "completed"],
      ["assistant_message", "completed"],
    ]);
    // In the chat list like any other chat.
    const listed = await sessions.list(identity, project.id, { limit: 10 });
    expect(listed.items.map((session) => session.id)).toContain(sessionId);
    expect(
      listed.items.find((session) => session.id === sessionId)?.imported
        ?.harness,
    ).toBe("claude-code");

    // The same content writes nothing.
    const before = await loggedEvents(sessionId);
    const again = await importInto(
      project.id,
      transcript([firstTurn({ done: true })]),
      "sha-1",
    );
    expect(again).toEqual({ outcome: "unchanged", sessionId });
    expect(await loggedEvents(sessionId)).toEqual(before);
  });

  it("follows a growing transcript: changed items change, new turns append", async () => {
    const project = await projects.create(identity, { name: "Growing" });
    const created = await importInto(
      project.id,
      transcript([firstTurn({ done: false })]),
      "sha-a",
    );
    const sessionId = created.sessionId ?? "";
    const first = await sessions.get(identity, project.id, sessionId);
    const command = first.snapshot.items.find(
      (item) => item.kind === "command",
    );
    expect(command?.status).toBe("in_progress");
    const before = (await loggedEvents(sessionId)).length;

    // The host sends only what changed: the finished first turn and a new one.
    const updated = await importInto(
      project.id,
      transcript([firstTurn({ done: true }), secondTurn], {
        title: "Fix the build",
      }),
      "sha-b",
    );
    expect(updated.outcome).toBe("updated");
    const after = await sessions.get(identity, project.id, sessionId);
    expect(after.title).toBe("Fix the build");
    expect(after.snapshot.turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
    const commandAfter = after.snapshot.items.find(
      (item) => item.kind === "command",
    );
    expect(commandAfter?.id).toBe(command?.id);
    expect(commandAfter?.status).toBe("completed");
    expect(
      after.snapshot.items
        .filter((item) => item.kind === "user_message")
        .map((item) => (item.kind === "user_message" ? item.text : "")),
    ).toEqual(["Why does the build fail?", "Fix it"]);
    const added = (await loggedEvents(sessionId)).slice(before);
    // The user message of turn one is unchanged and is not logged again.
    expect(added.filter((type) => type === "item.added")).toHaveLength(3);
    expect(added).toContain("item.changed");

    // A read naming only the last turn leaves the others alone.
    const tail = await importInto(
      project.id,
      transcript([
        {
          ...secondTurn,
          items: [
            ...secondTurn.items,
            {
              key: "prompt-2/msg_3:0",
              status: "completed",
              at: at(7),
              item: {
                kind: "assistant_message",
                text: "Tests pass.",
                agentId: null,
              },
            },
          ],
        },
      ]),
      "sha-c",
    );
    expect(tail.outcome).toBe("updated");
    const last = await sessions.get(identity, project.id, sessionId);
    expect(last.snapshot.turns).toHaveLength(2);
    expect(last.snapshot.items).toHaveLength(6);
  });

  it("keeps the name a person gave an imported chat as its transcript grows (ADR 0247)", async () => {
    const project = await projects.create(identity, { name: "Renamed import" });
    const created = await importInto(
      project.id,
      transcript([firstTurn({ done: true })], { title: "Build failure" }),
      "sha-r1",
    );
    const sessionId = created.sessionId ?? "";
    await sessions.rename(identity, project.id, sessionId, "Release blocker");
    // The tool goes on in the terminal, and titles the session itself.
    const updated = await importInto(
      project.id,
      transcript([firstTurn({ done: true }), secondTurn], {
        title: "Fix the build",
      }),
      "sha-r2",
    );
    expect(updated.outcome).toBe("updated");
    const after = await sessions.get(identity, project.id, sessionId);
    expect(after.title).toBe("Release blocker");
    expect(after.snapshot.turns.map((turn) => turn.ordinal)).toEqual([1, 2]);
  });

  it("continues imported history on a different harness, then stops reading the file", async () => {
    const project = await projects.create(identity, { name: "Codex" });
    const codex = transcript([firstTurn({ done: true })], {
      harness: "codex",
      nativeSessionId: "01a0d5ac-8636-7032-b6a9-267d2bd70d1b",
      title: "Build failure",
    });
    const { sessionId } = await importInto(project.id, codex, "sha-r");
    const id = sessionId ?? "";
    await sessions.update(identity, project.id, id, {
      agentId: "claude-code-agent",
    });
    await sessions.sendMessage(identity, project.id, id, "Keep going");
    const after = await sessions.get(identity, project.id, id);
    expect(after.snapshot.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    // Codex's own session is not stored with the import: it is handed the history.
    expect(
      after.snapshot.items.some((item) => item.kind === "context_handoff"),
    ).toBe(true);

    // Work runs it now: what Codex writes later is not read into it.
    expect(
      await importInto(
        project.id,
        transcript([firstTurn({ done: true }), secondTurn], {
          harness: "codex",
          nativeSessionId: "01a0d5ac-8636-7032-b6a9-267d2bd70d1b",
        }),
        "sha-r2",
      ),
    ).toEqual({ outcome: "taken_over", sessionId: id });

    const fork = await sessions.fork(identity, project.id, id);
    expect(fork.imported).toBeNull();
    expect(fork.forkedFromSessionId).toBe(id);
  });

  it("resumes Claude Code's own session on the first turn, handed nothing", async () => {
    const project = await projects.create(identity, { name: "Claude" });
    const nativeSessionId = randomUUID();
    const lines: JsonValue[] = [
      { type: "user", uuid: randomUUID(), sessionId: nativeSessionId },
      { type: "assistant", uuid: randomUUID(), sessionId: nativeSessionId },
      {
        type: "ai-title",
        aiTitle: "Build failure",
        sessionId: nativeSessionId,
      },
    ];
    const claude = transcript([firstTurn({ done: true })], { nativeSessionId });
    const { sessionId } = await importInto(project.id, claude, "sha-n1", {
      agentId: "claude-code-agent",
      native: { offset: 0, entries: lines.slice(0, 2) },
    });
    const id = sessionId ?? "";
    // A read from the start again stores only what is new.
    await importInto(project.id, claude, "sha-n2", {
      agentId: "claude-code-agent",
      native: { offset: 0, entries: lines },
    });
    const thread = await db
      .selectFrom("agent_provider_threads")
      .selectAll()
      .where("session_id", "=", id)
      .executeTakeFirstOrThrow();
    const entries = await db
      .selectFrom("agent_provider_thread_entries")
      .select("entry")
      .where("thread_id", "=", thread.id)
      .execute();
    expect(entries).toHaveLength(3);

    attempts.length = 0;
    await sessions.sendMessage(identity, project.id, id, "Keep going");
    expect(attempts[0]?.thread).toMatchObject({
      mode: "restore",
      nativeRef: { id: nativeSessionId, strength: "strong" },
    });
    const after = await sessions.get(identity, project.id, id);
    expect(after.snapshot.turns.at(-1)?.providerThreadId).toBe(thread.id);
    expect(
      after.snapshot.items.some((item) => item.kind === "context_handoff"),
    ).toBe(false);
  });

  it("never imports a session one of Work's own threads ran", async () => {
    const project = await projects.create(identity, { name: "Own" });
    const own = await sessions.create(identity, project.id);
    const nativeSessionId = randomUUID();
    await db
      .insertInto("agent_provider_threads")
      .values({
        id: randomUUID(),
        session_id: own.id,
        harness: "claude-code",
        native_ref: sql`${JSON.stringify({ id: nativeSessionId, strength: "strong" })}::jsonb`,
        status: "active",
      })
      .execute();
    const result = await importInto(
      project.id,
      transcript([firstTurn({ done: true })], { nativeSessionId }),
      "sha-own",
    );
    expect(result).toEqual({ outcome: "own", sessionId: null });
  });

  it("never imports a new Claude Code thread of Work's before it reports its id", async () => {
    const project = await projects.create(identity, { name: "Own early" });
    const own = await sessions.create(identity, project.id);
    // Work chooses a new Claude Code thread's native id: its own.
    const threadId = randomUUID();
    await db
      .insertInto("agent_provider_threads")
      .values({
        id: threadId,
        session_id: own.id,
        harness: "claude-code",
        status: "active",
      })
      .execute();
    const result = await importInto(
      project.id,
      transcript([firstTurn({ done: true })], { nativeSessionId: threadId }),
      "sha-own-early",
    );
    expect(result).toEqual({ outcome: "own", sessionId: null });
  });

  it("logs nothing for a re-read turn whose tool calls did not change", async () => {
    const project = await projects.create(identity, { name: "Unchanged" });
    const turn: ImportedTurn = {
      ...secondTurn,
      items: [
        {
          key: "prompt-2/toolu_edit",
          status: "completed",
          at: at(5),
          item: {
            kind: "tool_call",
            server: null,
            tool: "Edit",
            description: null,
            // Stored as jsonb, which orders nested keys its own way.
            input: {
              file_path: "src/schemas.ts",
              old_string: "a",
              new_string: "b",
            },
            result: { content: "ok", isError: false },
            error: null,
          },
        },
        ...secondTurn.items,
      ],
    };
    const { sessionId } = await importInto(
      project.id,
      transcript([turn], { nativeSessionId: randomUUID() }),
      "sha-u1",
    );
    const id = sessionId ?? "";
    const nativeSessionId = (await sessions.get(identity, project.id, id))
      .imported?.nativeSessionId;
    const before = await loggedEvents(id);
    const again = await importInto(
      project.id,
      transcript([turn], { nativeSessionId }),
      "sha-u2",
    );
    expect(again.outcome).toBe("updated");
    expect(await loggedEvents(id)).toEqual(before);
  });

  it("stores a long transcript's native records past one statement's parameters", async () => {
    const project = await projects.create(identity, { name: "Long" });
    const nativeSessionId = randomUUID();
    // Five parameters a record: one statement would pass 65,535.
    const lines: JsonValue[] = Array.from({ length: 14_000 }, () => ({
      type: "progress",
      uuid: randomUUID(),
      sessionId: nativeSessionId,
    }));
    const { sessionId } = await importInto(
      project.id,
      transcript([firstTurn({ done: true })], { nativeSessionId }),
      "sha-long",
      { agentId: "claude-code-agent", native: { offset: 0, entries: lines } },
    );
    const thread = await db
      .selectFrom("agent_provider_threads")
      .select("id")
      .where("session_id", "=", sessionId ?? "")
      .executeTakeFirstOrThrow();
    const stored = await db
      .selectFrom("agent_provider_thread_entries")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("thread_id", "=", thread.id)
      .executeTakeFirstOrThrow();
    expect(Number(stored.count)).toBe(14_000);
  }, 60_000);

  it("keeps a hidden import hidden as its file grows", async () => {
    const project = await projects.create(identity, { name: "Hidden" });
    const { sessionId } = await importInto(
      project.id,
      transcript([firstTurn({ done: false })], {
        nativeSessionId: randomUUID(),
      }),
      "sha-h1",
    );
    const id = sessionId ?? "";
    await sessions.archive(identity, project.id, id);
    const nativeSessionId = (await sessions.get(identity, project.id, id))
      .imported?.nativeSessionId;
    await importInto(
      project.id,
      transcript([firstTurn({ done: true })], { nativeSessionId }),
      "sha-h2",
    );
    const after = await sessions.get(identity, project.id, id);
    expect(after.visibility).toBe("archived");
    expect(
      after.snapshot.items.find((item) => item.kind === "command")?.status,
    ).toBe("completed");
  });
});
