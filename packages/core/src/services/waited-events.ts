import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Transaction } from "kysely";
import { projectPrincipalIdentity } from "../identity.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ProjectListener, TriggersService } from "./triggers-service.js";
import type { WorkWakeups } from "./work-wakeups.js";
import {
  type PendingProjectEvent,
  type PendingSessionEvent,
  sessionEventInput,
} from "./workspace-events.js";

/*
 * A waited event (ADR 0355): a hook where something waits. Work records a
 * session event like any other, and its emitter waits a bounded time for
 * the runs that event starts for the project's own automations. Nothing
 * comes back through a run's return value: a workflow decides by calling
 * operations while it runs, and the emitter learns only that every run
 * ended, and how.
 *
 * Who is waited for is who a dispatch would start: an active project
 * automation bound to the kind whose config and `where` match the event,
 * and which may change the chat, as the dispatcher requires of every
 * session event. A member's own automation hears the event too and is
 * never waited for. When nobody listens, nothing is recorded as waited and
 * nothing waits.
 */

const tracer = getTracer("@catamorphic/core");

/** How often a wait looks at its event's deliveries and runs. */
const POLL_MS = 250;

/**
 * Tries after which a delivery that keeps failing is given up on by the
 * one who waits for it. The dispatcher goes on retrying for minutes; a
 * turn does not wait that long for an automation that cannot start.
 */
const DELIVERY_TRIES = 3;

const ENDED: readonly string[] = ["completed", "failed", "canceled"];

/** One run a waited event started, as last read. */
export interface WaitedRun {
  id: string;
  workflowName: string;
  status: string;
  error: string | null;
}

/** How a wait for an event's runs ended. */
export interface WaitedEventOutcome {
  /**
   * `settled`: every listener's delivery was made and every run it started
   * ended. `timed-out`: the deadline passed first. `aborted`: the emitter
   * stopped waiting.
   */
  status: "settled" | "timed-out" | "aborted";
  /** Every run the event started for its listeners, ended or not. */
  runs: WaitedRun[];
  /** Listeners whose delivery started no run of its own, and why. */
  unstarted: Array<{ workflowName: string; reason: string }>;
}

type Executor = Kysely<DB> | Transaction<DB>;

export class WaitedEventsService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      triggers: Pick<TriggersService, "projectListeners">;
      /** Cancel a run nobody waits for any more. */
      cancelRun: (input: {
        tenantId: string;
        runId: string;
        reason: string;
      }) => Promise<void>;
      /** Tells this process's dispatcher an event is waiting (ADR 0229). */
      wakeups?: WorkWakeups;
      /** Milliseconds between looks, for tests. */
      pollMs?: number;
    },
  ) {}

  /**
   * Whether any project automation is bound to `kind` at all, whatever it
   * selects: the cheap question an emitter asks before it reads what an
   * event would say.
   */
  async bound(input: { projectId: string; kind: string }): Promise<boolean> {
    return (await this.deps.triggers.projectListeners(input)).length > 0;
  }

  /**
   * The project automations a dispatch of `event` starts, by activation:
   * bound to its kind with config and `where` matching it, and allowed to
   * change the chat it is about. Read with `executor`, so a caller inside
   * a transaction asks through it.
   */
  async listeners(input: {
    executor?: Executor;
    event: PendingSessionEvent;
  }): Promise<ProjectListener[]> {
    const { event } = input;
    const bound = await this.deps.triggers.projectListeners({
      ...(input.executor ? { executor: input.executor } : {}),
      projectId: event.projectId,
      kind: event.kind,
      payload: sessionEventInput(event),
    });
    return bound.filter((listener) =>
      mayChange({
        listener,
        projectId: event.projectId,
        session: event.session,
      }),
    );
  }

  /**
   * Record `event` as one that is waited for, and wake this process's
   * dispatcher so its runs start without a poll interval. With `atCommit`
   * the event is delivered at that published revision by its emitter (a
   * deploy, ADR 0355), which starts its runs itself: the dispatcher leaves
   * it alone. Recording the same event again changes nothing, so an emitter
   * that stopped after it may record it once more.
   */
  async record(input: {
    executor?: Executor;
    event: PendingProjectEvent;
    atCommit?: string;
  }): Promise<void> {
    const { event } = input;
    await (input.executor ?? this.deps.db)
      .insertInto("project_events")
      .values({
        id: event.id,
        project_id: event.projectId,
        source: event.source,
        kind: event.kind,
        external_id: event.externalId,
        occurred_at: new Date(event.occurredAt),
        payload: event.payload,
        waited: true,
        ...(input.atCommit ? { at_commit: input.atCommit } : {}),
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    if (!input.atCommit) this.deps.wakeups?.notify("events");
  }

  /**
   * Every run the event started, as its dispatcher stamped them: what an
   * emitter that delivers its own event (ADR 0355) reads to see where they
   * stand.
   */
  async runs(input: {
    event: Pick<PendingProjectEvent, "id" | "projectId">;
  }): Promise<WaitedRun[]> {
    const rows = await this.deps.db
      .selectFrom("workflow_runs")
      .select(["id", "workflow_name", "status", "error"])
      .where("project_id", "=", input.event.projectId)
      .where("event_id", "=", input.event.id)
      .orderBy("created_at")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      workflowName: row.workflow_name,
      status: row.status,
      error: row.error,
    }));
  }

  /**
   * Wait until every listener's delivery of the event was made and every
   * run it started ended, or `deadlineAt` passes, or `signal` aborts.
   * `deadlineAt` is asked on every look, so an emitter that did work of its
   * own meanwhile (`onPoll`) can give that time back. Runs still going at
   * the end are the emitter's to cancel, with {@link cancel}.
   */
  async settle(input: {
    event: Pick<PendingProjectEvent, "id" | "projectId" | "kind">;
    listeners: readonly ProjectListener[];
    /** Epoch milliseconds. */
    deadlineAt: () => number;
    signal?: AbortSignal;
    /** The emitter's own work between looks; a throw ends the wait with it. */
    onPoll?: () => Promise<void>;
  }): Promise<WaitedEventOutcome> {
    return withSpan(
      {
        tracer,
        name: "project.event.wait",
        attributes: {
          "catamorphic.project.id": input.event.projectId,
          "catamorphic.event.id": input.event.id,
          "catamorphic.event.kind": input.event.kind,
          "catamorphic.event.listener_count": input.listeners.length,
        },
      },
      async (span) => {
        const pollMs = this.deps.pollMs ?? POLL_MS;
        for (;;) {
          const seen = await this.look(input);
          const outcome = (
            status: WaitedEventOutcome["status"],
          ): WaitedEventOutcome => {
            span.setAttribute("catamorphic.event.wait.status", status);
            span.setAttribute("catamorphic.event.run_count", seen.runs.length);
            return { status, runs: seen.runs, unstarted: seen.unstarted };
          };
          if (!seen.pending) return outcome("settled");
          if (input.signal?.aborted) return outcome("aborted");
          if (Date.now() >= input.deadlineAt()) return outcome("timed-out");
          await input.onPoll?.();
          await pause(pollMs, input.signal);
        }
      },
    );
  }

  /**
   * Cancel every run the event started that has not ended: nobody waits
   * for them any more.
   */
  async cancel(input: {
    tenantId: string;
    event: Pick<PendingProjectEvent, "id" | "projectId">;
    reason: string;
  }): Promise<void> {
    const runs = await this.deps.db
      .selectFrom("workflow_runs")
      .select("id")
      .where("project_id", "=", input.event.projectId)
      .where("event_id", "=", input.event.id)
      .where("status", "not in", [...ENDED])
      .execute();
    for (const run of runs) {
      await this.deps
        .cancelRun({
          tenantId: input.tenantId,
          runId: run.id,
          reason: input.reason,
        })
        .catch((error: unknown) =>
          console.warn(
            `[catamorphic] Could not cancel run ${run.id} of an event nobody waits for any more`,
            error,
          ),
        );
    }
  }

  /** Where the event's deliveries and runs stand now. */
  private async look(input: {
    event: Pick<PendingProjectEvent, "id" | "projectId">;
    listeners: readonly ProjectListener[];
  }): Promise<{
    pending: boolean;
    runs: WaitedRun[];
    unstarted: WaitedEventOutcome["unstarted"];
  }> {
    const { event, listeners } = input;
    if (listeners.length === 0)
      return { pending: false, runs: [], unstarted: [] };
    const activations = listeners.map((listener) => listener.activationId);
    const receipts = await this.deps.db
      .selectFrom("project_event_deliveries")
      .select(["activation_id", "status", "attempt_count", "error"])
      .where("event_id", "=", event.id)
      .where("activation_id", "in", activations)
      .execute();
    // Stamped by the dispatcher alone: no other run carries this event.
    const started = await this.deps.db
      .selectFrom("workflow_runs")
      .select(["id", "workflow_name", "status", "error", "delivery_key"])
      .where("project_id", "=", event.projectId)
      .where("event_id", "=", event.id)
      .execute();
    // A listener turned off since it was counted is no longer waited for.
    const live = await this.deps.db
      .selectFrom("workflow_enablement_triggers as activation")
      .innerJoin(
        "workflow_enablements as enablement",
        "enablement.id",
        "activation.enablement_id",
      )
      .select("activation.id")
      .where("activation.id", "in", activations)
      .where("activation.status", "=", "active")
      .where("enablement.status", "=", "active")
      .execute();
    const runs: WaitedRun[] = [];
    const unstarted: WaitedEventOutcome["unstarted"] = [];
    let pending = false;
    for (const listener of listeners) {
      const receipt = receipts.find(
        (row) => row.activation_id === listener.activationId,
      );
      // One event starts one run of each activation's workflow, named by
      // this key (ADR 0325).
      const run = started.find(
        (row) =>
          row.delivery_key === `event:${listener.activationId}:${event.id}`,
      );
      if (run) {
        runs.push({
          id: run.id,
          workflowName: run.workflow_name,
          status: run.status,
          error: run.error,
        });
        if (!ENDED.includes(run.status)) pending = true;
        continue;
      }
      if (receipt?.status === "completed") {
        unstarted.push({
          workflowName: listener.workflowName,
          reason:
            receipt.error ??
            "its delivery started no run of its own (a run it names by the same key was already there, or the automation was suspended)",
        });
        continue;
      }
      if (
        receipt &&
        (receipt.status === "failed" ||
          (receipt.error && receipt.attempt_count >= DELIVERY_TRIES))
      ) {
        unstarted.push({
          workflowName: listener.workflowName,
          reason: receipt.error ?? "its delivery failed",
        });
        continue;
      }
      if (!receipt && !live.some((row) => row.id === listener.activationId))
        continue;
      pending = true;
    }
    return { pending, runs, unstarted };
  }
}

/**
 * Whether a project automation may change the chat an event is about, as
 * the dispatcher asks before it delivers a session event: the project's
 * own chats always, a member's only with `sessions:write`.
 */
function mayChange(input: {
  listener: ProjectListener;
  projectId: string;
  session: PendingSessionEvent["session"];
}): boolean {
  const { listener } = input;
  try {
    assertAgentSessionAccess({
      identity: projectPrincipalIdentity({
        tenantId: listener.tenantId,
        projectId: input.projectId,
        environment: listener.environment,
        workflowName: listener.workflowName,
        permissions: listener.permissions,
      }),
      projectId: input.projectId,
      externalUserId: input.session.externalUserId,
      agentId: input.session.agentId,
      intent: "change",
    });
    return true;
  } catch (error) {
    if (error instanceof AccessDeniedError) return false;
    throw error;
  }
}

/** Wait `ms`, or until `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
