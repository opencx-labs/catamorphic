import crypto from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunsService } from "../services/runs-service.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";
import {
  type ProjectListener,
  TriggersService,
} from "../services/triggers-service.js";
import { WaitedEventsService } from "../services/waited-events.js";
import { WorkWakeups } from "../services/work-wakeups.js";
import {
  type PendingSessionEvent,
  pendingSessionEvent,
  WORKSPACE_SETUP_EVENT,
} from "../services/workspace-events.js";

/*
 * A waited event (ADR 0355): who is waited for (an active project
 * automation bound to the kind whose config and `where` match, and which
 * may change the chat, as a dispatch requires), and the wait itself: until
 * every listener's delivery was made and every run it started ended, or the
 * deadline passes. The dispatcher is played by hand here, writing the
 * receipts and stamped runs it would, so each ending is exact.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_waited_events";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();

/** The session kind as a host registers it: config selects an agent. */
const workspaceSetup: TriggerKindRuntime = {
  name: WORKSPACE_SETUP_EVENT,
  payloadJsonSchema: { type: "object" },
  configJsonSchema: { type: "object" },
  validatePayload: () => ({ ok: true }),
  validateConfig: () => ({ ok: true }),
  matches: ({ config, payload }) => {
    const wanted = fields(config).agentId;
    return (
      wanted === undefined || wanted === fields(fields(payload).payload).agentId
    );
  },
};

/** A JSON object's fields, or none. */
function fields(value: Json | undefined): { [key: string]: Json | undefined } {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

interface Binding {
  workflow?: string;
  owner?: "project" | "member";
  config?: Json;
  where?: Json[];
  activation?: string;
  enablement?: string;
  permissions?: string[];
}

describe("waited events (ADR 0355)", () => {
  let triggers: TriggersService;
  const canceled: Array<{ runId: string; reason: string }> = [];
  const wakeups = new WorkWakeups();
  let events: WaitedEventsService;

  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    triggers = new TriggersService(db, {
      kinds: [workspaceSetup],
      // Listening reads bindings only: it starts no run and opens no repository.
      projectManager: undefined as unknown as ProjectManager,
      runs: undefined as unknown as RunsService,
    });
    events = new WaitedEventsService({
      db,
      triggers,
      cancelRun: async ({ runId, reason }) => {
        canceled.push({ runId, reason });
        await ends(runId, "canceled");
      },
      wakeups,
      pollMs: 10,
    });
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  /**
   * A project with one chat being set up, the workflows bound to its setup
   * event, and that event, built and not recorded yet.
   */
  async function project(input: {
    bindings?: Binding[];
    chat?: { owner?: string; agentId?: string; key?: string };
    detail?: { [key: string]: Json };
  }): Promise<{
    projectId: string;
    event: PendingSessionEvent;
    /** The activation of each binding, in order. */
    activations: string[];
  }> {
    const created = await db
      .insertInto("projects")
      .values({ tenant_id: tenantId, name: "Reviews" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const projectId = created.id;
    const commitSha = "c".repeat(40);
    const artifact = await db
      .insertInto("deployment_artifacts")
      .values({
        project_id: projectId,
        commit_sha: commitSha,
        artifact_digest: "test",
        plugin_digest: "none",
        runtime_version: "test",
        transform_version: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("trigger_definition_scans")
      .values({ project_id: projectId, commit_sha: commitSha })
      .execute();
    const activations: string[] = [];
    for (const [index, binding] of (input.bindings ?? []).entries()) {
      const workflow = binding.workflow ?? `prepare${index}`;
      const definition = await db
        .insertInto("trigger_definitions")
        .values({
          project_id: projectId,
          commit_sha: commitSha,
          trigger_kind: WORKSPACE_SETUP_EVENT,
          workflow_name: workflow,
          config: JSON.stringify(binding.config ?? {}),
          where_filters: JSON.stringify(binding.where ?? []),
          can_suspend: false,
          input_parameters: JSON.stringify([]),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const owner = binding.owner ?? "project";
      const enablement = await db
        .insertInto("workflow_enablements")
        .values({
          tenant_id: tenantId,
          project_id: projectId,
          workflow_name: workflow,
          deployment_artifact_id: artifact.id,
          commit_sha: commitSha,
          environment_name: "default",
          owner_kind: owner,
          owner_external_user_id: owner === "member" ? "ada" : null,
          owner_identity: { tenantId, externalUserId: "ada" },
          consent_digest: "test",
          created_by_external_user_id: "ada",
          status: binding.enablement ?? "active",
          permissions: JSON.stringify(binding.permissions ?? []),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const activation = await db
        .insertInto("workflow_enablement_triggers")
        .values({
          enablement_id: enablement.id,
          trigger_definition_id: definition.id,
          status: binding.activation ?? "active",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      activations.push(activation.id);
    }
    const sessionId = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: input.chat?.owner ?? "catamorphic:project",
        title: "Review #42",
        agent_id: input.chat?.agentId ?? "reviewer",
        chat_key: input.chat?.key ?? null,
        authority_host_id: "waited-host",
        authority_revision: 1,
      })
      .execute();
    const event = await pendingSessionEvent({
      db,
      sessionId,
      kind: WORKSPACE_SETUP_EVENT,
      detail: input.detail ?? {
        reason: "base-moved",
        environment: "review",
        workspace: { ref: "refs/pull/42/head", commit: "b".repeat(40) },
        previous: { commit: "a".repeat(40) },
        sandbox: "kept",
      },
    });
    return { projectId, event, activations };
  }

  /** One listener by its workflow: they come in no order of their own. */
  const named = (listeners: readonly ProjectListener[], workflow: string) => {
    const found = listeners.find(
      (listener) => listener.workflowName === workflow,
    );
    if (!found) throw new Error(`No listener ${workflow}`);
    return found;
  };

  /** The workflows a dispatch of the event would start, by name. */
  const heard = async (input: { event: PendingSessionEvent }) =>
    (await events.listeners(input)).map((listener) => listener.workflowName);

  /** The dispatcher delivered the event to a listener and started its run. */
  async function started(input: {
    event: PendingSessionEvent;
    listener: ProjectListener;
    status?: string;
  }): Promise<string> {
    const run = await db
      .insertInto("workflow_runs")
      .values({
        project_id: input.event.projectId,
        workflow_name: input.listener.workflowName,
        workflow_enablement_id: input.listener.enablementId,
        provenance: JSON.stringify({}),
        status: input.status ?? "running",
        event_id: input.event.id,
        delivery_key: `event:${input.listener.activationId}:${input.event.id}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await delivered({ ...input, runIds: [run.id] });
    return run.id;
  }

  /** The dispatcher's receipt for one listener. */
  async function delivered(input: {
    event: PendingSessionEvent;
    listener: ProjectListener;
    runIds?: string[];
    status?: string;
    error?: string;
    attempts?: number;
  }): Promise<void> {
    await db
      .insertInto("project_event_deliveries")
      .values({
        activation_id: input.listener.activationId,
        event_id: input.event.id,
        status: input.status ?? "completed",
        run_ids: JSON.stringify(input.runIds ?? []),
        error: input.error ?? null,
        attempt_count: input.attempts ?? 1,
      })
      .execute();
  }

  /** A run moved to `status`; one that ended says when. */
  const ends = (runId: string, status: string, error?: string) =>
    db
      .updateTable("workflow_runs")
      .set({
        status,
        error: error ?? null,
        completed_at: ["completed", "failed", "canceled"].includes(status)
          ? new Date()
          : null,
      })
      .where("id", "=", runId)
      .execute();

  const settle = (input: {
    event: PendingSessionEvent;
    listeners: readonly ProjectListener[];
    timeoutMs?: number;
    signal?: AbortSignal;
    onPoll?: () => Promise<void>;
  }) => {
    const deadline = Date.now() + (input.timeoutMs ?? 10_000);
    return events.settle({
      event: input.event,
      listeners: input.listeners,
      deadlineAt: () => deadline,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onPoll ? { onPoll: input.onPoll } : {}),
    });
  };

  it("counts a project automation bound to the event, and only one that is live", async () => {
    expect(await heard(await project({ bindings: [{}] }))).toEqual([
      "prepare0",
    ]);
    // A member's own automation acts for one person, never for the project.
    expect(
      await heard(await project({ bindings: [{ owner: "member" }] })),
    ).toEqual([]);
    expect(
      await heard(await project({ bindings: [{ activation: "paused" }] })),
    ).toEqual([]);
    expect(
      await heard(await project({ bindings: [{ enablement: "suspended" }] })),
    ).toEqual([]);
    // Nobody is bound at all.
    const none = await project({});
    expect(await heard(none)).toEqual([]);
    expect(
      await events.bound({
        projectId: none.projectId,
        kind: WORKSPACE_SETUP_EVENT,
      }),
    ).toBe(false);
  });

  it("matches each binding's config and where as a dispatch does", async () => {
    const bindings: Binding[] = [
      { workflow: "everyChat" },
      // Config selects the agent.
      { workflow: "reviewers", config: { agentId: "reviewer" } },
      { workflow: "auditors", config: { agentId: "auditor" } },
      // `where` selects on what the event says of the setup, and the chat.
      {
        workflow: "keptOnly",
        where: [{ payload: { detail: { sandbox: "kept" } } }],
      },
      {
        workflow: "newOnly",
        where: [{ payload: { detail: { sandbox: "new" } } }],
      },
      {
        workflow: "pullRequests",
        where: [{ payload: { session: { key: { $prefix: "pr-" } } } }],
      },
    ];
    const kept = await project({ bindings, chat: { key: "pr-acme/web-42" } });
    expect(await heard(kept)).toEqual(
      expect.arrayContaining([
        "everyChat",
        "reviewers",
        "keptOnly",
        "pullRequests",
      ]),
    );
    expect(await heard(kept)).toHaveLength(4);
    // Bound to the kind whatever it selects: the cheap first question.
    expect(
      await events.bound({
        projectId: kept.projectId,
        kind: WORKSPACE_SETUP_EVENT,
      }),
    ).toBe(true);
    const made = await project({
      bindings,
      detail: {
        reason: "created",
        environment: "review",
        workspace: { ref: "main", commit: "b".repeat(40) },
        previous: null,
        sandbox: "new",
      },
    });
    expect((await heard(made)).sort()).toEqual([
      "everyChat",
      "newOnly",
      "reviewers",
    ]);
  });

  it("counts for a member's chat only an automation that may change it, as the dispatcher requires", async () => {
    const bindings: Binding[] = [
      { workflow: "reads" },
      { workflow: "writes", permissions: ["sessions:write"] },
    ];
    expect(
      await heard(await project({ bindings, chat: { owner: "ada" } })),
    ).toEqual(["writes"]);
    // The project's own chats are every project automation's to change.
    expect((await heard(await project({ bindings }))).sort()).toEqual([
      "reads",
      "writes",
    ]);
  });

  it("records the event as waited, with what was asked of its listeners, and hints the dispatcher", async () => {
    const { event, projectId } = await project({ bindings: [{}] });
    const hinted = wakeups.next("events");
    await events.record({ event });
    await hinted.woken;
    const row = await db
      .selectFrom("project_events")
      .selectAll()
      .where("id", "=", event.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      project_id: projectId,
      source: "session",
      kind: WORKSPACE_SETUP_EVENT,
      external_id: event.externalId,
      waited: true,
    });
    expect(row.payload).toEqual(event.payload);
    expect(row.payload).toMatchObject({
      sessionId: event.session.id,
      agentId: "reviewer",
      externalUserId: "catamorphic:project",
      session: { id: event.session.id, title: "Review #42" },
      actor: { kind: "system", code: WORKSPACE_SETUP_EVENT },
      causation: [],
      detail: {
        reason: "base-moved",
        environment: "review",
        workspace: { ref: "refs/pull/42/head", commit: "b".repeat(40) },
        previous: { commit: "a".repeat(40) },
        sandbox: "kept",
      },
    });
  });

  it("waits for nothing when nobody listens", async () => {
    const { event } = await project({});
    const listeners = await events.listeners({ event });
    expect(listeners).toEqual([]);
    expect(await settle({ event, listeners })).toEqual({
      status: "settled",
      runs: [],
      unstarted: [],
    });
  });

  it("waits until every listener's run has ended, however long each takes", async () => {
    const { event } = await project({
      bindings: [{ workflow: "install" }, { workflow: "copyProcedure" }],
    });
    const listeners = await events.listeners({ event });
    expect(listeners).toHaveLength(2);
    await events.record({ event });
    const install = named(listeners, "install");
    const copy = named(listeners, "copyProcedure");
    const waiting = settle({ event, listeners });
    let ended = false;
    void waiting.then(() => {
      ended = true;
    });
    // Nothing delivered yet: the dispatcher has not come by.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBe(false);
    const first = await started({ event, listener: install });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBe(false);
    // One run ended and the other listener's has not started: still waiting.
    await ends(first, "completed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBe(false);
    // A run that has not started, or waits, has not ended.
    const second = await started({ event, listener: copy, status: "pending" });
    await ends(second, "waiting");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBe(false);
    await ends(second, "completed");
    const outcome = await waiting;
    expect(outcome.status).toBe("settled");
    expect(outcome.unstarted).toEqual([]);
    expect(
      outcome.runs.map((run) => [run.workflowName, run.status]).sort(),
    ).toEqual([
      ["copyProcedure", "completed"],
      ["install", "completed"],
    ]);
  });

  it("reports a run that failed or was canceled once every run ended", async () => {
    const { event } = await project({
      bindings: [{ workflow: "install" }, { workflow: "copyProcedure" }],
    });
    const listeners = await events.listeners({ event });
    await events.record({ event });
    const install = named(listeners, "install");
    const copy = named(listeners, "copyProcedure");
    const failed = await started({ event, listener: install });
    const other = await started({ event, listener: copy });
    const waiting = settle({ event, listeners });
    await ends(failed, "failed", "pnpm install exited with 1");
    // A failure does not end the wait: the other still runs.
    let ended = false;
    void waiting.then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ended).toBe(false);
    await ends(other, "canceled");
    const outcome = await waiting;
    expect(outcome.status).toBe("settled");
    expect(outcome.runs).toEqual(
      expect.arrayContaining([
        {
          id: failed,
          workflowName: "install",
          status: "failed",
          error: "pnpm install exited with 1",
        },
        {
          id: other,
          workflowName: "copyProcedure",
          status: "canceled",
          error: null,
        },
      ]),
    );
  });

  it("stops waiting at the deadline, names the runs still going, and cancels them when asked", async () => {
    const { event } = await project({ bindings: [{ workflow: "install" }] });
    const listeners = await events.listeners({ event });
    await events.record({ event });
    const [install] = listeners;
    if (!install) throw new Error("unreachable");
    const slow = await started({ event, listener: install });
    const began = Date.now();
    const outcome = await settle({ event, listeners, timeoutMs: 150 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(140);
    expect(outcome).toEqual({
      status: "timed-out",
      runs: [
        { id: slow, workflowName: "install", status: "running", error: null },
      ],
      unstarted: [],
    });
    canceled.length = 0;
    await events.cancel({ tenantId, event, reason: "Setup timed out" });
    expect(canceled).toEqual([{ runId: slow, reason: "Setup timed out" }]);
    // Nothing is left to cancel.
    await events.cancel({ tenantId, event, reason: "Setup timed out" });
    expect(canceled).toHaveLength(1);
  });

  it("gives back the time its emitter spent on work of its own, and ends the wait when that work throws", async () => {
    const { event } = await project({ bindings: [{ workflow: "install" }] });
    const listeners = await events.listeners({ event });
    await events.record({ event });
    const [install] = listeners;
    if (!install) throw new Error("unreachable");
    const run = await started({ event, listener: install });
    const clock = { deadline: Date.now() + 100 };
    let polls = 0;
    const outcome = await events.settle({
      event,
      listeners,
      deadlineAt: () => clock.deadline,
      onPoll: async () => {
        polls += 1;
        if (polls !== 1) return;
        // The emitter's own work, longer than the wait had left.
        await new Promise((resolve) => setTimeout(resolve, 200));
        clock.deadline += 10_000;
        await ends(run, "completed");
      },
    });
    expect(outcome.status).toBe("settled");
    await expect(
      settle({
        ...(await waited()),
        onPoll: async () => {
          throw new Error("the new sandbox did not start");
        },
      }),
    ).rejects.toThrow("the new sandbox did not start");
  });

  /** An event with one listener whose run goes on. */
  async function waited() {
    const { event } = await project({ bindings: [{ workflow: "install" }] });
    const listeners = await events.listeners({ event });
    await events.record({ event });
    const [install] = listeners;
    if (!install) throw new Error("unreachable");
    const run = await started({ event, listener: install });
    return { event, listeners, run };
  }

  it("stops waiting when its emitter does", async () => {
    const { event, listeners, run } = await waited();
    const stop = new AbortController();
    const waiting = settle({ event, listeners, signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop.abort();
    expect(await waiting).toEqual({
      status: "aborted",
      runs: [
        { id: run, workflowName: "install", status: "running", error: null },
      ],
      unstarted: [],
    });
  });

  it("says which listener started no run of its own, and gives up on a delivery that keeps failing", async () => {
    const { event } = await project({
      bindings: [
        { workflow: "ignored" },
        { workflow: "denied" },
        { workflow: "broken" },
        { workflow: "retried" },
      ],
    });
    const listeners = await events.listeners({ event });
    await events.record({ event });
    const of = (name: string) => named(listeners, name);
    // Delivered, and the run it names by the same key was already there.
    await delivered({ event, listener: of("ignored"), runIds: [] });
    // Delivered with what the dispatcher said of it.
    await delivered({
      event,
      listener: of("denied"),
      error: "Causal cycle suppressed",
    });
    // Given up on by the dispatcher itself.
    await delivered({
      event,
      listener: of("broken"),
      status: "failed",
      error: "Workflow enablement is suspended",
      attempts: 10,
    });
    // Failed once: the dispatcher tries again, and it is waited for.
    await delivered({
      event,
      listener: of("retried"),
      status: "pending",
      error: "connection reset",
      attempts: 1,
    });
    const early = await settle({ event, listeners, timeoutMs: 80 });
    expect(early.status).toBe("timed-out");
    expect(early.unstarted.map((entry) => entry.workflowName).sort()).toEqual([
      "broken",
      "denied",
      "ignored",
    ]);
    // Three tries on, the one who waits stops waiting for it.
    await db
      .updateTable("project_event_deliveries")
      .set({ attempt_count: 3 })
      .where("event_id", "=", event.id)
      .where("activation_id", "=", of("retried").activationId)
      .execute();
    const outcome = await settle({ event, listeners });
    expect(outcome.status).toBe("settled");
    expect(outcome.runs).toEqual([]);
    expect(
      Object.fromEntries(
        outcome.unstarted.map((entry) => [entry.workflowName, entry.reason]),
      ),
    ).toEqual({
      ignored: expect.stringContaining("started no run of its own"),
      denied: "Causal cycle suppressed",
      broken: "Workflow enablement is suspended",
      retried: "connection reset",
    });
  });

  it("no longer waits for a listener turned off before its delivery", async () => {
    const { event, activations } = await project({
      bindings: [{ workflow: "install" }],
    });
    const listeners = await events.listeners({ event });
    await events.record({ event });
    const waiting = settle({ event, listeners });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await db
      .updateTable("workflow_enablement_triggers")
      .set({ status: "paused" })
      .where("id", "=", activations[0] ?? "")
      .execute();
    expect(await waiting).toEqual({
      status: "settled",
      runs: [],
      unstarted: [],
    });
  });

  it("counts only the runs the event started for its listeners", async () => {
    const { event } = await project({
      bindings: [
        { workflow: "install" },
        { workflow: "mine", owner: "member" },
      ],
    });
    const listeners = await events.listeners({ event });
    expect(listeners.map((listener) => listener.workflowName)).toEqual([
      "install",
    ]);
    await events.record({ event });
    const [install] = listeners;
    if (!install) throw new Error("unreachable");
    const run = await started({ event, listener: install });
    // A member's own automation heard the event too; nobody waits for it.
    await db
      .insertInto("workflow_runs")
      .values({
        project_id: event.projectId,
        workflow_name: "mine",
        provenance: JSON.stringify({}),
        status: "running",
        event_id: event.id,
        delivery_key: `event:${crypto.randomUUID()}:${event.id}`,
      })
      .execute();
    await ends(run, "completed");
    const outcome = await settle({ event, listeners });
    expect(outcome).toEqual({
      status: "settled",
      runs: [
        { id: run, workflowName: "install", status: "completed", error: null },
      ],
      unstarted: [],
    });
  });
});
