import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { modelInputText } from "../services/sessions/input-text.js";
import {
  type RunnerLocation,
  sandboxChannel,
  startSandboxRunner,
} from "../services/sessions/runner-channels.js";
import { itemFromRow } from "../services/sessions/session-rows.js";
import {
  TurnEngine,
  type TurnEngineHost,
} from "../services/sessions/turn-engine.js";
import { sessionLogFixture } from "./session-fixtures.js";

/*
 * The turn engine over runners in a sandbox (ADR 0198), as on a worker:
 * the runner bundle's echo harness runs as a sandbox process, and two
 * engines stand for two replicas. A runner whose attempt ended is answered
 * until it exits, by its holder or by whichever replica takes the turn
 * over, so a thread resumes with everything its harness stored.
 */

const schema = "catamorphic_turn_engine_sandbox";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = randomUUID();
const projectId = randomUUID();
const identity: Identity = { tenantId, externalUserId: "member" };
const STATE = "/workspace/.work-session";
const fixture = sessionLogFixture(db);

let root: string;
let provider: LocalProcessSandboxProvider;
/** Each chat's sandbox, made by its first attempt. */
const sandboxes = new Map<string, string>();
const engines: TurnEngine[] = [];

/** What the service would do around the engine, for the echo harness. */
const host: TurnEngineHost = {
  owner: async () => identity,
  harnessOf: async () => ({
    harness: "echo",
    agentId: null,
    recovery: "continue",
  }),
  prepare: async ({ session }) => {
    let sandboxId = sandboxes.get(session.id);
    if (!sandboxId) {
      sandboxId = (await provider.createSandbox({})).id;
      sandboxes.set(session.id, sandboxId);
    }
    const sandbox = sandboxId;
    return {
      start: {
        harness: "echo",
        workingDirectory: "/workspace",
        stateDirectory: STATE,
        systemPrompt: "",
        context: "",
        permissions: {},
        modelAccess: { kind: "host" },
        toolPolicies: {},
        toolAnnotations: {},
        mcpServers: {},
        hostTools: [],
        plugins: [],
        env: {},
        options: {},
      },
      launch: () =>
        startSandboxRunner({
          provider,
          allocationId: "allocation",
          sandboxId: sandbox,
          stateDirectory: STATE,
        }),
    };
  },
  // As the service finds one: only a process its sandbox still lists.
  reattach: async ({ location }) =>
    (
      await provider.processes.listProcesses({ sandboxId: location.sandboxId })
    ).some((entry) => entry.processId === location.processId)
      ? sandboxChannel({ provider, location })
      : undefined,
  hostTool: async () => {
    throw new Error("No host tools here");
  },
  finalize: async () => ({
    outcome: { changedFiles: [] },
    checkpointAfter: null,
  }),
  authoredByOwner: async () => true,
  settled: async () => {},
};

function replica(name: string): TurnEngine {
  const engine = new TurnEngine({
    db,
    log: fixture.log,
    queue: fixture.queue,
    workerId: name,
    host,
    inputText: modelInputText,
  });
  engines.push(engine);
  return engine;
}

/** A chat with a person's message queued as its first turn. */
async function chat(text: string): Promise<{ sessionId: string }> {
  const sessionId = randomUUID();
  await db
    .insertInto("agent_sessions")
    .values({
      id: sessionId,
      project_id: projectId,
      external_user_id: "member",
    })
    .execute();
  await fixture.queueTurn({ sessionId, text });
  return { sessionId };
}

const turnOf = (sessionId: string) =>
  db
    .selectFrom("agent_turns")
    .selectAll()
    .where("session_id", "=", sessionId)
    .orderBy("ordinal")
    .executeTakeFirstOrThrow();

const attemptsOf = (sessionId: string) =>
  db
    .selectFrom("agent_turn_attempts")
    .select(["reason", "status", "runner"])
    .where("session_id", "=", sessionId)
    .orderBy("ordinal")
    .execute();

/** The thread's stored native state, in order. */
async function stored(sessionId: string): Promise<unknown[]> {
  const rows = await db
    .selectFrom("agent_provider_thread_entries as entry")
    .innerJoin(
      "agent_provider_threads as thread",
      "thread.id",
      "entry.thread_id",
    )
    .select("entry.entry")
    .where("thread.session_id", "=", sessionId)
    .orderBy("entry.seq")
    .execute();
  return rows.map((row) => row.entry);
}

async function replies(sessionId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("agent_items")
    .select("payload")
    .where("session_id", "=", sessionId)
    .where("kind", "=", "assistant_message")
    .orderBy("position")
    .execute();
  return rows.flatMap((row) => {
    const item = itemFromRow(row);
    return item.kind === "assistant_message" ? [item.text] : [];
  });
}

async function until(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A runner's process as its sandbox lists it: running, exited, or gone. */
async function processStatus(location: RunnerLocation): Promise<string> {
  if (location.kind !== "sandbox_process") return "not in a sandbox";
  const listed = await provider.processes.listProcesses({
    sandboxId: location.sandboxId,
  });
  return (
    listed.find((entry) => entry.processId === location.processId)?.status ??
    "gone"
  );
}

/** The runner's process exits (its exit frame comes a moment before). */
const exits = (location: RunnerLocation) =>
  until(
    async () => (await processStatus(location)) === "exited",
    "the runner to exit",
  );

function runnerLocation(runner: unknown): RunnerLocation {
  if (
    runner &&
    typeof runner === "object" &&
    "location" in runner &&
    runner.location &&
    typeof runner.location === "object" &&
    "kind" in runner.location &&
    runner.location.kind === "sandbox_process" &&
    "allocationId" in runner.location &&
    "sandboxId" in runner.location &&
    "processId" in runner.location &&
    typeof runner.location.allocationId === "string" &&
    typeof runner.location.sandboxId === "string" &&
    typeof runner.location.processId === "string"
  )
    return {
      kind: "sandbox_process",
      allocationId: runner.location.allocationId,
      sandboxId: runner.location.sandboxId,
      processId: runner.location.processId,
    };
  throw new Error("Expected a sandbox runner");
}

describe("the turn engine over sandbox runners", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "turn-engine-sandbox-"));
    provider = new LocalProcessSandboxProvider({
      root: path.join(root, "sandboxes"),
    });
  }, 30_000);

  afterAll(async () => {
    await Promise.all(
      engines.map((engine) =>
        engine.stop({ timeoutMs: 1_000, reattachable: () => false }),
      ),
    );
    for (const sandboxId of sandboxes.values())
      await provider.destroySandbox(sandboxId).catch(() => {});
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("settles a turn with what its harness stored on the way out", async () => {
    const { sessionId } = await chat("remember this [[late]]");
    expect(await replica("replica-a").runNext({ sessionId })).toBe(true);
    expect((await turnOf(sessionId)).status).toBe("completed");
    expect(await stored(sessionId)).toEqual([
      { turn: 1, text: "remember this [[late]]" },
    ]);
    const [attempt] = await attemptsOf(sessionId);
    await exits(runnerLocation(attempt?.runner));
  }, 60_000);

  it("settles a finalizing turn on a replica that stops, never handing it back", async () => {
    const { sessionId } = await chat("remember this [[late 1500]]");
    const a = replica("replica-a");
    const working = a.runNext({ sessionId });
    await until(
      async () => (await turnOf(sessionId)).status === "finalizing",
      "the turn to finalize",
    );
    await a.stop({ timeoutMs: 10_000, reattachable: () => true });
    expect(await working).toBe(true);
    expect((await turnOf(sessionId)).status).toBe("completed");
    expect(await stored(sessionId)).toEqual([
      { turn: 1, text: "remember this [[late 1500]]" },
    ]);
  }, 60_000);

  it("answers a finalizing turn's runner on the replica that takes it over", async () => {
    const { sessionId } = await chat("remember this [[late 3000]]");
    const a = replica("replica-a");
    const working = a.runNext({ sessionId });
    await until(
      async () => (await turnOf(sessionId)).status === "finalizing",
      "the turn to finalize",
    );
    // Replica a's lease lapses while its runner still winds down.
    const turn = await turnOf(sessionId);
    await fixture.queue.handBack({
      turnId: turn.id,
      leaseToken: turn.lease_token ?? "",
    });
    await working;
    // Replica a left the runner winding down with nothing stored yet.
    const [left] = await attemptsOf(sessionId);
    expect(await processStatus(runnerLocation(left?.runner))).toBe("running");
    expect(await stored(sessionId)).toEqual([]);
    expect(await replica("replica-b").runNext({ sessionId })).toBe(true);
    expect((await turnOf(sessionId)).status).toBe("completed");
    expect(await stored(sessionId)).toEqual([
      { turn: 1, text: "remember this [[late 3000]]" },
    ]);
    await exits(runnerLocation(left?.runner));
  }, 60_000);

  it("drains a superseded runner before a steer restart that changed hands", async () => {
    const { sessionId } = await chat(
      "[[hang]] [[late 3000]] [[refuse-steers]]",
    );
    const a = replica("replica-a");
    const working = a.runNext({ sessionId });
    await until(async () => {
      const [attempt] = await attemptsOf(sessionId);
      return (
        (await turnOf(sessionId)).status === "running" &&
        attempt?.runner !== null &&
        typeof attempt?.runner === "object" &&
        "hello" in attempt.runner &&
        attempt.runner.hello !== null
      );
    }, "the harness to work");
    await fixture.steer({
      sessionId,
      turnId: (await turnOf(sessionId)).id,
      text: "also this",
    });
    // The harness refused the steer: the attempt is superseded, and its
    // runner stores what it saw a while after it ended.
    await until(
      async () => (await attemptsOf(sessionId))[0]?.status === "superseded",
      "the attempt to be superseded",
    );
    // Replica a stops meanwhile and hands the restart back.
    await a.stop({ timeoutMs: 5_000, reattachable: () => true });
    await working;
    // Replica a left the superseded runner winding down, nothing stored.
    const [superseded] = await attemptsOf(sessionId);
    expect(await processStatus(runnerLocation(superseded?.runner))).toBe(
      "running",
    );
    expect(await stored(sessionId)).toEqual([]);
    expect(await replica("replica-b").runNext({ sessionId })).toBe(true);
    expect((await turnOf(sessionId)).status).toBe("completed");
    const attempts = await attemptsOf(sessionId);
    expect(attempts.map(({ reason, status }) => ({ reason, status }))).toEqual([
      { reason: "initial", status: "superseded" },
      { reason: "steer_restart", status: "completed" },
    ]);
    // The new attempt resumed the thread with the superseded one in it.
    expect((await replies(sessionId)).at(-1)).toContain("(turn 2)");
    await exits(runnerLocation(attempts[0]?.runner));
    // Nobody reattaches it again.
    expect(attempts[0]?.runner).toMatchObject({ ended: true });
  }, 60_000);
});
