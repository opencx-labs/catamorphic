import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AttemptHost,
  HarnessAdapter,
} from "@catamorphic/agent-protocol/runner";
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
import { hashBearer } from "../services/connections-service.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { dbModelGatewayStore } from "../services/model-gateway.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import type { SecretsService } from "../services/secrets-service.js";
import { SessionOperationsService } from "../services/session-operations.js";
import { SessionLog } from "../services/sessions/session-log.js";
import { turnFromRow } from "../services/sessions/session-rows.js";
import { testEnvironmentProvider } from "./test-environment.js";

/** What the operations need beside the sessions: no watchers, own chats. */
const OPERATION_DEPS = {
  watchers: () => undefined,
  chatOwner: async (input: { caller: Identity }) => input.caller,
};

/*
 * Turns that stop making progress (ADR 0333): progress is recorded, a
 * silence past the agent's threshold is one `session.turn-stalled` event,
 * a restart ends the attempt and runs the turn again, and the runner's and
 * harness's own output survives the attempt, masked.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_stalled_turns";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalUserId: "builder",
};
const SECRET = "sk-live-0123456789abcdef";
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

describe("stalled turns", () => {
  let tmpDir: string;
  let projects: ProjectsService;
  let sessions: AgentSessionsService;
  let actions: SessionOperationsService;
  let makeService: () => AgentSessionsService;
  /** The latest attempt of a hung harness, by session: the test speaks for it. */
  const hung = new Map<string, AttemptHost>();
  /** The process group a hung harness's agent runs in, by session. */
  const agentGroups = new Map<string, number>();
  /** What a disk-full harness does just before it fails, by session. */
  const beforeFailing = new Map<string, () => Promise<void>>();

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stalled-turns-"));
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    projects = new ProjectsService(db, projectManager);
    const inner = new EchoAdapter();
    // A `[[hang]]` turn's first attempt starts a tool call and goes silent:
    // it ignores interrupts and never finishes, as a harness stuck in a
    // hung call. Its log names a secret. Every other attempt is echo's.
    const hangingAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        if (
          attempt.reason !== "initial" ||
          !attempt.input?.text.includes("[[hang]]")
        )
          return inner.start(attempt, host);
        hung.set(attempt.sessionId, host);
        host.emit({
          type: "thread",
          ref:
            attempt.thread.mode === "resume"
              ? attempt.thread.nativeRef
              : { id: randomUUID(), strength: "strong" },
        });
        host.emit({ type: "turn.started" });
        host.emit({
          type: "item.started",
          key: "hung-call",
          status: "in_progress",
          item: {
            kind: "tool_call",
            tool: "mcp__github__get",
            server: "github",
            description: "Read the pull request",
            input: {},
            result: null,
            error: null,
          },
        });
        host.emit({
          type: "diagnostic",
          level: "warn",
          message: `retrying with ${SECRET}`,
        });
        // An agent in a process group of its own, as an ACP agent runs.
        if (attempt.input?.text.includes("[[own-group]]")) {
          const agent = spawn("sleep", ["300"], {
            detached: true,
            stdio: "ignore",
          });
          agent.unref();
          if (agent.pid) {
            agentGroups.set(attempt.sessionId, agent.pid);
            host.emit({ type: "process.group", pgid: agent.pid });
          }
        }
        return {
          steer: async () => false,
          interrupt: () => {},
          finished: new Promise<void>(() => {}),
        };
      },
    };
    // Fails at once after logging, as a CLI that crashed.
    const crashingAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (_attempt, host) => {
        host.emit({
          type: "thread",
          ref: { id: randomUUID(), strength: "strong" },
        });
        host.emit({ type: "turn.started" });
        host.emit({
          type: "diagnostic",
          level: "error",
          message: `panic: token ${SECRET} rejected`,
        });
        return {
          steer: async () => false,
          interrupt: () => {},
          finished: Promise.reject(new Error("The CLI crashed")),
        };
      },
    };
    // Fails as an install that filled the disk (ADR 0336).
    const diskFullAdapter: HarnessAdapter = {
      id: "echo",
      capabilities: () => inner.capabilities(),
      start: (attempt, host) => {
        host.emit({
          type: "thread",
          ref: { id: randomUUID(), strength: "strong" },
        });
        host.emit({ type: "turn.started" });
        if (attempt.input?.text.includes("[[enospc]]"))
          host.emit({
            type: "diagnostic",
            level: "error",
            message: "npm ERR! code ENOSPC: no space left on device, write",
          });
        // A provider's own failure, with a kind of its own, beside output
        // that says the disk is full.
        if (attempt.input?.text.includes("[[auth]]")) {
          host.emit({
            type: "turn.completed",
            status: "failed",
            error: { message: "The key was revoked", kind: "auth" },
          });
          return {
            steer: async () => false,
            interrupt: () => {},
            finished: Promise.resolve(),
          };
        }
        const before = beforeFailing.get(attempt.sessionId);
        return {
          steer: async () => false,
          interrupt: () => {},
          finished: (async () => {
            await before?.();
            throw new Error("The install failed");
          })(),
        };
      },
    };
    const watched: RegisteredCodingAgent = {
      id: "watched",
      harness: { placement: "host", adapter: hangingAdapter },
      topology: "native",
      stall: { minutes: 20 },
    };
    const unwatched: RegisteredCodingAgent = {
      ...watched,
      id: "unwatched",
      stall: undefined,
    };
    const crashing: RegisteredCodingAgent = {
      ...watched,
      id: "crashing",
      harness: { placement: "host", adapter: crashingAdapter },
    };
    const diskFull: RegisteredCodingAgent = {
      ...watched,
      id: "disk-full",
      harness: { placement: "host", adapter: diskFullAdapter },
    };
    const agents = [watched, unwatched, crashing, diskFull];
    const secrets = {
      valuesForMasking: async () => ({ API_TOKEN: [SECRET] }),
    } as unknown as SecretsService;
    makeService = () =>
      new AgentSessionsService(db, {
        hostId: "stalled-turns-host",
        projectManager,
        secrets,
        executionEnvironments: new ExecutionEnvironmentsService(
          new ProjectEnvironmentsService(db, projectManager),
          testEnvironmentProvider(unusedSandbox),
        ),
        executionAllocations: new ExecutionAllocationsService(db),
        codingAgents: {
          defaultAgentId: () => "watched",
          get: (id) => agents.find((agent) => agent.id === id),
          list: () => agents,
        },
        nativeAgentCheckout: {
          resolve: async ({ projectId }) => {
            const checkout = path.join(tmpDir, "checkouts", projectId);
            await fs.mkdir(checkout, { recursive: true });
            return { path: checkout, owned: false };
          },
          checkpoint: () => Promise.resolve(null),
          head: () => Promise.resolve("initial"),
          restore: () => Promise.resolve("restored"),
        },
      });
    sessions = makeService();
    actions = new SessionOperationsService(db, sessions, OPERATION_DEPS);
  }, 30_000);

  afterAll(async () => {
    await sessions.stopLocalTurns();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** A chat whose agent runs `[[hang]]` turns into a hung call. */
  async function hangingChat(
    name: string,
    agentId = "watched",
    /** Its parent: a subsession of that chat, in its project (ADR 0322). */
    parent?: { projectId: string; sessionId: string },
    text = "review the pull request [[hang]]",
  ) {
    const project = parent
      ? { id: parent.projectId }
      : await projects.create(identity, { name });
    const session = await sessions.create(identity, project.id, { agentId });
    if (parent)
      await db
        .updateTable("agent_sessions")
        .set({ parent_session_id: parent.sessionId })
        .where("id", "=", session.id)
        .execute();
    // The chat received a secret (ADR 0206): its output is masked by it.
    await db
      .updateTable("agent_sessions")
      .set({ secrets_held_at: new Date() })
      .where("id", "=", session.id)
      .execute();
    await sessions.command(identity, project.id, session.id, {
      type: "send",
      commandId: randomUUID(),
      text,
    });
    await vi.waitFor(
      async () => {
        const detail = await sessions.get(identity, project.id, session.id);
        expect(detail.turn?.activity.tools).toHaveLength(1);
        expect(hung.has(session.id)).toBe(true);
      },
      { timeout: 15_000 },
    );
    const detail = await sessions.get(identity, project.id, session.id);
    const turn = detail.turn;
    if (!turn?.attempt) throw new Error("The turn has no attempt");
    return {
      projectId: project.id,
      sessionId: session.id,
      turnId: turn.id,
      attemptId: turn.attempt.id,
    };
  }

  async function attemptRow(attemptId: string) {
    return db
      .selectFrom("agent_turn_attempts")
      .selectAll()
      .where("id", "=", attemptId)
      .executeTakeFirstOrThrow();
  }

  async function stallEvents(sessionId: string) {
    return db
      .selectFrom("project_events")
      .select(["kind", "payload"])
      .where("kind", "=", "session.turn-stalled")
      .where(sql<string>`payload->>'sessionId'`, "=", sessionId)
      .orderBy("sequence")
      .execute();
  }

  function inspect(projectId: string, sessionId: string) {
    return actions.execute({
      identity,
      projectId,
      operation: "session_read",
      args: { sessionId },
      author: { kind: "user", externalUserId: identity.externalUserId },
    }) as Promise<{
      turn: {
        progressAt: string;
        stalledAt: string | null;
        stallMinutes: number | null;
        attempts: number;
        restarts: number;
        running: { tools: Array<{ name: string }> };
      } | null;
    }>;
  }

  it("records progress with frames and model calls, visible to workflows", async () => {
    const chat = await hangingChat("Progress");
    const first = await inspect(chat.projectId, chat.sessionId);
    expect(first.turn).toMatchObject({
      stallMinutes: 20,
      stalledAt: null,
      attempts: 1,
      restarts: 0,
      running: { tools: [{ name: "mcp__github__get" }] },
    });
    const started = Date.parse(first.turn?.progressAt ?? "");
    expect(started).toBeGreaterThan(0);
    // A frame from the harness moves it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    hung.get(chat.sessionId)?.emit({ type: "status", text: "Still reading" });
    await vi.waitFor(
      async () => {
        const after = await inspect(chat.projectId, chat.sessionId);
        expect(Date.parse(after.turn?.progressAt ?? "")).toBeGreaterThan(
          started,
        );
      },
      { timeout: 10_000 },
    );
    // A log line does not.
    const logged = (await attemptRow(chat.attemptId)).progress_at;
    await new Promise((resolve) => setTimeout(resolve, 50));
    hung.get(chat.sessionId)?.emit({
      type: "diagnostic",
      level: "info",
      message: "polling",
    });
    await vi.waitFor(
      async () =>
        expect(
          JSON.stringify((await attemptRow(chat.attemptId)).diagnostics),
        ).toContain("polling"),
      { timeout: 10_000 },
    );
    expect((await attemptRow(chat.attemptId)).progress_at).toEqual(logged);
    // A model call admitted on the attempt's grant moves it, and clears a stall.
    await db
      .updateTable("agent_turn_attempts")
      .set({
        progress_at: new Date(Date.now() - 60_000),
        stalled_at: new Date(),
      })
      .where("id", "=", chat.attemptId)
      .execute();
    await dbModelGatewayStore(db).progress?.({ attemptId: chat.attemptId });
    const touched = await attemptRow(chat.attemptId);
    expect(touched.stalled_at).toBeNull();
    expect(
      Date.now() - new Date(touched.progress_at ?? 0).getTime(),
    ).toBeLessThan(10_000);
    await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
      turnId: chat.turnId,
      attemptId: chat.attemptId,
      reason: "done with this test",
    });
  }, 40_000);

  it("emits one session.turn-stalled per silence, cleared by progress", async () => {
    const chat = await hangingChat("Stalls");
    const minutes = (n: number) => new Date(Date.now() + n * 60_000);
    // Not yet silent long enough.
    await sessions.recordStalls({ at: minutes(19) });
    expect(await stallEvents(chat.sessionId)).toHaveLength(0);
    await sessions.recordStalls({ at: minutes(21) });
    await sessions.recordStalls({ at: minutes(22) });
    const [stalled, ...more] = await stallEvents(chat.sessionId);
    expect(more).toHaveLength(0);
    expect(stalled?.payload).toMatchObject({
      sessionId: chat.sessionId,
      session: { id: chat.sessionId },
      detail: {
        turnId: chat.turnId,
        attemptId: chat.attemptId,
        attempt: 1,
        attempts: 1,
        restarts: 0,
        stallMinutes: 20,
        activity: {
          tools: [
            { name: "mcp__github__get", description: "Read the pull request" },
          ],
        },
      },
    });
    expect(
      (await inspect(chat.projectId, chat.sessionId)).turn?.stalledAt,
    ).not.toBeNull();
    // Progress clears it; a later silence is a stall again.
    hung.get(chat.sessionId)?.emit({ type: "status", text: "Back" });
    await vi.waitFor(
      async () =>
        expect((await attemptRow(chat.attemptId)).stalled_at).toBeNull(),
      { timeout: 10_000 },
    );
    await sessions.recordStalls({ at: minutes(10) });
    expect(await stallEvents(chat.sessionId)).toHaveLength(1);
    await sessions.recordStalls({ at: minutes(45) });
    expect(await stallEvents(chat.sessionId)).toHaveLength(2);
    await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
      turnId: chat.turnId,
      attemptId: chat.attemptId,
      reason: "done with this test",
    });
  }, 40_000);

  it("never stalls a coordinator while a subsession at any depth makes progress", async () => {
    // A coordinator, its subagent without a threshold, and that subagent's
    // own subagent with one: the coordinator waits while they work.
    const parent = await hangingChat("Coordinator");
    const child = await hangingChat("Subagent", "unwatched", parent);
    const grandchild = await hangingChat("Sub-subagent", "watched", child);
    const minutes = (n: number) => new Date(Date.now() + n * 60_000);
    const progressed = (attemptId: string, at: Date) =>
      db
        .updateTable("agent_turn_attempts")
        .set({ progress_at: at })
        .where("id", "=", attemptId)
        .execute();
    // The coordinator and its subagent are silent; the deepest one works.
    await progressed(grandchild.attemptId, minutes(20));
    await sessions.recordStalls({ at: minutes(25) });
    for (const chat of [parent, child, grandchild])
      expect(await stallEvents(chat.sessionId), chat.sessionId).toHaveLength(0);
    // It keeps working: still no stall, however long the coordinator waits.
    await progressed(grandchild.attemptId, minutes(59));
    await sessions.recordStalls({ at: minutes(60) });
    expect(await stallEvents(parent.sessionId)).toHaveLength(0);
    // Once it goes silent too, the coordinator stalls, and so does the
    // deepest subagent on its own threshold; the one with none never does.
    await sessions.recordStalls({ at: minutes(80) });
    expect(await stallEvents(parent.sessionId)).toHaveLength(1);
    expect(await stallEvents(grandchild.sessionId)).toHaveLength(1);
    expect(await stallEvents(child.sessionId)).toHaveLength(0);
    for (const chat of [grandchild, child, parent])
      await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
        turnId: chat.turnId,
        attemptId: chat.attemptId,
        reason: "done with this test",
      });
  }, 60_000);

  /** Take a turn's lease from its holder, as when its replica dies, and let it notice. */
  async function loseHolder(turnId: string) {
    await db
      .updateTable("agent_turns")
      .set({
        lease_owner: "gone",
        lease_expires_at: new Date(Date.now() - 1_000),
      })
      .where("id", "=", turnId)
      .execute();
    // Its lease renews every second: it lets go, and its runner with it.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }

  it("starts the stall clock again whenever a turn starts or stops waiting on a person", async () => {
    // A long wait on a person is the person's: answering it, or the agent
    // asking, never leaves an old clock behind.
    const chat = await hangingChat("Waiting on a person");
    const log = new SessionLog(db);
    const long = new Date(Date.now() - 30 * 60_000);
    const moveTo = async (status: "waiting" | "running") => {
      await db
        .updateTable("agent_turn_attempts")
        .set({ progress_at: long, stalled_at: long })
        .where("id", "=", chat.attemptId)
        .execute();
      const before = Date.now();
      await db.transaction().execute(async (trx) => {
        const turn = turnFromRow(
          await trx
            .selectFrom("agent_turns")
            .selectAll()
            .where("id", "=", chat.turnId)
            .executeTakeFirstOrThrow(),
        );
        await log.append(trx, {
          sessionId: chat.sessionId,
          // What unblockedTurn writes when an answer arrives, and ingest when
          // the agent asks.
          events: [{ type: "turn.changed", turn: { ...turn, status } }],
        });
      });
      const row = await attemptRow(chat.attemptId);
      expect(row.stalled_at).toBeNull();
      expect(new Date(row.progress_at ?? 0).getTime()).toBeGreaterThanOrEqual(
        before - 1_000,
      );
    };
    await moveTo("waiting");
    await moveTo("running");
    // Running on as it was moves nothing.
    await db
      .updateTable("agent_turn_attempts")
      .set({ progress_at: long })
      .where("id", "=", chat.attemptId)
      .execute();
    await db.transaction().execute(async (trx) => {
      const turn = turnFromRow(
        await trx
          .selectFrom("agent_turns")
          .selectAll()
          .where("id", "=", chat.turnId)
          .executeTakeFirstOrThrow(),
      );
      await log.append(trx, {
        sessionId: chat.sessionId,
        events: [
          { type: "turn.changed", turn: { ...turn, activity: "Still" } },
        ],
      });
    });
    expect((await attemptRow(chat.attemptId)).progress_at).toEqual(long);
    await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
      turnId: chat.turnId,
      attemptId: chat.attemptId,
      reason: "done with this test",
    });
  }, 40_000);

  it("kills the process group of its own a hung harness reported when it restarts it", async () => {
    const chat = await hangingChat(
      "Own group",
      "watched",
      undefined,
      "review the pull request [[hang]] [[own-group]]",
    );
    const pgid = await vi.waitFor(
      async () => {
        const runner = (await attemptRow(chat.attemptId)).runner as {
          groups?: number[];
        } | null;
        expect(runner?.groups).toEqual([agentGroups.get(chat.sessionId)]);
        return runner?.groups?.[0] ?? 0;
      },
      { timeout: 10_000 },
    );
    const alive = () => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
      turnId: chat.turnId,
      attemptId: chat.attemptId,
      reason: "stalled",
    });
    await vi.waitFor(
      async () => {
        expect((await attemptRow(chat.attemptId)).status).toBe("restarted");
        expect(alive()).toBe(false);
      },
      { timeout: 20_000 },
    );
  }, 40_000);

  it("restarts, rather than loses, a turn whose runner went away with a restart asked of it", async () => {
    const chat = await hangingChat("Restart after loss", "unwatched");
    await loseHolder(chat.turnId);
    // Asked of its attempt now; the next holder finds its runner gone.
    expect(
      await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
        turnId: chat.turnId,
        attemptId: chat.attemptId,
        reason: "stalled",
      }),
    ).toMatchObject({ restarted: true });
    const survivor = makeService();
    const worker = survivor.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 200,
    });
    try {
      await vi.waitFor(
        async () => {
          const turns = await db
            .selectFrom("agent_turns")
            .select(["status", "continuation_of"])
            .where("session_id", "=", chat.sessionId)
            .execute();
          expect(turns).toEqual([
            { status: "completed", continuation_of: null },
          ]);
          const attempts = await db
            .selectFrom("agent_turn_attempts")
            .select(["reason", "status"])
            .where("turn_id", "=", chat.turnId)
            .orderBy("ordinal")
            .execute();
          expect(attempts).toEqual([
            { reason: "initial", status: "restarted" },
            { reason: "restart", status: "completed" },
          ]);
        },
        { timeout: 30_000 },
      );
    } finally {
      await worker.stop();
      await survivor.stopLocalTurns();
    }
  }, 60_000);

  it("drops a restart asked only while stalled once the attempt made progress", async () => {
    const chat = await hangingChat("Moved on", "unwatched");
    await loseHolder(chat.turnId);
    // A restart queued while it was stalled; it made progress since.
    await db
      .insertInto("agent_turn_commands")
      .values({
        turn_id: chat.turnId,
        attempt_id: chat.attemptId,
        kind: "restart",
        payload: JSON.stringify({ reason: "stalled", onlyIfStalled: true }),
      })
      .execute();
    const survivor = makeService();
    const worker = survivor.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 200,
    });
    try {
      await vi.waitFor(
        async () => {
          const command = await db
            .selectFrom("agent_turn_commands")
            .select("status")
            .where("turn_id", "=", chat.turnId)
            .where("kind", "=", "restart")
            .executeTakeFirstOrThrow();
          expect(command.status).toBe("dropped");
          // Not restarted: its runner was gone, so it was lost as any is.
          expect((await attemptRow(chat.attemptId)).status).toBe("lost");
        },
        { timeout: 30_000 },
      );
    } finally {
      await worker.stop();
      await survivor.stopLocalTurns();
    }
  }, 60_000);

  it("records no stall for an agent without a threshold", async () => {
    const chat = await hangingChat("Unwatched", "unwatched");
    expect(
      (await inspect(chat.projectId, chat.sessionId)).turn?.stallMinutes,
    ).toBeNull();
    await sessions.recordStalls({ at: new Date(Date.now() + 3 * 86_400_000) });
    expect(await stallEvents(chat.sessionId)).toHaveLength(0);
    await sessions.restartTurn(identity, chat.projectId, chat.sessionId, {
      turnId: chat.turnId,
      attemptId: chat.attemptId,
      reason: "done with this test",
    });
  }, 40_000);

  it("restarts a hung attempt: ends it, revokes its grant, and runs the same turn again", async () => {
    const chat = await hangingChat("Restart");
    // The attempt holds a model grant, as a sandbox harness's does.
    const token = await modelGrant(chat);
    expect(await dbModelGatewayStore(db).liveGrant({ token })).toMatchObject({
      attemptId: chat.attemptId,
    });
    const restart = (
      idempotencyKey: string,
      attemptId = chat.attemptId,
      onlyIfStalled = false,
    ) =>
      actions.execute({
        identity,
        projectId: chat.projectId,
        operation: "session_restart",
        args: {
          sessionId: chat.sessionId,
          turnId: chat.turnId,
          attemptId,
          reason: "no progress for 20 minutes",
          idempotencyKey,
          ...(onlyIfStalled ? { onlyIfStalled } : {}),
        },
        author: { kind: "user", externalUserId: identity.externalUserId },
      });
    // Only the turn's running attempt, and only while stalled when asked so.
    const elsewhere = randomUUID();
    expect(await restart("stall:other", elsewhere)).toMatchObject({
      restarted: false,
      attemptId: elsewhere,
      refused: "not_current",
    });
    expect(
      await restart("stall:unstalled", chat.attemptId, true),
    ).toMatchObject({ restarted: false, refused: "not_stalled" });
    const answer = await restart("stall:1");
    expect(answer).toEqual({
      restarted: true,
      turnId: chat.turnId,
      attemptId: chat.attemptId,
      attempt: 1,
      attempts: 1,
      restarts: 0,
    });
    // The same key answers the same, and queues nothing more.
    expect(await restart("stall:1")).toEqual(answer);
    await vi.waitFor(
      async () => {
        const attempts = await db
          .selectFrom("agent_turn_attempts")
          .select(["ordinal", "reason", "status", "error"])
          .where("turn_id", "=", chat.turnId)
          .orderBy("ordinal")
          .execute();
        expect(attempts).toMatchObject([
          {
            reason: "initial",
            status: "restarted",
            error: { message: "Restarted: no progress for 20 minutes" },
          },
          { reason: "restart", status: "completed" },
        ]);
        // And the turn settled after it.
        const turn = await db
          .selectFrom("agent_turns")
          .select("status")
          .where("id", "=", chat.turnId)
          .executeTakeFirstOrThrow();
        expect(turn.status).toBe("completed");
      },
      { timeout: 30_000 },
    );
    const commands = await db
      .selectFrom("agent_turn_commands")
      .select(["kind", "status"])
      .where("turn_id", "=", chat.turnId)
      .where("kind", "=", "restart")
      .execute();
    expect(commands).toEqual([{ kind: "restart", status: "acknowledged" }]);
    // Its grant is gone with it.
    const grant = await db
      .selectFrom("connection_capability_grants")
      .select("revoked_at")
      .where("token_hash", "=", hashBearer(token))
      .executeTakeFirstOrThrow();
    expect(grant.revoked_at).not.toBeNull();
    // The same turn finished on the resumed thread, told why it restarted.
    const detail = await sessions.get(identity, chat.projectId, chat.sessionId);
    const turns = detail.snapshot.turns;
    expect(turns.map((turn) => turn.status)).toEqual(["completed"]);
    const items = detail.snapshot.items.filter(
      (item) => item.turnId === chat.turnId,
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "notice",
        code: "turn_restarted",
        data: {
          attemptId: chat.attemptId,
          reason: "no progress for 20 minutes",
        },
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "tool_call", status: "cancelled" }),
    );
    const reply = items.find((item) => item.kind === "assistant_message");
    expect(reply?.kind === "assistant_message" && reply.text).toContain(
      "restarted (no progress for 20 minutes)",
    );
    // A settled turn is refused, as an answer.
    expect(await restart("stall:2")).toMatchObject({
      restarted: false,
      refused: "not_running",
    });
  }, 60_000);

  it("keeps masked diagnostics for restarted, failed and lost attempts", async () => {
    const read = (projectId: string, sessionId: string, turnId: string) =>
      actions.execute({
        identity,
        projectId,
        operation: "session_read",
        args: { sessionId, turnId, include: ["attempts"] },
        author: { kind: "user", externalUserId: identity.externalUserId },
      }) as Promise<{
        attempts: Array<{
          status: string;
          diagnostics: { runner: string; harness: string } | null;
        }>;
      }>;

    // Restarted.
    const restarted = await hangingChat("Restarted diagnostics");
    await vi.waitFor(
      async () =>
        expect(
          JSON.stringify((await attemptRow(restarted.attemptId)).diagnostics),
        ).toContain("retrying with"),
      { timeout: 10_000 },
    );
    await sessions.restartTurn(
      identity,
      restarted.projectId,
      restarted.sessionId,
      {
        turnId: restarted.turnId,
        attemptId: restarted.attemptId,
        reason: "stalled",
      },
    );
    await vi.waitFor(
      async () => {
        const { attempts } = await read(
          restarted.projectId,
          restarted.sessionId,
          restarted.turnId,
        );
        expect(attempts.map((attempt) => attempt.status)).toEqual([
          "restarted",
          "completed",
        ]);
        expect(attempts[0]?.diagnostics?.harness).toContain(
          "[warn] retrying with [secret API_TOKEN]",
        );
        // A completed attempt keeps none.
        expect(attempts[1]?.diagnostics).toBeNull();
      },
      { timeout: 20_000 },
    );

    // Failed.
    const project = await projects.create(identity, { name: "Crash" });
    const crash = await sessions.create(identity, project.id, {
      agentId: "crashing",
    });
    await db
      .updateTable("agent_sessions")
      .set({ secrets_held_at: new Date() })
      .where("id", "=", crash.id)
      .execute();
    const { turn } = await sessions.sendMessage(
      identity,
      project.id,
      crash.id,
      "go",
    );
    const { attempts: failed } = await read(project.id, crash.id, turn.id);
    expect(failed.at(-1)?.status).toBe("failed");
    expect(failed.at(-1)?.diagnostics?.harness).toContain(
      "[error] panic: token [secret API_TOKEN] rejected",
    );
    expect(JSON.stringify(failed)).not.toContain(SECRET);

    // Lost: its holder's lease is taken, as when its replica dies, and the
    // next holder cannot find its in-process runner.
    const lost = await hangingChat("Lost diagnostics", "unwatched");
    await vi.waitFor(
      async () =>
        expect(
          JSON.stringify((await attemptRow(lost.attemptId)).diagnostics),
        ).toContain("retrying with"),
      { timeout: 10_000 },
    );
    await db
      .updateTable("agent_turns")
      .set({
        lease_owner: "gone",
        lease_expires_at: new Date(Date.now() - 1_000),
      })
      .where("id", "=", lost.turnId)
      .execute();
    const survivor = makeService();
    const worker = survivor.startWorker({
      resolveIdentity: async () => identity,
      pollIntervalMs: 200,
    });
    try {
      await vi.waitFor(
        async () => {
          const { attempts } = await read(
            lost.projectId,
            lost.sessionId,
            lost.turnId,
          );
          expect(attempts[0]?.status).toBe("lost");
          expect(attempts[0]?.diagnostics?.harness).toContain(
            "retrying with [secret API_TOKEN]",
          );
        },
        { timeout: 20_000 },
      );
    } finally {
      await worker.stop();
      await survivor.stopLocalTurns();
    }
  }, 90_000);

  it("says a failed turn ran out of disk, from the machine's report or the output (ADR 0336)", async () => {
    const failedTurn = async (args: { text: string; machineLow?: boolean }) => {
      const project = await projects.create(identity, { name: "Disk" });
      const chat = await sessions.create(identity, project.id, {
        agentId: "disk-full",
      });
      if (args.machineLow)
        beforeFailing.set(chat.id, async () => {
          // Its workspace's machine reports free space under its floor.
          const nodeId = `disk-${randomUUID()}`;
          await db
            .insertInto("tenants")
            .values({ id: identity.tenantId, name: "tenant" })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
          await db
            .insertInto("worker_nodes")
            .values({
              id: nodeId,
              tenant_id: identity.tenantId,
              authority_id: "test",
              descriptor: JSON.stringify({}),
              lease_token: randomUUID(),
              lease_expires_at: new Date(Date.now() + 60_000),
              disk: JSON.stringify({
                path: "/var/lib/docker",
                totalBytes: 100e9,
                freeBytes: 2e9,
                floorBytes: 10e9,
                criticalBytes: 1e9,
                measuredAt: new Date().toISOString(),
              }),
            })
            .execute();
          const own = await db
            .selectFrom("agent_sessions")
            .select("allocation_id")
            .where("id", "=", chat.id)
            .executeTakeFirstOrThrow();
          if (!own.allocation_id) throw new Error("The chat has no Allocation");
          await db
            .updateTable("execution_allocations")
            .set({ worker_node_id: nodeId })
            .where("id", "=", own.allocation_id)
            .execute();
        });
      const { turn } = await sessions.sendMessage(
        identity,
        project.id,
        chat.id,
        args.text,
      );
      return vi.waitFor(
        async () => {
          const row = await db
            .selectFrom("agent_turns")
            .selectAll()
            .where("id", "=", turn.id)
            .executeTakeFirstOrThrow();
          const settled = turnFromRow(row);
          expect(settled.status).toBe("failed");
          const attempt = await db
            .selectFrom("agent_turn_attempts")
            .select("diagnostics")
            .where("turn_id", "=", turn.id)
            .executeTakeFirstOrThrow();
          return { error: settled.error, diagnostics: attempt.diagnostics };
        },
        { timeout: 15_000 },
      );
    };
    const fromOutput = await failedTurn({ text: "install [[enospc]]" });
    expect(fromOutput.error).toEqual({
      kind: "out_of_disk",
      message:
        "The workspace ran out of disk space (no space left on device). The install failed",
    });
    expect(JSON.stringify(fromOutput.diagnostics)).toContain(
      "work: The workspace ran out of disk space",
    );
    const fromMachine = await failedTurn({
      text: "install",
      machineLow: true,
    });
    expect(fromMachine.error).toEqual({
      kind: "out_of_disk",
      message:
        "The machine ran out of disk: 2.0 GB free of 100 GB, where Work keeps 10.0 GB free. The install failed",
    });
    // A more specific kind keeps its actions (reconnect, choose an agent):
    // the disk does not take its place.
    const auth = await failedTurn({ text: "install [[enospc]] [[auth]]" });
    expect(auth.error).toEqual({
      message: "The key was revoked",
      kind: "auth",
    });
    // Nothing about the disk: the failure stands as it was.
    const plain = await failedTurn({ text: "install" });
    expect(plain.error?.kind).toBeUndefined();
    expect(plain.error?.message).toContain("The install failed");
  });

  /** A model grant bound to the chat's running attempt. */
  async function modelGrant(chat: {
    projectId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
  }): Promise<string> {
    const connectionId = randomUUID();
    const token = randomUUID();
    await db
      .insertInto("connections")
      .values({
        id: connectionId,
        tenant_id: identity.tenantId,
        provider_kind: "anthropic",
        principal_kind: "tenant_service",
        name: `anthropic-${connectionId}`,
        label: "Anthropic",
        status: "ready",
        credential_ref: "ref",
      })
      .execute();
    // The chat's own Allocation, or one made for it.
    const session = await db
      .selectFrom("agent_sessions")
      .select("allocation_id")
      .where("id", "=", chat.sessionId)
      .executeTakeFirstOrThrow();
    const allocationId = session.allocation_id ?? randomUUID();
    if (!session.allocation_id) {
      await db
        .insertInto("execution_allocations")
        .values({
          id: allocationId,
          tenant_id: identity.tenantId,
          project_id: chat.projectId,
          environment_name: "build",
          binding_id: "managed",
          workload_kind: "agent",
          root_workload_id: chat.sessionId,
          policy_snapshot: JSON.stringify({}),
        })
        .execute();
      await db
        .updateTable("agent_sessions")
        .set({ allocation_id: allocationId })
        .where("id", "=", chat.sessionId)
        .execute();
    }
    const turn = await db
      .selectFrom("agent_turns")
      .select("lease_token")
      .where("id", "=", chat.turnId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("connection_capability_grants")
      .values({
        tenant_id: identity.tenantId,
        project_id: chat.projectId,
        allocation_id: allocationId,
        agent_session_id: chat.sessionId,
        alias: "anthropic",
        connection_id: connectionId,
        token_hash: hashBearer(token),
        capabilities: JSON.stringify(["model"]),
        model_turn_id: chat.turnId,
        model_attempt_id: chat.attemptId,
        model_lease_token: turn.lease_token,
        expires_at: new Date(Date.now() + 600_000),
        channel: "sandbox",
      })
      .execute();
    return token;
  }
});
