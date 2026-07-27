import type { DB, Json, JsonValue } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  RuntimeInvocationEvent,
  RuntimeInvocationEventSink,
} from "@catamorphic/sandbox";
import { RuntimeEventReportingError } from "@catamorphic/sandbox";
import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";

const tracer = getTracer("@catamorphic/core");

export class RuntimeEventSequenceConflictError extends Error {
  constructor(args: { invocationId: string; sequence: number }) {
    super(
      `Invocation '${args.invocationId}' sequence ${args.sequence} was reused with different event data`,
    );
    this.name = "RuntimeEventSequenceConflictError";
  }
}

export class RuntimeEventRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run '${runId}' not found`);
    this.name = "RuntimeEventRunNotFoundError";
  }
}

export class RuntimeStepReplayConflictError extends Error {
  constructor(args: { runId: string; nodeId: string; occurrence: number }) {
    super(
      `Run '${args.runId}' step '${args.nodeId}:${args.occurrence}' completed with a different replay output`,
    );
    this.name = "RuntimeStepReplayConflictError";
  }
}

export class RuntimeReplayTooLargeError extends Error {
  constructor(args: { runId: string; bytes: number; limit: number }) {
    super(
      `Run '${args.runId}' replay state is ${args.bytes} bytes, over the ${args.limit} byte limit`,
    );
    this.name = "RuntimeReplayTooLargeError";
  }
}

export class RuntimeStepPayloadTooLargeError extends Error {
  constructor(args: {
    runId: string;
    nodeId: string;
    occurrence: number;
    bytes: number;
    limit: number;
  }) {
    super(
      `Run '${args.runId}' step '${args.nodeId}:${args.occurrence}' payload is ${args.bytes} bytes, over the ${args.limit} byte limit`,
    );
    this.name = "RuntimeStepPayloadTooLargeError";
  }
}

/**
 * Ceiling on a single step's persisted input or output.
 *
 * Postgres would otherwise accept payloads up to its 1GB field limit, and the
 * failure mode there is an aborted transaction rather than a legible error
 * against the offending step. A step's output is also replayed into every
 * later resume, so oversized values compound.
 */
const MAX_STEP_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Ceiling on the full replay ledger shipped into the sandbox on resume. */
const MAX_REPLAY_BYTES = 32 * 1024 * 1024;

export interface RuntimeEventIngestionResult {
  accepted: number;
  duplicates: number;
}

export class RuntimeEventsService {
  constructor(private readonly db: Kysely<DB>) {}

  sink(args: { tenantId: string; runId: string }): RuntimeInvocationEventSink {
    return {
      report: async ({ invocationId, events }) => {
        try {
          await this.ingest({
            tenantId: args.tenantId,
            runId: args.runId,
            invocationId,
            events,
          });
        } catch (error) {
          throw new RuntimeEventReportingError({
            invocationId,
            cause: error,
          });
        }
      },
    };
  }

  async ingest(args: {
    tenantId: string;
    runId: string;
    invocationId?: string;
    events: readonly RuntimeInvocationEvent[];
  }): Promise<RuntimeEventIngestionResult> {
    if (args.events.length === 0) return { accepted: 0, duplicates: 0 };
    return withSpan(
      {
        tracer,
        name: "runtime.events.ingest",
        attributes: {
          "catamorphic.tenant.id": args.tenantId,
          "catamorphic.run.id": args.runId,
          "catamorphic.runtime.event_count": args.events.length,
        },
      },
      () =>
        this.db.transaction().execute(async (trx) => {
          await requireRun({
            trx,
            tenantId: args.tenantId,
            runId: args.runId,
          });
          return ingestEvents({
            trx,
            runId: args.runId,
            invocationId: args.invocationId,
            events: [...args.events].sort(
              (left, right) => left.sequence - right.sequence,
            ),
          });
        }),
    );
  }

  /**
   * Builds the completed-step ledger a resuming invocation replays against.
   *
   * The whole ledger is serialized and shipped into the sandbox on every
   * resume, so its cost grows with everything the run has already done — a
   * workflow that loops thousands of times re-uploads every prior output each
   * time it restarts. The cap turns that from a silent memory and bandwidth
   * cliff into an explicit failure naming the run.
   */
  async replay(args: {
    tenantId: string;
    runId: string;
  }): Promise<Record<string, unknown>> {
    await requireRun({
      trx: this.db,
      tenantId: args.tenantId,
      runId: args.runId,
    });
    const rows = await this.db
      .selectFrom("workflow_run_steps")
      .where("run_id", "=", args.runId)
      .where("status", "=", "completed")
      .select(["node_id", "occurrence", "output"])
      .orderBy("occurrence", "asc")
      .execute();
    const replay = Object.fromEntries(
      rows.map((row) => [
        replayKey({ nodeId: row.node_id, occurrence: row.occurrence }),
        row.output,
      ]),
    );
    const bytes = jsonByteLength(replay);
    if (bytes > MAX_REPLAY_BYTES) {
      throw new RuntimeReplayTooLargeError({
        runId: args.runId,
        bytes,
        limit: MAX_REPLAY_BYTES,
      });
    }
    return replay;
  }
}

async function ingestEvents(args: {
  trx: Transaction<DB>;
  runId: string;
  invocationId?: string;
  events: readonly RuntimeInvocationEvent[];
}): Promise<RuntimeEventIngestionResult> {
  const counts = { accepted: 0, duplicates: 0 };
  if (args.events.length === 0) return counts;

  // Each event is paired with its own serialized payload. A batch may
  // interleave events from several invocations (and can even repeat an
  // (invocation, sequence) pair), so a lookup keyed on sequence alone would
  // attach one event's payload to another's row.
  const entries = args.events.map((event) => {
    validateEvent(event);
    if (args.invocationId && event.invocationId !== args.invocationId) {
      throw new Error(
        `Runtime event invocation '${event.invocationId}' does not match '${args.invocationId}'`,
      );
    }
    return { event, payload: toJson(event) };
  });

  // One insert for the whole batch rather than one per event. Events arrive in
  // groups, and each statement is a round trip held inside this transaction.
  // ON CONFLICT DO NOTHING also swallows conflicts between rows of this same
  // statement, so an intra-batch duplicate keeps the first row and the second
  // falls through to the duplicate check below.
  const inserted = await args.trx
    .insertInto("workflow_run_events")
    .values(
      entries.map(({ event, payload }) => ({
        run_id: args.runId,
        invocation_id: event.invocationId,
        sequence: event.sequence,
        attempt: event.attempt,
        type: event.type,
        payload: jsonbColumn(payload),
        created_at: new Date(event.timestamp),
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(["invocation_id", "sequence"]).doNothing(),
    )
    .returning(["invocation_id", "sequence"])
    .execute();
  const accepted = new Set(
    inserted.map((row) => `${row.invocation_id} ${row.sequence}`),
  );

  for (const { event, payload } of entries) {
    const key = `${event.invocationId} ${event.sequence}`;
    if (!accepted.has(key)) {
      await assertDuplicateMatches({
        trx: args.trx,
        runId: args.runId,
        event,
        payload,
      });
      counts.duplicates += 1;
      continue;
    }
    // The insert accepted exactly one row per key; a repeat inside this batch
    // must be validated as a duplicate, not applied twice.
    accepted.delete(key);
    counts.accepted += 1;
    await applyEvent({ trx: args.trx, runId: args.runId, event });
  }
  return counts;
}

async function applyEvent(args: {
  trx: Transaction<DB>;
  runId: string;
  event: RuntimeInvocationEvent;
}): Promise<void> {
  const timestamp = new Date(args.event.timestamp);
  if (args.event.type === "started") return;
  if (args.event.type === "step_started") {
    await insertStartedStep({
      trx: args.trx,
      runId: args.runId,
      event: args.event,
      timestamp,
    });
    return;
  }
  if (
    args.event.type === "step_completed" ||
    args.event.type === "step_failed"
  ) {
    await upsertTerminalStep({
      trx: args.trx,
      runId: args.runId,
      event: args.event,
      timestamp,
    });
    return;
  }
  // RunsService owns the plain invocation's top-level lifecycle. Events only
  // persist replayable graph progress.
}

async function insertStartedStep(args: {
  trx: Transaction<DB>;
  runId: string;
  event: Extract<RuntimeInvocationEvent, { type: "step_started" }>;
  timestamp: Date;
}): Promise<void> {
  const input = toJson(args.event.input);
  assertStepPayloadSize({
    runId: args.runId,
    nodeId: args.event.nodeId,
    occurrence: args.event.occurrence,
    value: input,
  });
  const inserted = await args.trx
    .insertInto("workflow_run_steps")
    .values({
      id: crypto.randomUUID(),
      run_id: args.runId,
      node_id: args.event.nodeId,
      occurrence: args.event.occurrence,
      name: args.event.name,
      status: "running",
      input: jsonbColumn(input),
      attempt: args.event.attempt,
      started_at: args.timestamp,
    })
    .onConflict((conflict) =>
      conflict.columns(["run_id", "node_id", "occurrence"]).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  // A fresh insert already holds these values; only a retry landing on an
  // existing row needs them refreshed.
  if (inserted) return;
  await args.trx
    .updateTable("workflow_run_steps")
    .set({
      name: args.event.name,
      input: jsonbColumn(input),
      attempt: args.event.attempt,
      started_at: args.timestamp,
    })
    .where("run_id", "=", args.runId)
    .where("node_id", "=", args.event.nodeId)
    .where("occurrence", "=", args.event.occurrence)
    .where("status", "in", ["pending", "running"])
    .execute();
}

async function upsertTerminalStep(args: {
  trx: Transaction<DB>;
  runId: string;
  event: Extract<
    RuntimeInvocationEvent,
    { type: "step_completed" | "step_failed" }
  >;
  timestamp: Date;
}): Promise<void> {
  const status = args.event.type === "step_completed" ? "completed" : "failed";
  const output =
    args.event.type === "step_completed" ? toJson(args.event.output) : null;
  const error = args.event.type === "step_failed" ? args.event.error : null;
  assertStepPayloadSize({
    runId: args.runId,
    nodeId: args.event.nodeId,
    occurrence: args.event.occurrence,
    value: output,
  });
  const inserted = await args.trx
    .insertInto("workflow_run_steps")
    .values({
      id: crypto.randomUUID(),
      run_id: args.runId,
      node_id: args.event.nodeId,
      occurrence: args.event.occurrence,
      name: args.event.name,
      status,
      output: jsonbColumn(output),
      error,
      attempt: args.event.attempt,
      started_at: args.timestamp,
      completed_at: args.timestamp,
    })
    .onConflict((conflict) =>
      conflict.columns(["run_id", "node_id", "occurrence"]).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  // Nothing preceded a winning insert, so there is no prior row to reconcile
  // against and no replay conflict to check.
  if (inserted) return;
  if (args.event.type === "step_failed") {
    await args.trx
      .updateTable("workflow_run_steps")
      .set({
        name: args.event.name,
        status,
        error,
        attempt: args.event.attempt,
        completed_at: args.timestamp,
      })
      .where("run_id", "=", args.runId)
      .where("node_id", "=", args.event.nodeId)
      .where("occurrence", "=", args.event.occurrence)
      .where("status", "!=", "completed")
      .execute();
    return;
  }
  const existing = await args.trx
    .selectFrom("workflow_run_steps")
    .where("run_id", "=", args.runId)
    .where("node_id", "=", args.event.nodeId)
    .where("occurrence", "=", args.event.occurrence)
    .select(["status", "output"])
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    existing.status === "completed" &&
    stableJson(existing.output) !== stableJson(output)
  ) {
    throw new RuntimeStepReplayConflictError({
      runId: args.runId,
      nodeId: args.event.nodeId,
      occurrence: args.event.occurrence,
    });
  }
  await args.trx
    .updateTable("workflow_run_steps")
    .set({
      name: args.event.name,
      status,
      output: jsonbColumn(output),
      error,
      attempt: args.event.attempt,
      completed_at: args.timestamp,
    })
    .where("run_id", "=", args.runId)
    .where("node_id", "=", args.event.nodeId)
    .where("occurrence", "=", args.event.occurrence)
    .execute();
}

async function assertDuplicateMatches(args: {
  trx: Transaction<DB>;
  runId: string;
  event: RuntimeInvocationEvent;
  payload: Json;
}): Promise<void> {
  const existing = await args.trx
    .selectFrom("workflow_run_events")
    .where("invocation_id", "=", args.event.invocationId)
    .where("sequence", "=", args.event.sequence)
    .select(["run_id", "type", "attempt", "payload"])
    .executeTakeFirstOrThrow();
  if (
    existing.run_id !== args.runId ||
    existing.type !== args.event.type ||
    existing.attempt !== args.event.attempt ||
    stableJson(existing.payload) !== stableJson(args.payload)
  ) {
    throw new RuntimeEventSequenceConflictError({
      invocationId: args.event.invocationId,
      sequence: args.event.sequence,
    });
  }
}

async function requireRun(args: {
  trx: Pick<Kysely<DB>, "selectFrom">;
  tenantId: string;
  runId: string;
}): Promise<void> {
  const run = await args.trx
    .selectFrom("workflow_runs")
    .innerJoin("projects", "projects.id", "workflow_runs.project_id")
    .where("workflow_runs.id", "=", args.runId)
    .where("projects.tenant_id", "=", args.tenantId)
    .leftJoin(
      "workflow_run_states",
      "workflow_run_states.run_id",
      "workflow_runs.id",
    )
    .select([
      "workflow_runs.id",
      "workflow_run_states.run_id as execution_state_run_id",
    ])
    .executeTakeFirst();
  if (!run) throw new RuntimeEventRunNotFoundError(args.runId);
  if (run.execution_state_run_id) {
    throw new Error("Runtime event application supports plain functions only");
  }
}

function replayKey(args: { nodeId: string; occurrence: number }): string {
  return `${args.nodeId}:${args.occurrence}`;
}

function assertStepPayloadSize(args: {
  runId: string;
  nodeId: string;
  occurrence: number;
  value: Json;
}): void {
  if (args.value === null) return;
  const bytes = jsonByteLength(args.value);
  if (bytes <= MAX_STEP_PAYLOAD_BYTES) return;
  throw new RuntimeStepPayloadTooLargeError({
    runId: args.runId,
    nodeId: args.nodeId,
    occurrence: args.occurrence,
    bytes,
    limit: MAX_STEP_PAYLOAD_BYTES,
  });
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateEvent(event: RuntimeInvocationEvent): void {
  if (
    event.invocationId === "" ||
    !Number.isInteger(event.sequence) ||
    event.sequence < 1 ||
    !Number.isInteger(event.attempt) ||
    event.attempt < 1 ||
    Number.isNaN(Date.parse(event.timestamp))
  ) {
    throw new Error("Runtime event has invalid identity or timestamp");
  }
}

/**
 * jsonb parameters must be sent as JSON text: node-postgres serializes JS
 * arrays as Postgres array literals, so a bare-array value (a step returning
 * an array) fails with "invalid input syntax for type json".
 */
function jsonbColumn(value: Json) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

function toJson(value: unknown): Json {
  return toJsonValue({ value, seen: new WeakSet<object>() });
}

function toJsonValue(args: {
  value: unknown;
  seen: WeakSet<object>;
}): JsonValue {
  if (
    args.value === null ||
    typeof args.value === "string" ||
    typeof args.value === "boolean"
  ) {
    return args.value;
  }
  if (typeof args.value === "number") {
    return Number.isFinite(args.value) ? args.value : String(args.value);
  }
  if (typeof args.value === "bigint") return args.value.toString();
  if (typeof args.value === "undefined") return null;
  if (args.value instanceof Error) {
    return {
      name: args.value.name,
      message: args.value.message,
      stack: args.value.stack ?? null,
    };
  }
  if (typeof args.value !== "object") return String(args.value);
  if (args.seen.has(args.value)) return "[Circular]";
  args.seen.add(args.value);
  if (Array.isArray(args.value)) {
    const result = args.value.map((entry) =>
      toJsonValue({ value: entry, seen: args.seen }),
    );
    args.seen.delete(args.value);
    return result;
  }
  const result: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(args.value)) {
    result[key] = toJsonValue({ value: entry, seen: args.seen });
  }
  args.seen.delete(args.value);
  return result;
}

function stableJson(value: Json | null): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: Json | null): Json {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
