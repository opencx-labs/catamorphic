import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  orderedTurns,
  type ResultItem,
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
import { RESULT_LIMITS } from "../services/agent-results.js";
import { AgentSessionsService } from "../services/agent-sessions-service.js";
import type { RegisteredCodingAgent } from "../services/coding-agent-registry.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { SessionActionsService } from "../services/session-actions-service.js";
import { buildContextHandoff } from "../services/sessions/context-handoff.js";
import { copySettledHistory } from "../services/sessions/session-copy.js";
import { readFullSnapshot } from "../services/sessions/session-reads.js";
import {
  latestResults,
  RESULT_READ_WINDOW,
  recordResult,
  SessionResultAttemptError,
  SessionResultLimitError,
} from "../services/sessions/session-results.js";
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
      results: { review: reviewSchema, notes: { type: "string" } },
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
    // The turn's own request is open too, and last.
    expect(unanswered.trimEnd()).toMatch(
      /- Turn 4 \(this turn\), Person: Go on\.$/,
    );
    expect(kept).toContain("; a newer request has arrived since");

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

  it("hands a first turn started again on a new thread what its earlier attempt submitted", async () => {
    const project = await projects.create(identity, { name: "First again" });
    const session = await sessions.create(identity, project.id);
    const state = await turn(
      project.id,
      session.id,
      `Review pull request 11. ${tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 5 },
      })}`,
    );
    const [first] = orderedTurns(state);
    if (!first) throw new Error("no first turn");
    // Its attempt lost its sandbox after submitting: no turn came before it.
    const handoff = await buildContextHandoff({
      db,
      sessionId: session.id,
      fromOrdinal: 1,
      toOrdinal: 0,
      strategy: "full",
      currentTurn: { id: first.id, ordinal: 1 },
    });
    const text = handoff?.text ?? "";
    expect(text).toContain("This turn (turn 1) was started before");
    const [, earlier = ""] = text.split(
      "Submitted by an earlier attempt of this turn, which did not finish",
    );
    expect(earlier).toContain('{"score":5,"verdict":"COMMENT"}');
    // A first turn that submitted nothing starts plainly.
    const plain = await sessions.create(identity, project.id);
    const plainState = await turn(project.id, plain.id, "Hello.");
    const [plainFirst] = orderedTurns(plainState);
    expect(
      await buildContextHandoff({
        db,
        sessionId: plain.id,
        fromOrdinal: 1,
        toOrdinal: 0,
        strategy: "full",
        currentTurn: { id: plainFirst?.id ?? "", ordinal: 1 },
      }),
    ).toBeNull();
  });

  it("hands an attempt every result its turn submitted before, not only each name's latest", async () => {
    const project = await projects.create(identity, { name: "Every one" });
    const session = await sessions.create(identity, project.id);
    // Three notes under one name, as a reviewer's findings are.
    const state = await turn(
      project.id,
      session.id,
      ["first finding", "second finding", "third finding"]
        .map((note) => tool("submit_result", { name: "notes", value: note }))
        .join(" "),
    );
    const [only] = orderedTurns(state);
    const text =
      (
        await buildContextHandoff({
          db,
          sessionId: session.id,
          fromOrdinal: 1,
          toOrdinal: 0,
          strategy: "full",
          currentTurn: { id: only?.id ?? "", ordinal: 1 },
        })
      )?.text ?? "";
    // That section alone: the turn's request below it quotes every note.
    const earlier =
      text
        .split(
          "Submitted by an earlier attempt of this turn, which did not finish",
        )[1]
        ?.split("\n\n")[0] ?? "";
    // Each result's value is on its own line, under the request it answers.
    for (const note of ["first finding", "second finding", "third finding"])
      expect(earlier).toContain(`\n  "${note}"`);
  });

  it("tells a turn's next attempt what an earlier attempt of it submitted, and keeps that turn's request open", async () => {
    const project = await projects.create(identity, { name: "Earlier" });
    const session = await sessions.create(identity, project.id);
    await turn(
      project.id,
      session.id,
      `Review pull request 9. ${tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
      })}`,
    );
    await turn(project.id, session.id, "A new push arrived.");
    // Turn 3's first attempt submits, then its sandbox is lost: its next
    // attempt starts a new thread, handed turns 1 and 2.
    const state = await turn(
      project.id,
      session.id,
      `Review the new push. ${tool("submit_result", {
        name: "review",
        value: { verdict: "REQUEST_CHANGES", score: 2 },
      })}`,
    );
    const third = orderedTurns(state)[2];
    if (!third) throw new Error("no third turn");
    const handoff = await buildContextHandoff({
      db,
      sessionId: session.id,
      fromOrdinal: 1,
      toOrdinal: 2,
      strategy: "full",
      currentTurn: { id: third.id, ordinal: 3 },
    });
    const text = handoff?.text ?? "";
    const [, earlier = ""] = text.split(
      "Submitted by an earlier attempt of this turn, which did not finish",
    );
    expect(earlier).toContain(
      'answering Person in turn 3 (this turn): "Review the new push.',
    );
    expect(earlier).toContain('\n  {"score":2,"verdict":"REQUEST_CHANGES"}');
    expect(earlier).toContain("submit again if they are still right");
    const [, accepted = ""] = text.split("Your accepted results");
    expect(accepted).toContain('{"score":4,"verdict":"COMMENT"}');
    expect(accepted).toContain(
      'answering Person in turn 1: "Review pull request 9.',
    );
    const [, open = ""] = text.split("which no result answers yet");
    expect(open).toContain("- Turn 2, Person: A new push arrived.");
    expect(open).toContain(
      "- Turn 3 (this turn), Person: Review the new push.",
    );
    expect(text).not.toMatch(/do not submit/i);
  });

  it("keeps the newest request when results fill the budget, cutting a result to an excerpt", async () => {
    const project = await projects.create(identity, { name: "Room" });
    const session = await sessions.create(identity, project.id);
    await turn(
      project.id,
      session.id,
      `Look at it. ${tool("submit_result", { name: "notes", value: "n".repeat(1_300) })}`,
    );
    const answering = await buildContextHandoff({
      db,
      sessionId: session.id,
      fromOrdinal: 1,
      toOrdinal: 1,
      strategy: "full",
    });
    // Nothing newer than its request: the result still answers it.
    expect(answering?.text).toContain("; it answers the newest request");
    const ask = `Now the second file, please. ${"Details. ".repeat(40)}`;
    await turn(project.id, session.id, ask);
    const small = await buildContextHandoff({
      db,
      sessionId: session.id,
      fromOrdinal: 1,
      toOrdinal: 2,
      strategy: "full",
      budgetChars: 4_000,
    });
    const text = small?.text ?? "";
    expect(text).toContain(`- Turn 2, Person: ${ask.trim()}`);
    expect(text).not.toContain("request is not shown");
    expect(text).toMatch(
      /n{200,}… \(cut here; read the whole value with session_results, result [0-9a-f-]+\)/,
    );
  });

  it("stays current through the agent's own work reporting back, and goes stale on a new request", async () => {
    const project = await projects.create(identity, { name: "Requests" });
    const parent = await sessions.create(identity, project.id);
    await turn(
      project.id,
      parent.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
      }),
    );
    const current = async () =>
      (await sessions.results(identity, project.id, parent.id))[0];
    const recorded = await current();
    expect(recorded).toMatchObject({
      current: true,
      input: { kind: "user_message" },
    });

    // A task it started reports: still the same request.
    await sessions.notify(identity, project.id, parent.id, {
      task: {
        type: "background_command",
        id: "build",
        title: "Build",
        status: "completed",
      },
      summary: "Build finished",
      mode: "message_only",
      idempotencyKey: "build-finished",
    });
    expect((await current())?.current).toBe(true);

    // Its own subsession finishes and writes to it: still its own work.
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      { task: "Look around." },
    );
    await vi.waitFor(
      async () => {
        const [entry] = await sessions.listSubsessions(
          identity,
          project.id,
          parent.id,
        );
        expect(entry?.status).toBe("completed");
      },
      { timeout: 15_000 },
    );
    await sessions.deliver(identity, project.id, parent.id, {
      content: "One more finding.",
      author: { kind: "agent", sessionId: child.session.id, agentId: null },
      mode: "message_only",
      idempotencyKey: "child-update",
    });
    await vi.waitFor(
      async () =>
        expect(
          orderedTurns(await items(project.id, parent.id)).every(
            (entry) => entry.status === "completed",
          ),
        ).toBe(true),
      { timeout: 15_000 },
    );
    expect((await current())?.current).toBe(true);

    // A workflow asks for more: the result no longer answers the chat.
    await sessions.deliver(identity, project.id, parent.id, {
      content: "A new push arrived.",
      author: { kind: "workflow", runId: randomUUID(), workflowName: "prs" },
      mode: "message_only",
      idempotencyKey: "new-push",
    });
    expect(await current()).toMatchObject({
      id: recorded?.id,
      current: false,
      input: recorded?.input,
    });
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

  it("refuses a submission from an attempt that no longer runs its turn", async () => {
    const project = await projects.create(identity, { name: "Attempts" });
    const session = await sessions.create(identity, project.id);
    const state = await turn(project.id, session.id, "Hello.");
    const [settled] = orderedTurns(state);
    const submit = (attemptId: string) =>
      db.transaction().execute((trx) =>
        recordResult(trx, sessions.log, {
          sessionId: session.id,
          turnId: settled?.id ?? "",
          attemptId,
          name: "review",
          value: { verdict: "COMMENT", score: 1 },
        }),
      );
    // The turn ended: its own attempt's late call records nothing.
    await expect(submit(settled?.activeAttemptId ?? "")).rejects.toThrow(
      SessionResultAttemptError,
    );
    // Running, it takes only the attempt that runs it, never a superseded one.
    await db
      .updateTable("agent_turns")
      .set({ status: "running" })
      .where("id", "=", settled?.id ?? "")
      .execute();
    await expect(submit(randomUUID())).rejects.toThrow(
      SessionResultAttemptError,
    );
    const accepted = await submit(settled?.activeAttemptId ?? "");
    expect(accepted.attemptId).toBe(settled?.activeAttemptId);
    await db
      .updateTable("agent_turns")
      .set({ status: "completed" })
      .where("id", "=", settled?.id ?? "")
      .execute();
  });

  it("bounds the results of a turn, not of the chat", async () => {
    const project = await projects.create(identity, { name: "Bounded" });
    const session = await sessions.create(identity, project.id);
    await turn(project.id, session.id, "Hello.");
    const state = await turn(project.id, session.id, "Again.");
    const [first, second] = orderedTurns(state);
    const running = (turnId: string, status: string) =>
      db
        .updateTable("agent_turns")
        .set({ status })
        .where("id", "=", turnId)
        .execute();
    const submit = (settled: typeof first) =>
      db.transaction().execute((trx) =>
        recordResult(trx, sessions.log, {
          sessionId: session.id,
          turnId: settled?.id ?? "",
          attemptId: settled?.activeAttemptId ?? "",
          name: "review",
          value: { verdict: "COMMENT", score: 3 },
        }),
      );
    await running(first?.id ?? "", "running");
    const recorded = await submit(first);
    // The first turn fills its share: copies of its result, written as
    // history is, without an event each.
    await db.transaction().execute(async (trx) => {
      await sql`select set_config('catamorphic.suppress_session_events', 'true', true)`.execute(
        trx,
      );
      await sql`
        insert into ${sql.id(schema, "agent_items")} (id, session_id, turn_id, attempt_id, position, kind, status, payload)
        select gen_random_uuid(), item.session_id, item.turn_id, item.attempt_id,
               item.position + n, item.kind, item.status, item.payload
          from ${sql.id(schema, "agent_items")} item, generate_series(1, ${RESULT_LIMITS.perTurn - 1}) n
         where item.id = ${recorded.id}`.execute(trx);
    });
    await expect(submit(first)).rejects.toThrow(SessionResultLimitError);
    await running(first?.id ?? "", "completed");
    // The chat holds more than one turn's share; its next turn still records.
    await running(second?.id ?? "", "running");
    const next = await submit(second);
    expect(next.turnId).toBe(second?.id);
    await running(second?.id ?? "", "completed");
    const count = await db
      .selectFrom("agent_items")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("session_id", "=", session.id)
      .where("kind", "=", "result")
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(RESULT_LIMITS.perTurn + 1);
  });

  it("finds each name's latest among a chat's newest results, so its reads stay bounded", async () => {
    const project = await projects.create(identity, { name: "Window" });
    const session = await sessions.create(identity, project.id);
    await turn(
      project.id,
      session.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
      }),
    );
    const state = await turn(
      project.id,
      session.id,
      tool("submit_result", { name: "notes", value: "first note" }),
    );
    const notes = state.items.find(
      (item) => item.kind === "result" && item.name === "notes",
    );
    const names = async () =>
      (await latestResults(db, [session.id]))
        .get(session.id)
        ?.map((result) => result.name);
    // The hand-off's section of results, without the requests after it.
    const handoff = async () =>
      (
        (
          await buildContextHandoff({
            db,
            sessionId: session.id,
            fromOrdinal: 1,
            toOrdinal: 2,
            strategy: "full",
          })
        )?.text ?? ""
      )
        .split("Your accepted results")[1]
        ?.split("Requests that arrived after")[0] ?? "";
    expect((await names())?.sort()).toEqual(["notes", "review"]);
    expect(await handoff()).toContain("- review, from turn 1");
    // A later turn fills the window with notes, written as history is.
    await db.transaction().execute(async (trx) => {
      await sql`select set_config('catamorphic.suppress_session_events', 'true', true)`.execute(
        trx,
      );
      await sql`
        insert into ${sql.id(schema, "agent_items")} (id, session_id, turn_id, attempt_id, position, kind, status, payload, created_at)
        select gen_random_uuid(), item.session_id, item.turn_id, item.attempt_id,
               item.position + n, item.kind, item.status, item.payload, item.created_at + make_interval(secs => n)
          from ${sql.id(schema, "agent_items")} item, generate_series(1, ${RESULT_READ_WINDOW}) n
         where item.id = ${notes?.id ?? ""}`.execute(trx);
    });
    // The review is older than the chat's newest results: no read of each
    // name's latest scans past them to find it.
    expect(await names()).toEqual(["notes"]);
    expect(await handoff()).toContain("- notes, from turn 2");
    expect(await handoff()).not.toContain("- review, from turn 1");
  });

  it("reads a turn's results oldest first, and tells workflows which turns wait to run", async () => {
    const project = await projects.create(identity, { name: "Oldest" });
    const session = await sessions.create(identity, project.id);
    const state = await turn(
      project.id,
      session.id,
      [1, 2, 3]
        .map((score) =>
          tool("submit_result", {
            name: "review",
            value: { verdict: "COMMENT", score },
          }),
        )
        .join(" "),
    );
    const [settled] = orderedTurns(state);
    const read = async (order?: "oldest") =>
      (
        (await actions.execute({
          identity,
          projectId: project.id,
          operation: "results",
          args: {
            sessionId: session.id,
            turnId: settled?.id ?? "",
            limit: 2,
            ...(order ? { order } : {}),
          },
          author: { kind: "user", externalUserId: identity.externalUserId },
        })) as { results: Array<{ value: { score: number } }> }
      ).results.map((result) => result.value.score);
    expect(await read()).toEqual([3, 2]);
    expect(await read("oldest")).toEqual([1, 2]);
    // A turn waiting to run is named; one that settled is not.
    const inspect = async () =>
      (await actions.execute({
        identity,
        projectId: project.id,
        operation: "inspect",
        args: { sessionId: session.id },
        author: { kind: "user", externalUserId: identity.externalUserId },
      })) as { queued: string[]; turn: unknown };
    expect(await inspect()).toMatchObject({ queued: [], turn: null });
    const waiting = randomUUID();
    await db
      .insertInto("agent_turns")
      .values({
        id: waiting,
        session_id: session.id,
        ordinal: 99,
        status: "queued",
      })
      .execute();
    expect((await inspect()).queued).toEqual([waiting]);
    await db
      .updateTable("agent_turns")
      .set({ status: "cancelled" })
      .where("id", "=", waiting)
      .execute();
    expect((await inspect()).queued).toEqual([]);
  });

  it("reads what one turn submitted, whatever came after it", async () => {
    const project = await projects.create(identity, { name: "By turn" });
    const session = await sessions.create(identity, project.id);
    const first = await turn(
      project.id,
      session.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "REQUEST_CHANGES", score: 2 },
      }),
    );
    await turn(
      project.id,
      session.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
      }),
    );
    const [turnOne] = orderedTurns(first);
    const read = await sessions.results(identity, project.id, session.id, {
      name: "review",
      turnId: turnOne?.id ?? "",
    });
    expect(read.map((result) => result.value)).toEqual([
      { verdict: "REQUEST_CHANGES", score: 2 },
    ]);
    // A later request made it stale; the turn's own read still finds it.
    expect(read[0]).toMatchObject({ current: false, turnId: turnOne?.id });
  });

  it("is current again once the request after it is rolled back", async () => {
    const project = await projects.create(identity, { name: "Rolled back" });
    const session = await sessions.create(identity, project.id);
    await turn(
      project.id,
      session.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 3 },
      }),
    );
    const state = await turn(project.id, session.id, "Look again.");
    expect(
      (await sessions.results(identity, project.id, session.id))[0],
    ).toMatchObject({ current: false });
    const [, later] = orderedTurns(state);
    await db
      .updateTable("agent_turns")
      .set({ status: "rolled_back" })
      .where("id", "=", later?.id ?? "")
      .execute();
    expect(
      (await sessions.results(identity, project.id, session.id))[0],
    ).toMatchObject({ current: true });
  });

  it("hands off only what results count: no result this side refused, no request a rollback undid", async () => {
    const project = await projects.create(identity, { name: "Handoff rules" });
    const handoffOf = async (sessionId: string, toOrdinal: number) => {
      const handoff = await buildContextHandoff({
        db,
        sessionId,
        fromOrdinal: 1,
        toOrdinal,
        strategy: "full",
        budgetChars: 20_000,
      });
      const [, kept] = handoff?.text.split("Your accepted results") ?? [];
      const [accepted = "", unanswered = ""] =
        kept?.split("which no result answers yet") ?? [];
      return { accepted, unanswered };
    };

    // A result this side did not accept (as a refused mirrored item is).
    const refused = await sessions.create(identity, project.id);
    await turn(
      project.id,
      refused.id,
      `Review it. ${tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 3 },
      })}`,
    );
    await turn(
      project.id,
      refused.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "REQUEST_CHANGES", score: 1 },
      }),
    );
    const [, second] = (
      await db
        .selectFrom("agent_items")
        .select("id")
        .where("session_id", "=", refused.id)
        .where("kind", "=", "result")
        .orderBy("position")
        .execute()
    ).map((row) => row.id);
    await db
      .updateTable("agent_items")
      .set({ status: "failed" })
      .where("id", "=", second ?? "")
      .execute();
    const afterRefusal = await handoffOf(refused.id, 2);
    expect(afterRefusal.accepted).toContain('{"score":3,"verdict":"COMMENT"}');
    expect(afterRefusal.accepted).not.toContain('"verdict":"REQUEST_CHANGES"');
    // The request it answered is open again.
    expect(afterRefusal.unanswered).toContain("REQUEST_CHANGES");

    // A request a rollback undid asks for nothing: the result stays current.
    const undone = await sessions.create(identity, project.id);
    await turn(
      project.id,
      undone.id,
      `Review it. ${tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 4 },
      })}`,
    );
    const state = await turn(project.id, undone.id, "Look again.");
    const [, later] = orderedTurns(state);
    await db
      .updateTable("agent_turns")
      .set({ status: "rolled_back" })
      .where("id", "=", later?.id ?? "")
      .execute();
    const afterRollback = await handoffOf(undone.id, 2);
    expect(afterRollback.accepted).toContain('{"score":4,"verdict":"COMMENT"}');
    expect(afterRollback.accepted).not.toContain(
      "a newer request has arrived since",
    );
    expect(afterRollback.unanswered).not.toContain("Look again.");
  });

  it("shows a child's results in list and wait only to callers who may read that child", async () => {
    const project = await projects.create(identity, { name: "Readers" });
    const parent = await sessions.create(identity, project.id);
    const child = await sessions.createSubsession(
      identity,
      project.id,
      parent.id,
      {
        task: tool("submit_result", {
          name: "review",
          value: { verdict: "COMMENT", score: 2 },
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
        expect(entry?.results).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
    // The child now belongs to someone else; the parent stays the caller's.
    await db
      .updateTable("agent_sessions")
      .set({ external_user_id: "someone-else" })
      .where("id", "=", child.session.id)
      .execute();
    const scoped: Identity = {
      ...identity,
      scope: [{ kind: "agent", projectId: project.id, name: "*" }],
    };
    const [listed] = await sessions.listSubsessions(
      scoped,
      project.id,
      parent.id,
    );
    expect(listed?.results).toEqual([]);
    const [waited] = await sessions.waitForSubsessions(
      scoped,
      project.id,
      parent.id,
      {
        sessionIds: [child.session.id],
        timeoutMs: 0,
        stopWaiting: new AbortController().signal,
      },
    );
    expect(waited?.results).toEqual([]);
    expect(
      await sessions.results(scoped, project.id, parent.id, { family: true }),
    ).toEqual([]);
  });

  it("keeps a mirrored result only if this side's schema accepts it, announced as the pusher's", async () => {
    const project = await projects.create(identity, { name: "Mirror" });
    const source = await sessions.create(identity, project.id);
    await turn(
      project.id,
      source.id,
      tool("submit_result", {
        name: "review",
        value: { verdict: "COMMENT", score: 5 },
      }),
    );
    const sessionId = randomUUID();
    const copy = copySettledHistory({
      snapshot: await readFullSnapshot({ db, sessionId: source.id }),
      sessionId,
    });
    if (!copy) throw new Error("Expected a copy");
    await sessions.mirror(identity, project.id, sessionId, {
      authority: { hostId: "desktop-origin", revision: 1 },
      todos: [],
      base: copy.snapshot,
      events: [],
    });
    const now = new Date().toISOString();
    const pushed = (value: unknown): ResultItem => ({
      id: randomUUID(),
      sessionId,
      turnId: null,
      attemptId: null,
      parentItemId: null,
      position: 0,
      status: "completed",
      nativeRef: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      endedAt: now,
      kind: "result",
      name: "review",
      value: value as ResultItem["value"],
      input: null,
      commit: null,
    });
    const forged = pushed({ verdict: "APPROVE", score: 5 });
    const valid = pushed({ verdict: "REQUEST_CHANGES", score: 1 });
    const announce = (item: ResultItem) => ({
      id: randomUUID(),
      kind: "session.result-recorded",
      occurredAt: now,
      payload: {
        sessionId,
        actor: { kind: "agent", sessionId },
        causation: [],
        // Claims a value its item does not hold.
        detail: { resultId: item.id, name: "review", value: { verdict: "X" } },
        session: { id: sessionId, key: null },
      },
    });
    await sessions.mirror(identity, project.id, sessionId, {
      authority: { hostId: "desktop-origin", revision: 1 },
      events: [forged, valid].map((item, index) => ({
        sessionId,
        sequence: copy.snapshot.sequence + 1 + index,
        at: now,
        commandId: null,
        event: { type: "item.added", item },
      })),
      projectEvents: [announce(forged), announce(valid)],
    });
    const results = await sessions.results(identity, project.id, sessionId);
    expect(results.map((result) => result.value)).toEqual([
      { verdict: "REQUEST_CHANGES", score: 1 },
      { verdict: "COMMENT", score: 5 },
    ]);
    const stored = await db
      .selectFrom("agent_items")
      .select("status")
      .where("id", "=", forged.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("failed");
    const events = await db
      .selectFrom("project_events")
      .select("payload")
      .where("project_id", "=", project.id)
      .where("kind", "=", "session.result-recorded")
      .where(sql<string>`payload->>'sessionId'`, "=", sessionId)
      .execute();
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        actor: { kind: "user", externalUserId: identity.externalUserId },
        detail: expect.objectContaining({
          resultId: valid.id,
          value: { verdict: "REQUEST_CHANGES", score: 1 },
        }),
      }),
    ]);
  });
});
