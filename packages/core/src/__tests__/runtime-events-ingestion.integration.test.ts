import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type { RuntimeInvocationEvent } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RuntimeEventSequenceConflictError,
  RuntimeEventsService,
} from "../services/runtime-events-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_evt_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });
const service = new RuntimeEventsService(db);

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

async function createRun(): Promise<string> {
  const runId = crypto.randomUUID();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "eventful",
      provenance: sql`'{}'::jsonb`,
      status: "running",
    })
    .execute();
  return runId;
}

function stepStarted(args: {
  invocationId: string;
  sequence: number;
  nodeId: string;
  input: unknown;
}): RuntimeInvocationEvent {
  return {
    type: "step_started",
    invocationId: args.invocationId,
    sequence: args.sequence,
    attempt: 1,
    timestamp: new Date().toISOString(),
    nodeId: args.nodeId,
    occurrence: 0,
    name: args.nodeId,
    input: args.input,
  };
}

describeIf("runtime event batch ingestion", () => {
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

  it("keeps each event's payload with its own row across invocations", async () => {
    const runId = await createRun();
    // Two invocations sharing sequence 1 in one batch: a sequence-keyed
    // payload map would give one event the other's payload.
    const result = await service.ingest({
      tenantId,
      runId,
      events: [
        stepStarted({
          invocationId: "inv-a",
          sequence: 1,
          nodeId: "node-a",
          input: { from: "a" },
        }),
        stepStarted({
          invocationId: "inv-b",
          sequence: 1,
          nodeId: "node-b",
          input: { from: "b" },
        }),
      ],
    });
    expect(result).toEqual({ accepted: 2, duplicates: 0 });

    const rows = await db
      .selectFrom("workflow_run_events")
      .where("run_id", "=", runId)
      .select(["invocation_id", "sequence", "payload"])
      .orderBy("invocation_id")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toMatchObject({
      invocationId: "inv-a",
      nodeId: "node-a",
      input: { from: "a" },
    });
    expect(rows[1]?.payload).toMatchObject({
      invocationId: "inv-b",
      nodeId: "node-b",
      input: { from: "b" },
    });
  });

  it("re-ingesting the same batch counts duplicates, not conflicts", async () => {
    const runId = await createRun();
    const events = [
      stepStarted({
        invocationId: "inv-dup",
        sequence: 1,
        nodeId: "node-1",
        input: { n: 1 },
      }),
      stepStarted({
        invocationId: "inv-dup",
        sequence: 2,
        nodeId: "node-2",
        input: { n: 2 },
      }),
    ];
    expect(await service.ingest({ tenantId, runId, events })).toEqual({
      accepted: 2,
      duplicates: 0,
    });
    expect(await service.ingest({ tenantId, runId, events })).toEqual({
      accepted: 0,
      duplicates: 2,
    });
  });

  it("applies an intra-batch duplicate once and validates the repeat", async () => {
    const runId = await createRun();
    const event = stepStarted({
      invocationId: "inv-intra",
      sequence: 1,
      nodeId: "node-1",
      input: { n: 1 },
    });
    const result = await service.ingest({
      tenantId,
      runId,
      events: [event, { ...event }],
    });
    expect(result).toEqual({ accepted: 1, duplicates: 1 });

    const steps = await db
      .selectFrom("workflow_run_steps")
      .where("run_id", "=", runId)
      .select("node_id")
      .execute();
    expect(steps).toHaveLength(1);
  });

  it("rejects a reused sequence carrying different event data", async () => {
    const runId = await createRun();
    await service.ingest({
      tenantId,
      runId,
      events: [
        stepStarted({
          invocationId: "inv-conflict",
          sequence: 1,
          nodeId: "node-1",
          input: { n: 1 },
        }),
      ],
    });
    await expect(
      service.ingest({
        tenantId,
        runId,
        events: [
          stepStarted({
            invocationId: "inv-conflict",
            sequence: 1,
            nodeId: "node-other",
            input: { n: 99 },
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(RuntimeEventSequenceConflictError);
  });

  it("detects a conflicting intra-batch reuse of one sequence", async () => {
    const runId = await createRun();
    // Same (invocation, sequence) twice in ONE batch with different data.
    // Under the old sequence-keyed map the second payload overwrote the
    // first, so the conflict check compared the row against itself and
    // passed silently.
    await expect(
      service.ingest({
        tenantId,
        runId,
        events: [
          stepStarted({
            invocationId: "inv-shadow",
            sequence: 1,
            nodeId: "node-1",
            input: { n: 1 },
          }),
          stepStarted({
            invocationId: "inv-shadow",
            sequence: 1,
            nodeId: "node-2",
            input: { n: 2 },
          }),
        ],
      }),
    ).rejects.toBeInstanceOf(RuntimeEventSequenceConflictError);
  });
});
