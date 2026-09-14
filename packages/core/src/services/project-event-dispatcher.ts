import { randomUUID } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import type { TriggersService } from "./triggers-service.js";
import type { WorkflowEnablementsService } from "./workflow-enablements-service.js";

const tracer = getTracer("@catamorphic/core");
/** One durable event dispatcher for permanent and session-owned enablements. */
export class ProjectEventDispatcher {
  private readonly workerId = randomUUID();
  constructor(
    private readonly db: Kysely<DB>,
    private readonly triggers: TriggersService,
    private readonly enablements: WorkflowEnablementsService,
  ) {}

  async dispatch(input: { limit?: number } = {}): Promise<number> {
    return withSpan({ tracer, name: "project.events.dispatch" }, async () => {
      const limit = input.limit ?? 100;
      await this.db
        .insertInto("project_event_deliveries")
        .columns(["activation_id", "event_id"])
        .expression((query) =>
          query
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
            .innerJoin("project_events as event", (join) =>
              join
                .onRef("event.project_id", "=", "enablement.project_id")
                .onRef("event.kind", "=", "definition.trigger_kind")
                .onRef("event.received_at", ">=", "activation.created_at"),
            )
            .select(["activation.id", "event.id"])
            .where("activation.status", "=", "active")
            .where("enablement.status", "=", "active")
            .where(({ or, eb }) =>
              or([
                eb("enablement.expires_at", "is", null),
                eb("enablement.expires_at", ">", new Date()),
              ]),
            )
            .where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom("project_event_deliveries as receipt")
                    .select("receipt.event_id")
                    .whereRef("receipt.event_id", "=", "event.id")
                    .whereRef("receipt.activation_id", "=", "activation.id"),
                ),
              ),
            )
            .orderBy("event.sequence")
            .limit(limit),
        )
        .onConflict((conflict) => conflict.doNothing())
        .execute();
      const rows = await this.db.transaction().execute(async (trx) => {
        const due = await trx
          .selectFrom("project_event_deliveries as receipt")
          .innerJoin(
            "workflow_enablement_triggers as activation",
            "activation.id",
            "receipt.activation_id",
          )
          .innerJoin(
            "workflow_enablements as enablement",
            "enablement.id",
            "activation.enablement_id",
          )
          .innerJoin("projects", "projects.id", "enablement.project_id")
          .innerJoin("project_events as event", "event.id", "receipt.event_id")
          .selectAll("event")
          .select([
            "receipt.activation_id",
            "receipt.attempt_count",
            "enablement.id as enablement_id",
            "enablement.workflow_name",
            "enablement.commit_sha",
            "enablement.remote_branch",
            "enablement.environment_name",
            "enablement.owner_external_user_id",
            "projects.tenant_id",
          ])
          .where(({ or, and, eb }) =>
            or([
              and([
                eb("receipt.status", "=", "pending"),
                eb("receipt.next_attempt_at", "<=", new Date()),
              ]),
              and([
                eb("receipt.status", "=", "leased"),
                eb("receipt.lease_expires_at", "<=", new Date()),
              ]),
            ]),
          )
          .orderBy("event.sequence")
          .limit(limit)
          .forUpdate("receipt")
          .skipLocked()
          .execute();
        for (const row of due)
          await trx
            .updateTable("project_event_deliveries")
            .set({
              status: "leased",
              lease_owner: this.workerId,
              lease_expires_at: new Date(Date.now() + 60_000),
              attempt_count: row.attempt_count + 1,
            })
            .where("activation_id", "=", row.activation_id)
            .where("event_id", "=", row.id)
            .execute();
        return due;
      });
      // A batch can take longer than a single run admission. Retain all leased
      // receipts until their individual result is recorded.
      const heartbeat = setInterval(() => {
        void this.db
          .updateTable("project_event_deliveries")
          .set({ lease_expires_at: new Date(Date.now() + 60_000) })
          .where("lease_owner", "=", this.workerId)
          .where("status", "=", "leased")
          .execute()
          .catch(() => undefined);
      }, 20_000);
      heartbeat.unref();
      let count = 0;
      try {
        for (const row of rows) {
          try {
            const { ownerIdentity: identity } =
              await this.enablements.revalidate({
                identity: {
                  tenantId: row.tenant_id,
                  externalUserId: row.owner_external_user_id ?? "",
                },
                enablementId: row.enablement_id,
              });
            const payload = object(row.payload);
            const chain = Array.isArray(payload?.causation)
              ? payload.causation.filter(
                  (value): value is string => typeof value === "string",
                )
              : [];
            const cycle =
              chain.includes(row.enablement_id) || chain.length >= 16;
            if (
              row.source === "session" &&
              typeof payload?.sessionId === "string"
            ) {
              const session = await this.db
                .selectFrom("agent_sessions")
                .select(["external_user_id", "agent_id"])
                .where("id", "=", payload.sessionId)
                .where("project_id", "=", row.project_id)
                .executeTakeFirstOrThrow();
              assertAgentSessionAccess({
                identity,
                projectId: row.project_id,
                externalUserId: session.external_user_id,
                agentId: session.agent_id,
              });
            }
            const correlationKey = `event:${row.activation_id}:${row.id}`;
            const existing = await this.db
              .selectFrom("workflow_runs")
              .select("id")
              .where("workflow_enablement_id", "=", row.enablement_id)
              .where("correlation_key", "=", correlationKey)
              .executeTakeFirst();
            const result = cycle
              ? []
              : existing
                ? [existing.id]
                : (
                    await this.triggers.fireAtCommit({
                      identity,
                      projectId: row.project_id,
                      commitSha: row.commit_sha,
                      remoteBranch: row.remote_branch,
                      environment: row.environment_name,
                      kind: row.kind,
                      payload: {
                        id: row.id,
                        sequence: Number(row.sequence),
                        projectId: row.project_id,
                        source: row.source,
                        kind: row.kind,
                        externalId: row.external_id,
                        occurredAt: row.occurred_at.toISOString(),
                        receivedAt: row.received_at.toISOString(),
                        payload: row.payload,
                      },
                      enablementIds: [row.enablement_id],
                      workflows: [row.workflow_name],
                      mode: "async",
                      correlationKey,
                      onConflict: "ignore",
                    })
                  ).runs.map((run) => run.runId);
            await this.db
              .updateTable("project_event_deliveries")
              .set({
                status: "completed",
                run_ids: result,
                error: cycle ? "Causal cycle suppressed" : null,
                lease_owner: null,
                lease_expires_at: null,
              })
              .where("activation_id", "=", row.activation_id)
              .where("event_id", "=", row.id)
              .where("lease_owner", "=", this.workerId)
              .execute();
            await this.db
              .updateTable("watchers")
              .set(({ ref }) => ({
                cursor_sequence: sql`greatest(${ref("cursor_sequence")}, ${row.sequence})`,
                last_error: null,
                updated_at: new Date(),
              }))
              .where("workflow_enablement_id", "=", row.enablement_id)
              .execute();
            count += result.length;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await this.db
              .updateTable("project_event_deliveries")
              .set({
                status: row.attempt_count >= 9 ? "failed" : "pending",
                error: message,
                next_attempt_at: new Date(
                  Date.now() + Math.min(300_000, 1000 * 2 ** row.attempt_count),
                ),
                lease_owner: null,
                lease_expires_at: null,
              })
              .where("activation_id", "=", row.activation_id)
              .where("event_id", "=", row.id)
              .where("lease_owner", "=", this.workerId)
              .execute();
            await this.db
              .updateTable("watchers")
              .set({ last_error: message, updated_at: new Date() })
              .where("workflow_enablement_id", "=", row.enablement_id)
              .execute();
          }
        }
        return count;
      } finally {
        clearInterval(heartbeat);
      }
    });
  }
}
function object(value: Json): { [key: string]: Json | undefined } | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}
