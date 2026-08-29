import crypto from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SchedulesService } from "../services/schedules-service.js";
import type { StoredTriggerBinding } from "../services/triggers-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_schedules";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const bindingId = crypto.randomUUID();
const identity = { tenantId, externalUserId: "scheduler" };
const binding: StoredTriggerBinding = {
  id: bindingId,
  commitSha: "a".repeat(40),
  environment: "production",
  workflowName: "dailyBrief",
  kind: "schedule",
  config: { cron: "* * * * *", timezone: "UTC" },
  canSuspend: false,
  inputParameters: [],
  inputSchema: {},
  outputSchema: {},
};
const fired: Json[] = [];
const dispatcher = {
  storedProductionBindings: vi.fn(async () => [binding]),
  fire: vi.fn(async (args: { payload: Json }) => {
    fired.push(args.payload);
    return {
      kind: "schedule",
      mode: "async" as const,
      commitSha: binding.commitSha,
      runs: [
        {
          workflowName: binding.workflowName,
          runId: crypto.randomUUID(),
          status: "started" as const,
        },
      ],
    };
  }),
};

describe("schedule trigger dispatcher", () => {
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
    await db
      .insertInto("trigger_binding_scans")
      .values({ project_id: projectId, commit_sha: binding.commitSha })
      .execute();
    await db
      .insertInto("trigger_bindings")
      .values({
        id: bindingId,
        project_id: projectId,
        commit_sha: binding.commitSha,
        workflow_name: binding.workflowName,
        trigger_kind: "schedule",
        config: binding.config,
        can_suspend: false,
        input_parameters: [],
      })
      .execute();
  }, 30_000);

  afterAll(async () => {
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    await db.destroy();
  });

  it("materializes one missed occurrence and enrolls it through triggers", async () => {
    const schedules = new SchedulesService(db, dispatcher);
    await schedules.tick({
      identity,
      projectId,
      now: new Date("2026-08-29T10:00:01.000Z"),
    });
    await db
      .updateTable("schedule_bindings")
      .set({ next_fire_at: new Date("2026-08-29T10:01:00.000Z") })
      .where("binding_id", "=", bindingId)
      .execute();

    expect(
      await schedules.tick({
        identity,
        projectId,
        now: new Date("2026-08-29T10:05:00.000Z"),
      }),
    ).toEqual({ enrolled: 1 });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      bindingId,
      scheduledFor: "2026-08-29T10:01:00.000Z",
      firedAt: "2026-08-29T10:05:00.000Z",
    });
    expect(
      await db
        .selectFrom("schedule_bindings")
        .select("next_fire_at")
        .where("binding_id", "=", bindingId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ next_fire_at: new Date("2026-08-29T10:06:00.000Z") });

    dispatcher.fire.mockRejectedValueOnce(new Error("temporary outage"));
    expect(
      await schedules.tick({
        identity,
        projectId,
        now: new Date("2026-08-29T10:06:00.000Z"),
      }),
    ).toEqual({ enrolled: 0 });
    expect(
      await db
        .selectFrom("schedule_occurrences")
        .select(["status", "attempt_count"])
        .where("binding_id", "=", bindingId)
        .where("scheduled_for", "=", new Date("2026-08-29T10:06:00.000Z"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending", attempt_count: 1 });
    expect(
      await schedules.tick({
        identity,
        projectId,
        now: new Date("2026-08-29T10:06:03.000Z"),
      }),
    ).toEqual({ enrolled: 1 });

    const firedBeforeConcurrentTick = fired.length;
    const secondWorker = new SchedulesService(db, dispatcher);
    const concurrent = await Promise.all([
      schedules.tick({
        identity,
        projectId,
        now: new Date("2026-08-29T10:07:00.000Z"),
      }),
      secondWorker.tick({
        identity,
        projectId,
        now: new Date("2026-08-29T10:07:00.000Z"),
      }),
    ]);
    expect(concurrent.reduce((sum, result) => sum + result.enrolled, 0)).toBe(
      1,
    );
    expect(fired).toHaveLength(firedBeforeConcurrentTick + 1);
  });
});
