import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunCoordinator } from "../services/run-coordinator.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_phase_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

async function seedRun(args: { status?: string }): Promise<{
  runId: string;
  attemptId: string;
}> {
  const runId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "batch",
      mode: "test",
      provenance: sql`'{}'::jsonb`,
      status: args.status ?? "running",
      phase: "execute",
    })
    .execute();
  await db
    .insertInto("workflow_step_attempts")
    .values({
      id: attemptId,
      run_id: runId,
      step_index: 0,
      step_node_id: "batch-0",
      executor: "batch",
      attempt: 1,
      status: "running",
    })
    .execute();
  await db
    .insertInto("workflow_run_states")
    .values({
      run_id: runId,
      execution_plan: sql`'{}'::jsonb`,
      active_workflow_step_attempt_id: attemptId,
    })
    .execute();
  return { runId, attemptId };
}

describeIf("batch phase transitions", () => {
  const coordinator = new RunCoordinator(db, {} as never);

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
  }, 120_000);

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("leaves the run untouched when the phase already matches", async () => {
    const { runId, attemptId } = await seedRun({});
    await coordinator.setPhase({
      runId,
      workflowStepAttemptId: attemptId,
      phase: "process",
    });
    const first = await db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .select(["phase", "updated_at"])
      .executeTakeFirstOrThrow();
    expect(first.phase).toBe("process");

    // Every item of a batch re-asserts the phase it is already in. Rewriting
    // the row each time would leave one dead tuple per item on a single row.
    await coordinator.setPhase({
      runId,
      workflowStepAttemptId: attemptId,
      phase: "process",
    });
    const second = await db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .select(["phase", "updated_at"])
      .executeTakeFirstOrThrow();
    expect(second.updated_at).toEqual(first.updated_at);
  });

  it("does not serialize concurrent phase writers on the run row", async () => {
    const { runId, attemptId } = await seedRun({});
    // With an explicit FOR UPDATE on workflow_runs these would queue one behind
    // another; the conditional update lets them proceed together.
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        coordinator.setPhase({
          runId,
          workflowStepAttemptId: attemptId,
          phase: index % 2 === 0 ? "process" : "sink",
        }),
      ),
    );
    const run = await db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .select(["status", "phase"])
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("running");
    expect(["process", "sink"]).toContain(run.phase);
  });

  it("refuses to advance the phase of a terminal run", async () => {
    const { runId, attemptId } = await seedRun({ status: "running" });
    await db
      .updateTable("workflow_runs")
      .set({
        status: "canceled",
        completed_at: sql<Date>`clock_timestamp()`,
      })
      .where("id", "=", runId)
      .execute();

    await coordinator.setPhase({
      runId,
      workflowStepAttemptId: attemptId,
      phase: "sink",
    });
    const run = await db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .select(["status", "phase"])
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("canceled");
    expect(run.phase).toBe("execute");
  });

  it("ignores a step attempt that is no longer the active one", async () => {
    const { runId } = await seedRun({});
    await coordinator.setPhase({
      runId,
      workflowStepAttemptId: crypto.randomUUID(),
      phase: "sink",
    });
    const run = await db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .select("phase")
      .executeTakeFirstOrThrow();
    expect(run.phase).toBe("execute");
  });
});
