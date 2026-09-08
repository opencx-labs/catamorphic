import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable } from "kysely";

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

  async append(input: {
    projectId: string;
    source: string;
    kind: string;
    externalId: string;
    occurredAt: string;
    payload: JsonObject;
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
        const inserted = await this.db
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
          (await this.db
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
