import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EchoAdapter } from "@catamorphic/agent-runner";
import {
  createDatabase,
  type DB,
  migrateToLatest,
  withStorableParameters,
} from "@catamorphic/db";
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
import { SessionActionsService } from "../services/session-actions-service.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * A chat takes its next turn whatever text its earlier ones carried (#232).
 * jsonb refuses half of an emoji, as a cut at a length leaves it, and a NUL
 * byte a tool printed; a turn that wrote either failed, on PGlite and on
 * real Postgres alike.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const schema = `catamorphic_unstorable_${randomUUID().replaceAll("-", "")}`;
const identity: Identity = {
  tenantId: randomUUID(),
  externalUserId: "builder",
};
/** The first half of an emoji's surrogate pair, as a cut leaves it. */
const HALF_EMOJI = "🚀".slice(0, 1);
/** In Unicode mode, a surrogate is a character of its own only when alone. */
const LONE_SURROGATE = /[\ud800-\udfff]/u;
/**
 * What a tool printed, as a harness keeps its tail: cut through an emoji at
 * both ends, with a NUL byte between.
 */
const PRINTED = `…${"🚀".slice(1)} built\u0000 ok ${HALF_EMOJI}`;
const PRINTED_STORED = "…\uFFFD built\uFFFD ok \uFFFD";

/** PGlite, wrapped as core wraps whatever database a host injects. */
function pglite(): Kysely<DB> {
  return withStorableParameters(
    new Kysely<DB>({
      dialect: new PGliteDialect({
        pglite: new PGlite({ extensions: { pgcrypto } }),
      }),
      plugins: [new WithSchemaPlugin(schema)],
    }),
  );
}

const databases: Array<[string, () => Kysely<DB>]> = [["PGlite", pglite]];
if (connectionString)
  databases.push([
    "Postgres",
    () => createDatabase({ connectionString, schema, poolSize: 4 }),
  ]);

describe.each(databases)("text Postgres cannot store, on %s", (name, open) => {
  const db = open();
  let tmpDir: string | undefined;
  let projects: ProjectsService;
  let sessions: AgentSessionsService;

  beforeAll(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unstorable-text-"));
    tmpDir = dir;
    await migrateToLatest({ db, schema });
    const projectManager = new ProjectManager(
      new FsBackend(path.join(dir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const echoAdapter = new EchoAdapter();
    const echo: RegisteredCodingAgent = {
      id: "echo",
      harness: { placement: "host", adapter: echoAdapter },
      topology: "native",
    };
    // Runs a command whose output carries what a tool printed, and keeps
    // that in its transcript, once as a bare line as Codex keeps one.
    const printer: RegisteredCodingAgent = {
      id: "printer",
      harness: {
        placement: "host",
        adapter: {
          id: "echo",
          capabilities: () => echoAdapter.capabilities(),
          start: (_attempt, host) => ({
            steer: () => Promise.resolve(false),
            interrupt: () => {},
            finished: (async () => {
              host.emit({
                type: "thread",
                ref: { id: randomUUID(), strength: "strong" },
              });
              host.emit({ type: "turn.started" });
              host.emit({
                type: "item.started",
                key: "log",
                item: {
                  kind: "command",
                  command: "cat build.log",
                  description: null,
                  output: "",
                  exitCode: null,
                },
              });
              host.emit({
                type: "item.delta",
                key: "log",
                field: "output",
                text: PRINTED,
              });
              host.emit({
                type: "item.completed",
                key: "log",
                status: "completed",
                item: { exitCode: 0 },
              });
              await host.nativeState.append({
                entries: [PRINTED, { output: PRINTED }],
              });
              host.emit({ type: "turn.completed", status: "completed" });
            })(),
          }),
        },
      },
      topology: "native",
    };
    const agents = [echo, printer];
    sessions = new AgentSessionsService(db, {
      hostId: `unstorable-text-${name}`,
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider({
          workspaceRoot: "/unused",
        } as SandboxProvider),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "echo",
        get: (id) => agents.find((agent) => agent.id === id),
        list: () => agents,
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId }) => {
          const checkout = path.join(dir, "checkouts", projectId);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
        head: () => Promise.resolve("initial"),
        restore: () => Promise.resolve("restored"),
      },
    });
  });

  afterAll(async () => {
    try {
      // Setup may have failed before the service existed.
      await sessions?.stopLocalTurns();
      if (name === "Postgres")
        await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    } finally {
      await db.destroy();
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function chat(title: string) {
    const project = await projects.create(identity, { name: title });
    const session = await sessions.create(identity, project.id);
    return { projectId: project.id, sessionId: session.id };
  }

  async function storedText(sessionId: string) {
    const items = await db
      .selectFrom("agent_items")
      .select(["kind", "text", "payload"])
      .where("session_id", "=", sessionId)
      .orderBy("position")
      .execute();
    const entries = await db
      .selectFrom("agent_provider_thread_entries")
      .innerJoin(
        "agent_provider_threads",
        "agent_provider_threads.id",
        "agent_provider_thread_entries.thread_id",
      )
      .select("agent_provider_thread_entries.entry")
      .where("agent_provider_threads.session_id", "=", sessionId)
      .orderBy("agent_provider_thread_entries.seq")
      .execute();
    return { items, entries };
  }

  it("sends the turn after a catch-up cut through an emoji", async () => {
    const { projectId, sessionId } = await chat("Catch-up");
    // A message whose catch-up line (2,000 characters) ends inside the emoji.
    const long = `${"x".repeat(1_998)}🚀 tail`;
    const first = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      long,
    );
    expect(first.turn.status).toBe("completed");
    // Away: the chat went on without the agent's thread (on another
    // machine, say), so its next turn is caught up first.
    await db
      .updateTable("agent_provider_threads")
      .set({ last_turn_ordinal: 0 })
      .where("session_id", "=", sessionId)
      .execute();
    const next = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "plain one-line message",
    );
    expect(next.turn.error).toBeNull();
    expect(next.turn.status).toBe("completed");
    const { items } = await storedText(sessionId);
    const handoff = items.find((item) => item.kind === "context_handoff");
    expect(handoff?.text).toContain(
      "While you were away from this conversation, it continued (turn 1).",
    );
    // The cut ends before the emoji, never inside it.
    expect(handoff?.text).toContain(`Person: ${"x".repeat(1_998)}…`);
    expect(handoff?.text).not.toMatch(LONE_SURROGATE);
    expect(handoff?.text).not.toContain("\uFFFD");
    // And the chat goes on.
    const after = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "and another",
    );
    expect(after.turn.status).toBe("completed");
  });

  it("keeps a turn whose text carries half an emoji or a NUL byte", async () => {
    const { projectId, sessionId } = await chat("Pasted output");
    // As pasted from a terminal: output cut at a length, and a NUL.
    const { turn, reply } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      `build log ${HALF_EMOJI} done\u0000 exit 0`,
    );
    expect(turn.error).toBeNull();
    expect(turn.status).toBe("completed");
    // Each arrives as U+FFFD, in the message, the reply streamed back, and
    // the agent's own transcript (a host call, then its entries).
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "Echo: build log \uFFFD done\uFFFD exit 0",
    );
    const { items, entries } = await storedText(sessionId);
    const message = items.find((item) => item.kind === "user_message");
    expect(message?.text).toBe("build log \uFFFD done\uFFFD exit 0");
    expect(message?.payload).toMatchObject({
      text: "build log \uFFFD done\uFFFD exit 0",
    });
    expect(entries.map((row) => row.entry)).toEqual([
      { turn: 1, text: "build log \uFFFD done\uFFFD exit 0" },
    ]);
  });

  it("keeps a turn whose agent printed half an emoji or a NUL byte", async () => {
    const { projectId, sessionId } = await chat("Printed output");
    await sessions.update(identity, projectId, sessionId, {
      agentId: "printer",
    });
    const { turn } = await sessions.sendMessage(
      identity,
      projectId,
      sessionId,
      "build it",
    );
    expect(turn.error).toBeNull();
    expect(turn.status).toBe("completed");
    // The command's streamed output, its transcript entries (a host call,
    // then the entries), each with U+FFFD in place.
    const { items, entries } = await storedText(sessionId);
    const command = items.find((item) => item.kind === "command");
    expect(command?.payload).toMatchObject({
      output: PRINTED_STORED,
      exitCode: 0,
    });
    expect(entries.map((row) => row.entry)).toEqual([
      PRINTED_STORED,
      { output: PRINTED_STORED },
    ]);
  });

  it("runs a workflow's action once when its text carries half an emoji", async () => {
    const project = await projects.create(identity, { name: "Action" });
    await sessions.chatForKey(identity, project.id, {
      key: "pr-7",
      workflowName: "reviewOnOpen",
    });
    const actions = new SessionActionsService(db, sessions, () => undefined);
    const author = {
      kind: "workflow" as const,
      runId: randomUUID(),
      workflowName: "cleanupOnMerge",
    };
    const complete = () =>
      actions.execute({
        identity,
        projectId: project.id,
        operation: "complete",
        args: {
          key: "pr-7",
          content: `Reviewed ${HALF_EMOJI}\u0000`,
          idempotencyKey: "done-7",
        },
        author,
      });
    // Stored with U+FFFD in place, it is still the action it was asked as,
    // and its retry is the same action.
    const first = await complete();
    expect(await complete()).toEqual(first);
  });
});
