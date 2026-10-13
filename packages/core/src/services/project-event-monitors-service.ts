import { randomUUID } from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  sql,
} from "kysely";
import type { Identity } from "../identity.js";
import { requireTenantProject } from "./projects-service.js";
import { jsonColumn } from "./run-coordinator.js";
import { PollPacer, type WorkWakeups } from "./work-wakeups.js";

/**
 * A source's cursor as jsonb. A host's cursor may be a bare string (a Slack
 * `ts`, a page token), which node-postgres would send as unquoted text.
 */
function cursorColumn(cursor: Json | null | undefined) {
  return cursor === undefined || cursor === null ? null : jsonColumn(cursor);
}

export type EventSourcePlacement = "local" | "remote" | "any";

type MonitorRow = Selectable<DB["project_event_monitors"]>;
const tracer = getTracer("@catamorphic/core");

/**
 * A monitor a worker of this placement polls once it is due: active,
 * observed by a live watcher.
 */
function watchedFor(placement: Exclude<EventSourcePlacement, "any">) {
  return (
    eb: ExpressionBuilder<
      DB & { monitor: DB["project_event_monitors"] },
      "monitor"
    >,
  ) =>
    eb.and([
      eb("monitor.status", "=", "active"),
      eb.exists(
        eb
          .selectFrom("watchers as watcher")
          .select("watcher.id")
          .whereRef("watcher.monitor_id", "=", "monitor.id")
          .where("watcher.status", "=", "active")
          .where(({ or, eb }) =>
            or([
              eb("watcher.expires_at", "is", null),
              eb("watcher.expires_at", ">", sql<Date>`now()`),
            ]),
          ),
      ),
      eb.or([
        eb("monitor.placement", "=", placement),
        eb("monitor.placement", "=", "any"),
      ]),
    ]);
}

export interface ProjectEventMonitor {
  id: string;
  projectId: string;
  tenantId?: string;
  sourceKind: string;
  sourceKey: string;
  ownerExternalUserId: string;
  placement: EventSourcePlacement;
  config: Json;
  cursor: Json | null;
  pollIntervalSeconds: number;
  leaseToken: string | null;
}

/**
 * A host-registered source of Project Events that is polled rather than
 * pushed (ADRs 0074, 0177), such as a desktop's poller of a code host for projects
 * without a public webhook URL. A watcher names the source; a monitor keeps
 * its cursor and lease; `poll` appends events through the host's own
 * `ProjectEventsService`.
 */
export interface ProjectEventSourceProvider {
  kind: string;
  /**
   * Trigger kinds the source's events fire, e.g. `webhook`. A watcher on
   * this source must bind at least one of them.
   */
  eventKinds?: readonly string[];
  /**
   * Check that the caller may read the source for this project and return
   * the cursor at which new events begin, so a new watcher sees only what
   * happens after it starts.
   */
  start?(input: {
    identity: Identity;
    projectId: string;
    config: Json;
    signal: AbortSignal;
  }): Promise<{ cursor: Json | null }>;
  poll(input: {
    monitor: ProjectEventMonitor;
    identity: Identity;
    signal: AbortSignal;
  }): Promise<{ cursor: Json | null }>;
}

export class ProjectEventMonitorsService {
  constructor(
    private readonly db: Kysely<DB>,
    /** Tells this process's monitor worker a monitor may be due (ADR 0228). */
    private readonly wakeups?: WorkWakeups,
  ) {}

  async ensure(input: {
    identity: Identity;
    projectId: string;
    sourceKind: string;
    sourceKey: string;
    placement: EventSourcePlacement;
    config?: JsonObject;
    cursor?: Json;
    pollIntervalSeconds?: number;
  }): Promise<ProjectEventMonitor> {
    await requireTenantProject(
      this.db,
      input.identity.tenantId,
      input.projectId,
    );
    const row = await this.db
      .insertInto("project_event_monitors")
      .values({
        project_id: input.projectId,
        source_kind: input.sourceKind,
        source_key: input.sourceKey,
        owner_external_user_id: input.identity.externalUserId,
        placement: input.placement,
        config: input.config ?? {},
        cursor: cursorColumn(input.cursor),
        poll_interval_seconds: input.pollIntervalSeconds ?? 30,
      })
      .onConflict((conflict) =>
        conflict
          .columns([
            "project_id",
            "source_kind",
            "source_key",
            "owner_external_user_id",
          ])
          .doUpdateSet({
            status: "active",
            placement: input.placement,
            config: input.config ?? {},
            poll_interval_seconds: input.pollIntervalSeconds ?? 30,
            updated_at: new Date(),
          }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    this.wakeups?.notify("events");
    return mapMonitor(row);
  }

  async claim(input: {
    workerId: string;
    placement: Exclude<EventSourcePlacement, "any">;
    leaseSeconds?: number;
  }): Promise<ProjectEventMonitor | null> {
    const leaseToken = randomUUID();
    const leaseSeconds = input.leaseSeconds ?? 60;
    return this.db.transaction().execute(async (trx) => {
      const candidate = await trx
        .selectFrom("project_event_monitors as monitor")
        .innerJoin("projects", "projects.id", "monitor.project_id")
        .selectAll("monitor")
        .select("projects.tenant_id")
        .where(watchedFor(input.placement))
        .where("monitor.next_poll_at", "<=", sql<Date>`now()`)
        .where((expression) =>
          expression.or([
            expression("monitor.lease_expires_at", "is", null),
            expression("monitor.lease_expires_at", "<", sql<Date>`now()`),
          ]),
        )
        .orderBy("monitor.next_poll_at")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return null;
      const claimed = await trx
        .updateTable("project_event_monitors")
        .set({
          lease_owner: input.workerId,
          lease_token: leaseToken,
          lease_expires_at: sql<Date>`now() + make_interval(secs => ${leaseSeconds})`,
          updated_at: new Date(),
        })
        .where("id", "=", candidate.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ...mapMonitor(claimed), tenantId: candidate.tenant_id };
    });
  }

  /**
   * When the soonest monitor a worker of this placement claims falls due
   * (its next poll, or the end of another worker's lease), or null when
   * none is watched. An idle worker sleeps no longer than this (ADR 0228).
   */
  async nextDueAt(input: {
    placement: Exclude<EventSourcePlacement, "any">;
  }): Promise<Date | null> {
    const row = await this.db
      .selectFrom("project_event_monitors as monitor")
      .select(({ fn, ref }) =>
        fn
          .min(
            sql<Date>`greatest(${ref("monitor.next_poll_at")}, ${ref("monitor.lease_expires_at")})`,
          )
          .as("at"),
      )
      .where(watchedFor(input.placement))
      .executeTakeFirst();
    return row?.at ? new Date(row.at) : null;
  }

  async complete(input: {
    monitorId: string;
    leaseToken: string;
    cursor: Json | null;
  }): Promise<void> {
    await this.db
      .updateTable("project_event_monitors")
      .set(({ ref }) => ({
        cursor: cursorColumn(input.cursor),
        next_poll_at: sql`now() + (${ref(
          "poll_interval_seconds",
        )} * interval '1 second')`,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        last_error: null,
        updated_at: new Date(),
      }))
      .where("id", "=", input.monitorId)
      .where("lease_token", "=", input.leaseToken)
      .execute();
  }

  async fail(input: {
    monitorId: string;
    leaseToken: string;
    error: string;
  }): Promise<void> {
    await this.db
      .updateTable("project_event_monitors")
      .set({
        next_poll_at: sql<Date>`now() + interval '60 seconds'`,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        last_error: input.error,
        updated_at: new Date(),
      })
      .where("id", "=", input.monitorId)
      .where("lease_token", "=", input.leaseToken)
      .execute();
  }
}

export function startProjectEventMonitorWorker(input: {
  monitors: Pick<ProjectEventMonitorsService, "claim" | "complete" | "fail"> &
    Partial<Pick<ProjectEventMonitorsService, "nextDueAt">>;
  providers: readonly ProjectEventSourceProvider[];
  placement: Exclude<EventSourcePlacement, "any">;
  pollEveryMs?: number;
  /**
   * How long it waits while no monitor is due (ADR 0228), ending at the
   * next due monitor or this process's event hints. Without one it waits
   * `pollEveryMs` between polls.
   */
  idlePollMs?: number;
  wakeups?: WorkWakeups;
}): { stop: () => Promise<void> } {
  const providers = new Map(
    input.providers.map((provider) => [provider.kind, provider]),
  );
  const workerId = `project-events:${input.placement}:${randomUUID()}`;
  let stopped = false;
  const controller = new AbortController();
  const pacer = new PollPacer({
    quickMs: input.pollEveryMs ?? 1_000,
    idleMs: input.idlePollMs,
    signal: controller.signal,
    wakeups: input.wakeups,
    topic: "events",
  });
  const tick = async () => {
    if (stopped) return;
    try {
      const monitor = await input.monitors.claim({
        workerId,
        placement: input.placement,
      });
      if (monitor) pacer.busy();
      if (monitor?.leaseToken && monitor.tenantId) {
        const provider = providers.get(monitor.sourceKind);
        const tenantId = monitor.tenantId;
        try {
          if (!provider)
            throw new Error(`No event source '${monitor.sourceKind}'`);
          const result = await withSpan(
            {
              tracer,
              name: "project.event.monitor.poll",
              attributes: {
                "catamorphic.project.id": monitor.projectId,
                "catamorphic.monitor.id": monitor.id,
                "catamorphic.event.source": monitor.sourceKind,
              },
            },
            () =>
              provider.poll({
                monitor,
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(45_000),
                ]),
                identity: {
                  tenantId,
                  externalUserId: monitor.ownerExternalUserId,
                },
              }),
          );
          await input.monitors.complete({
            monitorId: monitor.id,
            leaseToken: monitor.leaseToken,
            cursor: result.cursor,
          });
        } catch (error) {
          await input.monitors.fail({
            monitorId: monitor.id,
            leaseToken: monitor.leaseToken,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (!stopped)
        console.warn("[catamorphic] Event monitor poll failed", error);
    }
  };
  const loop = async () => {
    while (!stopped) {
      await tick();
      if (stopped) return;
      // Idle: sleep until the next watched monitor falls due, a hint from
      // this process, or the idle poll.
      const due = pacer.quick
        ? undefined
        : await input.monitors
            .nextDueAt?.({ placement: input.placement })
            .catch(() => undefined);
      await pacer.wait({ until: due?.getTime() });
    }
  };
  const pending = loop();
  return {
    stop: async () => {
      stopped = true;
      controller.abort();
      await pending;
    },
  };
}

function placement(value: string): EventSourcePlacement {
  if (value !== "local" && value !== "remote" && value !== "any") {
    throw new Error(`Invalid event-source placement '${value}'`);
  }
  return value;
}

function mapMonitor(row: MonitorRow): ProjectEventMonitor {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    ownerExternalUserId: row.owner_external_user_id,
    placement: placement(row.placement),
    config: row.config,
    cursor: row.cursor,
    pollIntervalSeconds: row.poll_interval_seconds,
    leaseToken: row.lease_token,
  };
}
