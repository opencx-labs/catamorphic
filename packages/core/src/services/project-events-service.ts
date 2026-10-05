import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";

type ProjectEventRow = Selectable<DB["project_events"]>;

export interface ProjectEvent {
  id: string;
  sequence: number;
  projectId: string;
  source: string;
  kind: string;
  externalId: string;
  occurredAt: string;
  receivedAt: string;
  payload: Json;
}

const tracer = getTracer("@catamorphic/core");

export class ProjectEventsService {
  constructor(private readonly db: Kysely<DB>) {}

  /**
   * Record one event for a project, once per `externalId`. Pass the
   * `transaction` that records the change it describes, so the event
   * exists exactly when the change does.
   */
  async append(input: {
    projectId: string;
    source: string;
    kind: string;
    externalId: string;
    occurredAt: string;
    payload: JsonObject;
    transaction?: Transaction<DB>;
  }): Promise<{ event: ProjectEvent; created: boolean }> {
    return withSpan(
      {
        tracer,
        name: "project.event.append",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.event.source": input.source,
          "catamorphic.event.kind": input.kind,
        },
      },
      async () => {
        const db = input.transaction ?? this.db;
        const inserted = await db
          .insertInto("project_events")
          .values({
            project_id: input.projectId,
            source: input.source,
            kind: input.kind,
            external_id: input.externalId,
            occurred_at: new Date(input.occurredAt),
            payload: input.payload,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["project_id", "source", "external_id"])
              .doNothing(),
          )
          .returningAll()
          .executeTakeFirst();
        const row =
          inserted ??
          (await db
            .selectFrom("project_events")
            .selectAll()
            .where("project_id", "=", input.projectId)
            .where("source", "=", input.source)
            .where("external_id", "=", input.externalId)
            .executeTakeFirstOrThrow());
        return { event: mapProjectEvent(row), created: Boolean(inserted) };
      },
    );
  }

  /**
   * Record an event that concerns a whole tenant rather than one project,
   * such as a member joining the directory (ADR 0209), in every project of
   * the tenant with an active activation of its kind. Projects that do not
   * listen store nothing. Each project's copy is idempotent by
   * `externalId`, and the dispatcher delivers it like any project event.
   */
  async appendToSubscribers(input: {
    tenantId: string;
    source: string;
    kind: string;
    externalId: string;
    occurredAt: string;
    payload: JsonObject;
    transaction?: Transaction<DB>;
  }): Promise<{ events: ProjectEvent[] }> {
    return withSpan(
      {
        tracer,
        name: "project.event.append_to_subscribers",
        attributes: {
          "catamorphic.tenant.id": input.tenantId,
          "catamorphic.event.source": input.source,
          "catamorphic.event.kind": input.kind,
        },
      },
      async (span) => {
        const db = input.transaction ?? this.db;
        // The activations the dispatcher delivers to.
        const projects = await db
          .selectFrom("workflow_enablement_triggers as activation")
          .innerJoin(
            "workflow_enablements as enablement",
            "enablement.id",
            "activation.enablement_id",
          )
          .innerJoin(
            "trigger_definitions as definition",
            "definition.id",
            "activation.trigger_definition_id",
          )
          .select("enablement.project_id")
          .distinct()
          .where("enablement.tenant_id", "=", input.tenantId)
          .where("definition.trigger_kind", "=", input.kind)
          .where("activation.status", "=", "active")
          .where("enablement.status", "=", "active")
          .where(({ or, eb }) =>
            or([
              eb("enablement.expires_at", "is", null),
              eb("enablement.expires_at", ">", sql<Date>`now()`),
            ]),
          )
          .orderBy("enablement.project_id")
          .execute();
        span.setAttribute("catamorphic.event.project_count", projects.length);
        const events: ProjectEvent[] = [];
        for (const { project_id: projectId } of projects) {
          const { event } = await this.append({
            projectId,
            source: input.source,
            kind: input.kind,
            externalId: input.externalId,
            occurredAt: input.occurredAt,
            payload: input.payload,
            ...(input.transaction ? { transaction: input.transaction } : {}),
          });
          events.push(event);
        }
        return { events };
      },
    );
  }

  async list(input: {
    projectId: string;
    afterSequence?: number;
    kinds?: string[];
    limit?: number;
  }): Promise<ProjectEvent[]> {
    let query = this.db
      .selectFrom("project_events")
      .selectAll()
      .where("project_id", "=", input.projectId)
      .where("sequence", ">", String(input.afterSequence ?? 0));
    if (input.kinds?.length) query = query.where("kind", "in", input.kinds);
    const rows = await query
      .orderBy("sequence")
      .limit(Math.min(input.limit ?? 100, 1_000))
      .execute();
    return rows.map(mapProjectEvent);
  }
}

function mapProjectEvent(row: ProjectEventRow): ProjectEvent {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    projectId: row.project_id,
    source: row.source,
    kind: row.kind,
    externalId: row.external_id,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    payload: row.payload,
  };
}
