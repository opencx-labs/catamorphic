import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  orderedTurns,
  type SessionState,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
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
import { validateAgentDefinition } from "../services/agent-definitions-service.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionActionsService } from "../services/session-actions-service.js";
import { buildContextHandoff } from "../services/sessions/context-handoff.js";
import { testEnvironmentProvider } from "./test-environment.js";

/*
 * Typed results (ADR 0323): an agent whose definition declares results
 * submits them with submit_result; only a value its schema accepts is
 * recorded, as an item with its provenance, and readers tell whether it
 * still answers the chat's newest input.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_session_results";
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

const reviewSchema = {
  type: "object",
  required: ["verdict", "score"],
  additionalProperties: false,
  properties: {
    verdict: { enum: ["COMMENT", "REQUEST_CHANGES"] },
    score: { type: "integer", minimum: 1, maximum: 5 },
  },
};

/** A tool directive the echo harness runs: `[[tool <name> <json>]]`. */
const tool = (name: string, input: unknown) =>
  `[[tool ${name} ${JSON.stringify(input)}]]`;

describe("typed results", () => {
  let tmpDir: string;
  let sessions: AgentSessionsService;
  let actions: SessionActionsService;
  let projects: ProjectsService;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-results-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const plain: RegisteredCodingAgent = {
      id: "plain",
      harness: { placement: "host", adapter: new EchoAdapter() },
      topology: "native",
    };
    const reviewer: RegisteredCodingAgent = {
      ...plain,
      id: "reviewer",
      results: { review: reviewSchema },
    };
    const other: RegisteredCodingAgent = { ...plain, id: "other" };
    // The same echo on another harness: a chat moved to it starts a new
    // provider thread, handed the conversation.
    const echo = new EchoAdapter();
    const away: RegisteredCodingAgent = {
      ...plain,
      id: "away",
      harness: {
        placement: "host",
        adapter: {
          id: "away",
          capabilities: () => echo.capabilities(),
          start: (attempt, host) => echo.start(attempt, host),
        },
      },
    };
    const agents = [plain, reviewer, other, away];
    sessions = new AgentSessionsService(db, {
      hostId: "results-test-host",
      projectManager,
      executionEnvironments: new ExecutionEnvironmentsService(
        new ProjectEnvironmentsService(db, projectManager),
        testEnvironmentProvider(unusedSandbox),
      ),
      executionAllocations: new ExecutionAllocationsService(db),
      codingAgents: {
        defaultAgentId: () => "reviewer",
        get: (id: string) => agents.find((agent) => agent.id === id),
        list: () => agents,
      },
      nativeAgentCheckout: {
        resolve: async ({ projectId }: { projectId: string }) => {
          const checkout = path.join(tmpDir, projectId);
          await fs.mkdir(checkout, { recursive: true });
          return { path: checkout, owned: false };
        },
        checkpoint: () => Promise.resolve(null),
        head: () => Promise.resolve("c0ffee".padEnd(40, "0")),
      },
    });
    actions = new SessionActionsService(db, sessions, () => undefined);
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns({ timeoutMs: 2_000 });
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function items(projectId: string, sessionId: string) {
    const detail = await sessions.get(identity, projectId, sessionId);
    return sessionStateFromSnapshot(detail.snapshot);
  }

  /** Send a message and wait for every turn of the chat to settle. */
  async function turn(projectId: string, sessionId: string, text: string) {
    await sessions.command(identity, projectId, sessionId, {
      type: "send",
      commandId: randomUUID(),
      text,
    });
    await vi.waitFor(
      async () => {
        const turns = orderedTurns(await items(projectId, sessionId));
        expect(turns.length).toBeGreaterThan(0);
        expect(turns.every((entry) => entry.status === "completed")).toBe(true);
      },
      { timeout: 15_000 },
    );
    return items(projectId, sessionId);
  }

  const toolResults = (state: SessionState) =>
    state.items
      .filter((item) => item.kind === "tool_call")
      .sort((a, b) => a.position - b.position)
      .map((item) =>
        item.kind === "tool_call"
          ? JSON.stringify(item.result ?? item.error)
          : "",
      );

  it("declares results in a definition and refuses an unusable schema", () => {
    const ok = validateAgentDefinition({
      version: 1,
      name: "Reviewer",
      kind: "builtin",
      results: { review: reviewSchema },
    });
    expect("definition" in ok && ok.definition.results).toEqual({
      review: reviewSchema,
    });
    const badName = validateAgentDefinition({
      version: 1,
      name: "Reviewer",
      kind: "builtin",
      results: { Review: reviewSchema },
    });
    expect("error" in badName && badName.error).toMatch(/lowercase/);
    const badSchema = validateAgentDefinition({
      version: 1,
      name: "Reviewer",
      kind: "builtin",
      results: { review: { type: "no-such-type" } },
    });
    expect("error" in badSchema && badSchema.error).toMatch(/JSON Schema/);
  });

  it("offers submit_result only to an agent that declares results", async () => {
    const project = await projects.create(identity, { name: "Plain" });
    const session = await sessions.create(identity, project.id, {
      agentId: "plain",
    });
    const state = await turn(
      project.id,
      session.id,
      tool("submit_result", { name: "review", value: {} }),
    );
    expect(toolResults(state)[0]).toContain("no tool 'submit_result'");
  });

  it("returns field errors and stores nothing, decodes a JSON string once, and records provenance", async () => {
    const project = await projects.create(identity, { name: "Review" });
    const session = await sessions.create(identity, project.id);
    const state = await turn(
      project.id,
      session.id,
      [
        tool("submit_result", {
          name: "review",
          value: { verdict: "APPROVE", score: 9, extra: true },
        }),
        tool("submit_result", { name: "vote", value: {} }),
        tool("submit_result", {
          name: "review",
          value: JSON.stringify({ verdict: "COMMENT", score: 4 }),
        }),
      ].join(" "),
    );
    const [rejected, unknown, accepted] = toolResults(state);
    expect(rejected).toContain("Not recorded");
    expect(rejected).toContain("/verdict");
    expect(rejected).toContain("/score");
    expect(rejected).toContain("extra");
    expect(unknown).toContain("No result is named");
    expect(accepted).toContain("Recorded the review result");

    const recorded = state.items.filter((item) => item.kind === "result");
    expect(recorded).toHaveLength(1);
    const [turnOne] = orderedTurns(state);
    const result = recorded[0];
    expect(result).toMatchObject({
      kind: "result",
      name: "review",
      value: { verdict: "COMMENT", score: 4 },
      turnId: turnOne?.id,
      attemptId: turnOne?.activeAttemptId ?? expect.any(String),
      input: { itemId: turnOne?.inputItemId },
      commit: "c0ffee".padEnd(40, "0"),
    });

    const read = await sessions.results(identity, project.id, session.id);
    expect(read).toEqual([
      expect.objectContaining({
        id: result?.id,
        sessionId: session.id,
        name: "review",
        current: true,
      }),
    ]);

    // Recording it was a session event workflows trigger on.
    const events = await db
      .selectFrom("project_events")
      .select(["kind", "payload"])
      .where("project_id", "=", project.id)
      .where("kind", "=", "session.result-recorded")
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      sessionId: session.id,
      actor: { kind: "agent", sessionId: session.id },
      detail: {
        resultId: result?.id,
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
        turnId: turnOne?.id,
      },
      session: { id: session.id, key: null },
    });
  });

  it("marks a result stale once a newer input arrives, and keeps it through a hand-off", async () => {
    const project = await projects.create(identity, { name: "Stale" });
    const session = await sessions.create(identity, project.id);
    await turn(
      project.id,
      session.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "REQUEST_CHANGES", score: 2 },
      }),
    );
    const [first] = await sessions.results(identity, project.id, session.id);
    expect(first?.current).toBe(true);

    // The chat changes harness: its next turn starts from a hand-off.
    await sessions.update(identity, project.id, session.id, {
      agentId: "other",
    });
    await sessions.update(identity, project.id, session.id, {
      agentId: "reviewer",
    });
    const state = await turn(project.id, session.id, "A new push arrived.");
    const [, second] = orderedTurns(state);
    const stale = await sessions.results(identity, project.id, session.id);
    expect(stale).toEqual([
      expect.objectContaining({
        id: first?.id,
        value: { verdict: "REQUEST_CHANGES", score: 2 },
        input: first?.input,
        current: false,
      }),
    ]);
    // Nothing answers the newest input yet.
    const answering = await actions.execute({
      identity,
      projectId: project.id,
      operation: "results",
      args: {
        sessionId: session.id,
        afterInput: second?.inputItemId ?? "",
      },
      author: { kind: "user", externalUserId: identity.externalUserId },
    });
    expect(answering).toMatchObject({ sessionId: session.id, results: [] });

    await turn(
      project.id,
      session.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 5 },
      }),
    );
    const latest = await sessions.results(identity, project.id, session.id, {
      name: "review",
    });
    expect(latest.map((result) => [result.value, result.current])).toEqual([
      [{ verdict: "COMMENT", score: 5 }, true],
      [{ verdict: "REQUEST_CHANGES", score: 2 }, false],
    ]);
  });

  it("hands a new thread its accepted results and unanswered requests verbatim, within its bound", async () => {
    const project = await projects.create(identity, { name: "Handoff" });
    const session = await sessions.create(identity, project.id);
    await turn(
      project.id,
      session.id,
      `Review pull request 7. ${tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
      })}`,
    );
    const push = `A new push arrived: ${"commit abc123 changes the migration. ".repeat(60)}`;
    await turn(project.id, session.id, push);
    await turn(project.id, session.id, "Also check the down migration.");

    // The chat moves to another harness: a new thread, handed the chat.
    await sessions.update(identity, project.id, session.id, {
      agentId: "away",
    });
    const state = await turn(project.id, session.id, "Go on.");
    const handoff = state.items.find((item) => item.kind === "context_handoff");
    if (handoff?.kind !== "context_handoff") throw new Error("no hand-off");
    const [, kept] = handoff.text.split("Your accepted results");
    expect(kept).toContain(
      '- review, from turn 1, answering Person in turn 1: "Review pull request 7.',
    );
    // The value on its own line, as stored (Postgres orders its keys).
    expect(kept).toContain('\n  {"score":4,"verdict":"COMMENT"}');
    const unanswered = kept?.split("which no result answers yet")[1] ?? "";
    // Verbatim, oldest first; the request the result answers is not one.
    expect(unanswered).toContain(`- Turn 2, Person: ${push.trim()}`);
    expect(unanswered.indexOf("Turn 2")).toBeLessThan(
      unanswered.indexOf("- Turn 3, Person: Also check the down migration."),
    );
    expect(unanswered).not.toContain("Review pull request 7");
    // The turn's own input is its prompt, never repeated.
    expect(unanswered).not.toContain("Go on.");

    // A small budget: the verbatim sections keep the newest that fits, say
    // what they cut, and the whole hand-off stays near the bound.
    const small = await buildContextHandoff({
      db,
      sessionId: session.id,
      fromOrdinal: 1,
      toOrdinal: 3,
      strategy: "full",
      budgetChars: 2_000,
    });
    expect(small?.text).toContain('\n  {"score":4,"verdict":"COMMENT"}');
    expect(small?.text).toContain(
      "- Turn 3, Person: Also check the down migration.",
    );
    expect(small?.text).not.toContain("- Turn 2, Person:");
    expect(small?.text).toContain(
      "(1 earlier request is not shown; read it with the session history tool.)",
    );
    expect(small?.text.length).toBeLessThan(2_000 + 300);
  });

  it("reads a family's results and hands a child's to its parent", async () => {
    const project = await projects.create(identity, { name: "Family" });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        task: tool("submit_result", {
          name: "review",
          value: { verdict: "COMMENT", score: 3 },
        }),
      },
    );
    await vi.waitFor(
      async () => {
        const [entry] = await sessions.listSubsessions(
          identity,
          project.id,
          parent.id,
        );
        expect(entry?.status).toBe("completed");
        expect(entry?.results).toEqual([
          expect.objectContaining({
            name: "review",
            value: { verdict: "COMMENT", score: 3 },
            truncated: false,
            current: true,
          }),
        ]);
      },
      { timeout: 15_000 },
    );
    const own = await sessions.results(identity, project.id, parent.id);
    expect(own).toEqual([]);
    const family = await sessions.results(identity, project.id, parent.id, {
      family: true,
    });
    expect(family).toEqual([
      expect.objectContaining({
        sessionId: child.session.id,
        name: "review",
      }),
    ]);
    // The child's message to its parent carries its results.
    await vi.waitFor(
      async () => {
        const notes = (await items(project.id, parent.id)).items.filter(
          (item) => item.kind === "task_notification",
        );
        expect(
          notes.some(
            (item) =>
              item.kind === "task_notification" &&
              item.detail.includes("Its results (the latest of each name):") &&
              item.detail.includes('"verdict":"COMMENT"'),
          ),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );
  });
});
