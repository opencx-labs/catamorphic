import { randomUUID } from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import { requireTenantProject } from "./projects-service.js";

export type EventSourcePlacement = "local" | "remote" | "any";

type MonitorRow = Selectable<DB["project_event_monitors"]>;
const tracer = getTracer("@catamorphic/core");

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

export interface ProjectEventSourceProvider {
  kind: string;
  poll(input: {
    monitor: ProjectEventMonitor;
    identity: Identity;
  }): Promise<{ cursor: Json | null }>;
}

export class ProjectEventMonitorsService {
  constructor(private readonly db: Kysely<DB>) {}

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
        cursor: input.cursor ?? null,
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
        .where("monitor.status", "=", "active")
        .where("monitor.next_poll_at", "<=", new Date())
        .where((expression) =>
          expression.or([
            expression("monitor.placement", "=", input.placement),
            expression("monitor.placement", "=", "any"),
          ]),
        )
        .where((expression) =>
          expression.or([
            expression("monitor.lease_expires_at", "is", null),
            expression("monitor.lease_expires_at", "<", new Date()),
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
          lease_expires_at: new Date(Date.now() + leaseSeconds * 1_000),
          updated_at: new Date(),
        })
        .where("id", "=", candidate.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ...mapMonitor(claimed), tenantId: candidate.tenant_id };
    });
  }

  async complete(input: {
    monitorId: string;
    leaseToken: string;
    cursor: Json | null;
  }): Promise<void> {
    await this.db
      .updateTable("project_event_monitors")
      .set(({ ref }) => ({
        cursor: input.cursor,
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
        next_poll_at: new Date(Date.now() + 60_000),
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
  monitors: ProjectEventMonitorsService;
  providers: readonly ProjectEventSourceProvider[];
  placement: Exclude<EventSourcePlacement, "any">;
  pollEveryMs?: number;
}): { stop: () => void } {
  const providers = new Map(
    input.providers.map((provider) => [provider.kind, provider]),
  );
  const workerId = `project-events:${input.placement}:${randomUUID()}`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    const monitor = await input.monitors.claim({
      workerId,
      placement: input.placement,
    });
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
    timer = setTimeout(() => void tick(), input.pollEveryMs ?? 1_000);
    timer.unref?.();
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
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
