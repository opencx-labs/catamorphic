import { createDatabase } from "@catamorphic/db";
import type { RuntimeInvocationEvent } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RuntimeEventSequenceConflictError,
  RuntimeEventsService,
  RuntimeStepReplayConflictError,
} from "../services/runtime-events-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_runtime_events_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const runId = crypto.randomUUID();
const invocationId = `${runId}:1`;
const timestamp = "2026-07-12T12:00:00.000Z";

describeIf("RuntimeEventsService integration", () => {
  beforeAll(async () => {
    await sql
      .raw(`
        CREATE SCHEMA "${schema}";
        CREATE TABLE "${schema}".tenants (
          id uuid PRIMARY KEY,
          name text NOT NULL
        );
        CREATE TABLE "${schema}".projects (
          id uuid PRIMARY KEY,
          tenant_id uuid NOT NULL REFERENCES "${schema}".tenants(id),
          name text NOT NULL
        );
        CREATE TABLE "${schema}".workflow_runs (
          id uuid PRIMARY KEY,
          project_id uuid NOT NULL REFERENCES "${schema}".projects(id),
          workflow_name text NOT NULL,
          commit_sha char(40),
          mode text NOT NULL,
          status text NOT NULL,
          trigger_data jsonb,
          result jsonb,
          error text,
          external_user_id text,
          deployment_artifact_id uuid,
          cancel_requested_at timestamptz,
          attempt integer NOT NULL DEFAULT 0,
          started_at timestamptz,
          completed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE "${schema}".workflow_run_events (
          id bigserial PRIMARY KEY,
          run_id uuid NOT NULL REFERENCES "${schema}".workflow_runs(id),
          invocation_id text NOT NULL,
          sequence integer NOT NULL,
          attempt integer NOT NULL,
          type text NOT NULL,
          payload jsonb,
          created_at timestamptz NOT NULL,
          UNIQUE (invocation_id, sequence)
        );
        CREATE TABLE "${schema}".workflow_run_steps (
          id uuid PRIMARY KEY,
          run_id uuid NOT NULL REFERENCES "${schema}".workflow_runs(id),
          node_id text NOT NULL,
          occurrence integer NOT NULL,
          name text NOT NULL,
          status text NOT NULL,
          input jsonb,
          output jsonb,
          error text,
          attempt integer NOT NULL,
          started_at timestamptz,
          completed_at timestamptz,
          UNIQUE (run_id, node_id, occurrence)
        );
      `)
      .execute(db);
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Runtime events tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        tenant_id: tenantId,
        name: "Runtime events project",
      })
      .execute();
    await db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "durableWorkflow",
        commit_sha: "a".repeat(40),
        mode: "production",
        status: "pending",
      })
      .execute();
  });

  afterAll(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("persists incremental steps idempotently across reporter restarts", async () => {
    const firstReporter = new RuntimeEventsService(db);
    const progress = events().slice(0, 4);
    await expect(
      firstReporter.ingest({ tenantId, runId, events: progress }),
    ).resolves.toEqual({ accepted: 4, duplicates: 0 });

    const restartedReporter = new RuntimeEventsService(db);
    await expect(
      restartedReporter.ingest({ tenantId, runId, events: progress }),
    ).resolves.toEqual({ accepted: 0, duplicates: 4 });
    await expect(
      restartedReporter.ingest({
        tenantId,
        runId,
        events: events().slice(3),
      }),
    ).resolves.toEqual({ accepted: 1, duplicates: 1 });

    const [storedEvents, steps, run, replay] = await Promise.all([
      db
        .selectFrom("workflow_run_events")
        .where("run_id", "=", runId)
        .selectAll()
        .execute(),
      db
        .selectFrom("workflow_run_steps")
        .where("run_id", "=", runId)
        .selectAll()
        .execute(),
      db
        .selectFrom("workflow_runs")
        .where("id", "=", runId)
        .selectAll()
        .executeTakeFirstOrThrow(),
      restartedReporter.replay({ tenantId, runId }),
    ]);
    expect(storedEvents).toHaveLength(5);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      node_id: "node-1",
      occurrence: 0,
      status: "completed",
      output: { value: 2 },
    });
    expect(run).toMatchObject({ status: "completed", result: { ok: true } });
    expect(replay).toEqual({ "node-1:0": { value: 2 } });
  });

  it("deduplicates sequences per invocation and rejects conflicting reuse", async () => {
    const service = new RuntimeEventsService(db);
    const retryInvocation = `${runId}:2`;
    const retryAccepted: RuntimeInvocationEvent = {
      invocationId: retryInvocation,
      sequence: 1,
      attempt: 2,
      timestamp,
      type: "accepted",
    };
    await expect(
      service.ingest({ tenantId, runId, events: [retryAccepted] }),
    ).resolves.toEqual({ accepted: 1, duplicates: 0 });
    await expect(
      service.ingest({ tenantId, runId, events: [retryAccepted] }),
    ).resolves.toEqual({ accepted: 0, duplicates: 1 });
    await expect(
      service.ingest({
        tenantId,
        runId,
        events: [{ ...retryAccepted, type: "started" }],
      }),
    ).rejects.toBeInstanceOf(RuntimeEventSequenceConflictError);
  });

  it("keeps completed replay outputs immutable across attempts", async () => {
    const service = new RuntimeEventsService(db);
    await expect(
      service.ingest({
        tenantId,
        runId,
        events: [
          {
            invocationId: `${runId}:3`,
            sequence: 1,
            attempt: 3,
            timestamp,
            type: "step_completed",
            nodeId: "node-1",
            occurrence: 0,
            name: "Double",
            output: { value: 3 },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(RuntimeStepReplayConflictError);
    const step = await db
      .selectFrom("workflow_run_steps")
      .where("run_id", "=", runId)
      .where("node_id", "=", "node-1")
      .where("occurrence", "=", 0)
      .select("output")
      .executeTakeFirstOrThrow();
    expect(step.output).toEqual({ value: 2 });
  });
});

function events(): RuntimeInvocationEvent[] {
  return [
    {
      invocationId,
      sequence: 1,
      attempt: 1,
      timestamp,
      type: "accepted",
    },
    {
      invocationId,
      sequence: 2,
      attempt: 1,
      timestamp,
      type: "started",
    },
    {
      invocationId,
      sequence: 3,
      attempt: 1,
      timestamp,
      type: "step_started",
      nodeId: "node-1",
      occurrence: 0,
      name: "Double",
      input: { value: 1 },
    },
    {
      invocationId,
      sequence: 4,
      attempt: 1,
      timestamp,
      type: "step_completed",
      nodeId: "node-1",
      occurrence: 0,
      name: "Double",
      output: { value: 2 },
    },
    {
      invocationId,
      sequence: 5,
      attempt: 1,
      timestamp,
      type: "completed",
      result: { ok: true },
    },
  ];
}
