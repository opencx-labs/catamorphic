import { randomUUID } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { Cron } from "croner";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type {
  StoredTriggerActivation,
  TriggerFireResult,
} from "./triggers-service.js";

const tracer = getTracer("@catamorphic/core");

interface ScheduleConfig {
  cron: string;
  timezone: string;
}

interface ScheduleTriggerDispatcher {
  storedProductionActivations(args: {
    identity: Identity;
    projectId: string;
    kind: string;
  }): Promise<StoredTriggerActivation[]>;
  fire(args: {
    identity: Identity;
    projectId: string;
    kind: string;
    payload: Json;
    environment?: string;
    mode?: "async" | "sync";
    workflows?: readonly string[];
    enablementIds?: readonly string[];
    correlationKey?: string;
    onConflict?: "ignore" | "error" | "restart";
  }): Promise<TriggerFireResult>;
}

interface ClaimedOccurrence {
  activationId: string;
  enablementId: string;
  scheduledFor: Date;
  workflowName: string;
  environment: string;
  attemptCount: number;
}

/** Materializes and dispatches the built-in `schedule` trigger kind. */
export class SchedulesService {
  private readonly workerId = `schedule:${randomUUID()}`;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly triggers: ScheduleTriggerDispatcher,
  ) {}

  async tick(args: {
    identity: Identity;
    projectId: string;
    now?: Date;
  }): Promise<{ enrolled: number }> {
    return withSpan(
      {
        tracer,
        name: "trigger.schedule.tick",
        attributes: { "catamorphic.project.id": args.projectId },
      },
      async () => {
        const now = args.now ?? new Date();
        await this.synchronize(args.identity, args.projectId, now);
        await this.materializeDue(args.projectId, now);
        return {
          enrolled: await this.dispatchPending(
            args.identity,
            args.projectId,
            now,
          ),
        };
      },
    );
  }

  private async synchronize(
    identity: Identity,
    projectId: string,
    now: Date,
  ): Promise<void> {
    const bindings = await this.triggers.storedProductionActivations({
      identity,
      projectId,
      kind: "schedule",
    });
    for (const binding of bindings) {
      const config = parseConfig(binding.config);
      const existing = await this.db
        .selectFrom("schedule_bindings")
        .selectAll()
        .where("activation_id", "=", binding.activationId)
        .executeTakeFirst();
      const changed =
        !existing ||
        existing.cron_expression !== config.cron ||
        existing.timezone !== config.timezone;
      const nextFireAt = changed ? nextRun(config, now) : existing.next_fire_at;
      await this.db
        .insertInto("schedule_bindings")
        .values({
          activation_id: binding.activationId,
          cron_expression: config.cron,
          timezone: config.timezone,
          next_fire_at: nextFireAt,
        })
        .onConflict((conflict) =>
          conflict.column("activation_id").doUpdateSet({
            cron_expression: config.cron,
            timezone: config.timezone,
            next_fire_at: nextFireAt,
            updated_at: now,
          }),
        )
        .execute();
    }
    const ids = bindings.map((binding) => binding.activationId);
    let stale = this.db
      .deleteFrom("schedule_bindings")
      .where(
        "activation_id",
        "in",
        this.db
          .selectFrom("workflow_enablement_triggers as activation")
          .innerJoin(
            "workflow_enablements as enablement",
            "enablement.id",
            "activation.enablement_id",
          )
          .select("activation.id")
          .where("enablement.project_id", "=", projectId),
      );
    if (ids.length > 0) stale = stale.where("activation_id", "not in", ids);
    await stale.execute();
  }

  private async materializeDue(projectId: string, now: Date): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const due = await transaction
        .selectFrom("schedule_bindings")
        .innerJoin(
          "workflow_enablement_triggers as activation",
          "activation.id",
          "schedule_bindings.activation_id",
        )
        .innerJoin(
          "workflow_enablements as enablement",
          "enablement.id",
          "activation.enablement_id",
        )
        .selectAll("schedule_bindings")
        .where("enablement.project_id", "=", projectId)
        .where("schedule_bindings.next_fire_at", "<=", now)
        .forUpdate("schedule_bindings")
        .skipLocked()
        .execute();
      for (const row of due) {
        const scheduledFor = row.next_fire_at;
        await transaction
          .insertInto("schedule_occurrences")
          .values({
            activation_id: row.activation_id,
            scheduled_for: scheduledFor,
            next_attempt_at: now,
          })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
        const config = {
          cron: row.cron_expression,
          timezone: row.timezone,
        };
        await transaction
          .updateTable("schedule_bindings")
          .set({
            last_scheduled_for: scheduledFor,
            // Coalesce missed clock ticks into this one durable occurrence.
            // The next due time is computed from the worker's current clock,
            // not by replaying every interval spent offline.
            next_fire_at: nextRun(config, now),
            updated_at: now,
          })
          .where("activation_id", "=", row.activation_id)
          .execute();
      }
    });
  }

  private async dispatchPending(
    identity: Identity,
    projectId: string,
    now: Date,
  ): Promise<number> {
    const occurrences = await this.claimPending(projectId, now);
    let enrolled = 0;
    for (const occurrence of occurrences) {
      const correlationKey = `${occurrence.activationId}:${occurrence.scheduledFor.toISOString()}`;
      try {
        // A process can die after TriggersService durably inserts the run but
        // before this occurrence records the receipt. Look for that exact
        // run before redelivery so lease expiry never duplicates a schedule.
        const existingRun = await this.db
          .selectFrom("workflow_runs")
          .select("id")
          .where("project_id", "=", projectId)
          .where("workflow_name", "=", occurrence.workflowName)
          .where("correlation_key", "=", correlationKey)
          .orderBy("created_at", "asc")
          .executeTakeFirst();
        if (existingRun) {
          await this.settleEnrolled(occurrence, [existingRun.id], now);
          enrolled += 1;
          continue;
        }
        const result = await this.triggers.fire({
          identity,
          projectId,
          kind: "schedule",
          mode: "async",
          workflows: [occurrence.workflowName],
          enablementIds: [occurrence.enablementId],
          environment: occurrence.environment,
          correlationKey,
          onConflict: "ignore",
          payload: {
            activationId: occurrence.activationId,
            scheduledFor: occurrence.scheduledFor.toISOString(),
            firedAt: now.toISOString(),
          },
        });
        await this.settleEnrolled(
          occurrence,
          result.runs.map((run) => run.runId),
          now,
        );
        enrolled += 1;
      } catch (error) {
        await this.db
          .updateTable("schedule_occurrences")
          .set({
            status: "pending",
            next_attempt_at: new Date(
              now.getTime() +
                Math.min(300_000, 1_000 * 2 ** occurrence.attemptCount),
            ),
            lease_owner: null,
            lease_expires_at: null,
            error: error instanceof Error ? error.message : String(error),
            updated_at: now,
          })
          .where("activation_id", "=", occurrence.activationId)
          .where("scheduled_for", "=", occurrence.scheduledFor)
          .where("status", "=", "leased")
          .where("lease_owner", "=", this.workerId)
          .execute();
      }
    }
    return enrolled;
  }

  private async claimPending(
    projectId: string,
    now: Date,
  ): Promise<ClaimedOccurrence[]> {
    return this.db.transaction().execute(async (transaction) => {
      const rows = await transaction
        .selectFrom("schedule_occurrences")
        .innerJoin(
          "workflow_enablement_triggers as activation",
          "activation.id",
          "schedule_occurrences.activation_id",
        )
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
        .select([
          "schedule_occurrences.activation_id",
          "schedule_occurrences.scheduled_for",
          "schedule_occurrences.attempt_count",
          "activation.enablement_id",
          "definition.workflow_name",
          "enablement.environment_name",
        ])
        .where("enablement.project_id", "=", projectId)
        .where((expression) =>
          expression.or([
            expression.and([
              expression("schedule_occurrences.status", "=", "pending"),
              expression("schedule_occurrences.next_attempt_at", "<=", now),
            ]),
            expression.and([
              expression("schedule_occurrences.status", "=", "leased"),
              expression("schedule_occurrences.lease_expires_at", "<=", now),
            ]),
          ]),
        )
        .orderBy("schedule_occurrences.scheduled_for")
        .limit(100)
        .forUpdate("schedule_occurrences")
        .skipLocked()
        .execute();
      const leaseExpiresAt = new Date(now.getTime() + 60_000);
      for (const row of rows) {
        await transaction
          .updateTable("schedule_occurrences")
          .set({
            status: "leased",
            attempt_count: row.attempt_count + 1,
            lease_owner: this.workerId,
            lease_expires_at: leaseExpiresAt,
            updated_at: now,
          })
          .where("activation_id", "=", row.activation_id)
          .where("scheduled_for", "=", row.scheduled_for)
          .execute();
      }
      return rows.map((row) => ({
        activationId: row.activation_id,
        enablementId: row.enablement_id,
        scheduledFor: row.scheduled_for,
        workflowName: row.workflow_name,
        environment: row.environment_name,
        attemptCount: row.attempt_count + 1,
      }));
    });
  }

  private async settleEnrolled(
    occurrence: ClaimedOccurrence,
    runIds: string[],
    now: Date,
  ): Promise<void> {
    const result = await this.db
      .updateTable("schedule_occurrences")
      .set({
        status: "enrolled",
        run_ids: runIds,
        completed_at: now,
        lease_owner: null,
        lease_expires_at: null,
        error: null,
        updated_at: now,
      })
      .where("activation_id", "=", occurrence.activationId)
      .where("scheduled_for", "=", occurrence.scheduledFor)
      .where("status", "=", "leased")
      .where("lease_owner", "=", this.workerId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new Error("Schedule occurrence lease was lost");
    }
  }
}

function parseConfig(value: Json): ScheduleConfig {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.cron === "string" &&
    typeof value.timezone === "string"
  ) {
    return { cron: value.cron, timezone: value.timezone };
  }
  throw new Error("Invalid schedule trigger config");
}

function nextRun(config: ScheduleConfig, after: Date): Date {
  const next = new Cron(config.cron, {
    timezone: config.timezone,
    paused: true,
  }).nextRun(after);
  if (!next) throw new Error("Schedule has no next occurrence");
  return next;
}
