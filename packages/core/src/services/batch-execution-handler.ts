import type { DB, Json } from "@catamorphic/db";
import { getTracer, type SpanAttributes, withSpan } from "@catamorphic/otel";
import type {
  RuntimeBatchStepSuspension,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Identity } from "../identity.js";
import type {
  ExecutionJob,
  ExecutionJobsService,
} from "./execution-jobs-service.js";
import {
  ExecutionJobDeferredError,
  type ExecutionWorkerService,
} from "./execution-worker-service.js";
import type {
  RateLimit,
  RateReservationsService,
} from "./rate-reservations-service.js";
import {
  jsonColumn,
  jsonRecord,
  type RunCoordinator,
  RuntimeInvocationFencedError,
  stringValue,
  toJson,
} from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");
const MAX_BATCH_ITEM_ATTEMPTS = 5;
const SOURCE_PAGE_SIZE = 250;
const SOURCE_HIGH_WATER_MARK = 100;
const SOURCE_LOW_WATER_MARK = 50;
const SINK_CHUNK_SIZE = 100;
/** Backstop only: `resume` wakes parked jobs explicitly. */
const PAUSED_RUN_PARK_MS = 60 * 60 * 1_000;

interface BatchContext {
  identity: Identity;
  runId: string;
  workflowStepAttemptId: string;
  projectId: string;
  workflowName: string;
  commitSha: string;
  artifactId: string;
  modulePath: string;
  exportName: string;
  stepIndex: number;
  workflowInput: Json | null;
  status: string;
  phase: string;
  executionPlan: Json;
}

interface BatchOutcome {
  key: string;
  status: "succeeded" | "failed" | "skipped";
  result?: Json;
  error?: string;
  retryable?: boolean;
}

export class BatchExecutionHandler {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      coordinator: RunCoordinator;
      jobs: ExecutionJobsService;
      rateReservations: RateReservationsService;
      worker: ExecutionWorkerService;
      invokeRuntime(args: {
        identity: Identity;
        projectId: string;
        workflowName: string;
        commitSha: string;
        artifactId: string;
        invocationId: string;
        kind: RuntimeInvocation["kind"];
        operation?: string;
        exportName?: string;
        modulePath?: string;
        stepIndex?: number;
        input: unknown;
        attempt: number;
        timeoutSeconds?: number;
        signal?: AbortSignal;
      }): Promise<RuntimeInvocationReceipt>;
    },
  ) {
    deps.worker.registerHandler({
      kind: "batch_source",
      handler: ({ job, signal }) => this.executeSource({ job, signal }),
    });
    deps.worker.registerHandler({
      kind: "batch_item",
      handler: ({ job, signal }) => this.executeItem({ job, signal }),
    });
    deps.worker.registerHandler({
      kind: "batch_step",
      handler: ({ job, signal }) => this.executePhysicalStep({ job, signal }),
    });
    deps.worker.registerHandler({
      kind: "batch_sink",
      handler: ({ job, signal }) => this.executeSink({ job, signal }),
    });
  }

  private async executeSource(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const operation = stringValue(jsonRecord(args.job.payload).operation);
    if (!operation) throw new Error("Batch source job operation is missing");
    const context = await this.loadContext(args.job);
    if (!context || !this.assertRunnable(context)) return;
    const invocationId = `${args.job.id}:${operation === "initialize" ? "initialize" : "read-page"}:attempt:${args.job.attempt}`;

    await withSpan(
      {
        tracer,
        name: "batch.source.execute",
        attributes: {
          ...batchAttributes(context),
          "catamorphic.source.operation": operation,
          "catamorphic.invocation.id": invocationId,
        },
      },
      async () => {
        if (operation === "initialize") {
          if (
            !(await this.deps.coordinator.beginAttempt({
              job: args.job,
              phase: "source",
            }))
          ) {
            return;
          }
          const existing = await this.db
            .selectFrom("batch_execution_states")
            .where("run_id", "=", context.runId)
            .where(
              "workflow_step_attempt_id",
              "=",
              context.workflowStepAttemptId,
            )
            .select([
              "source_snapshot",
              "source_snapshot_present",
              "source_cursor",
              "source_cursor_present",
            ])
            .executeTakeFirstOrThrow();
          if (existing.source_snapshot_present) {
            await this.readSourcePage({
              context,
              job: args.job,
              snapshot: existing.source_snapshot,
              cursor: existing.source_cursor,
              cursorPresent: existing.source_cursor_present,
              signal: args.signal,
            });
            return;
          }
          const receipt = await this.invoke({
            context,
            job: args.job,
            invocationId,
            kind: "batch-source",
            operation: "initialize",
            input: { workflowInput: context.workflowInput ?? {} },
            signal: args.signal,
          });
          const initialized = parseSourceInitialization(receipt);
          await this.db
            .updateTable("batch_execution_states")
            .set({
              source_snapshot: jsonColumn(initialized.snapshot),
              source_snapshot_present: true,
              source_cursor: initialized.cursorPresent
                ? jsonColumn(initialized.cursor)
                : null,
              source_cursor_present: initialized.cursorPresent,
              source_consistency: initialized.consistency,
              estimated_count: initialized.estimatedCount ?? null,
              source_page_queued: false,
              updated_at: new Date(),
            })
            .where("run_id", "=", context.runId)
            .where(
              "workflow_step_attempt_id",
              "=",
              context.workflowStepAttemptId,
            )
            .execute();
          await this.readSourcePage({
            context,
            job: args.job,
            snapshot: initialized.snapshot,
            cursor: initialized.cursor,
            cursorPresent: initialized.cursorPresent,
            signal: args.signal,
          });
          return;
        }
        if (operation !== "read_page") {
          throw new Error(`Unknown batch source operation '${operation}'`);
        }
        const state = await this.db
          .selectFrom("batch_execution_states")
          .where("run_id", "=", context.runId)
          .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
          .select([
            "source_snapshot",
            "source_snapshot_present",
            "source_cursor",
            "source_cursor_present",
          ])
          .executeTakeFirstOrThrow();
        if (!state.source_snapshot_present) {
          throw new Error("Batch source has no persisted snapshot");
        }
        await this.readSourcePage({
          context,
          job: args.job,
          snapshot: state.source_snapshot,
          cursor: state.source_cursor,
          cursorPresent: state.source_cursor_present,
          signal: args.signal,
        });
      },
    );
  }

  private async readSourcePage(args: {
    context: BatchContext;
    job: ExecutionJob;
    snapshot: Json;
    cursor: Json | null;
    cursorPresent: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    const receipt = await this.invoke({
      context: args.context,
      job: args.job,
      invocationId: `${args.job.id}:read-page:attempt:${args.job.attempt}`,
      kind: "batch-source",
      operation: "readPage",
      input: {
        workflowInput: args.context.workflowInput ?? {},
        snapshot: args.snapshot,
        ...(args.cursorPresent ? { cursor: args.cursor } : {}),
        limit: SOURCE_PAGE_SIZE,
      },
      signal: args.signal,
    });
    const page = parseSourcePage(receipt);
    await this.acceptSourcePage({ context: args.context, page });
  }

  private async acceptSourcePage(args: {
    context: BatchContext;
    page: {
      items: Array<{ key: string; value: Json }>;
      nextCursor: Json | null;
      nextCursorPresent: boolean;
      done: boolean;
    };
  }): Promise<void> {
    if (!args.page.done && !args.page.nextCursorPresent) {
      throw new Error("A non-terminal source page must include nextCursor");
    }
    await this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom("batch_execution_states")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .select(["discovered_count"])
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pageItems = uniqueSourceItems(args.page.items);
      const existing =
        pageItems.length === 0
          ? []
          : await trx
              .selectFrom("batch_items")
              .where("run_id", "=", args.context.runId)
              .where(
                "workflow_step_attempt_id",
                "=",
                args.context.workflowStepAttemptId,
              )
              .where(
                "item_key",
                "in",
                pageItems.map((item) => item.key),
              )
              .select("item_key")
              .execute();
      const existingKeys = new Set(existing.map((item) => item.item_key));
      const newItems = pageItems.filter((item) => !existingKeys.has(item.key));
      const inserted =
        newItems.length === 0
          ? []
          : await trx
              .insertInto("batch_items")
              .values(
                newItems.map((item, index) => ({
                  run_id: args.context.runId,
                  workflow_step_attempt_id: args.context.workflowStepAttemptId,
                  item_key: item.key,
                  source_order: Number(state.discovered_count) + index,
                  value: jsonColumn(item.value),
                })),
              )
              .onConflict((conflict) =>
                conflict
                  .columns(["run_id", "workflow_step_attempt_id", "item_key"])
                  .doNothing(),
              )
              .returning(["id"])
              .execute();
      // A page carries up to SOURCE_PAGE_LIMIT items; enqueueing them one at a
      // time made page acceptance cost a round trip per item.
      await this.deps.jobs.enqueueMany({
        trx,
        jobs: inserted.map((item) => ({
          tenantId: args.context.identity.tenantId,
          workflowRunId: args.context.runId,
          workflowStepAttemptId: args.context.workflowStepAttemptId,
          kind: "batch_item" as const,
          payload: { itemId: item.id, itemAttempt: 1 },
          maxAttempts: MAX_BATCH_ITEM_ATTEMPTS,
          dedupeKey: scopeKey(args.context, `item:${item.id}:source`),
        })),
      });
      const backlog = await trx
        .selectFrom("batch_items")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .where("status", "in", ["pending", "running", "waiting"])
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      const queueNext =
        !args.page.done && Number(backlog.count) < SOURCE_HIGH_WATER_MARK;
      await trx
        .updateTable("batch_execution_states")
        .set((eb) => ({
          source_cursor: args.page.nextCursorPresent
            ? jsonColumn(args.page.nextCursor)
            : null,
          source_cursor_present: args.page.nextCursorPresent,
          source_done: args.page.done,
          source_page_queued: queueNext,
          discovered_count: eb(
            "discovered_count",
            "+",
            String(inserted.length),
          ),
          updated_at: new Date(),
        }))
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .execute();
      if (queueNext) {
        await this.enqueueSourcePage({
          trx,
          context: args.context,
          cursor: args.page.nextCursor,
          cursorPresent: args.page.nextCursorPresent,
        });
      }
    });
    await this.deps.coordinator.setPhase({
      runId: args.context.runId,
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      phase: "process",
    });
    if (args.page.done) await this.finalizeIfComplete(args.context);
  }

  private async executeItem(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const payload = jsonRecord(args.job.payload);
    const itemId = requireString(payload.itemId, "itemId");
    const baseAttempt = requirePositiveInteger(
      payload.itemAttempt,
      "itemAttempt",
    );
    const context = await this.loadContext(args.job);
    if (!context || !this.assertRunnable(context)) return;
    const item = await this.db
      .selectFrom("batch_items")
      .where("id", "=", itemId)
      .where("run_id", "=", context.runId)
      .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
      .selectAll()
      .executeTakeFirst();
    if (!item || isTerminalItem(item.status)) return;
    const itemAttempt = Math.max(baseAttempt, item.attempt || 1);
    await this.deps.coordinator.setPhase({
      runId: context.runId,
      workflowStepAttemptId: context.workflowStepAttemptId,
      phase: "process",
    });
    await this.db
      .updateTable("batch_items")
      .set({ status: "running", attempt: itemAttempt, updated_at: new Date() })
      .where("id", "=", itemId)
      .where("status", "in", ["pending", "waiting", "running"])
      .execute();
    const receipt = await this.invoke({
      context,
      job: args.job,
      invocationId: `${args.job.id}:process:attempt:${args.job.attempt}`,
      kind: "batch-step",
      operation: "process",
      input: {
        key: item.item_key,
        item: item.value,
        replay: await this.loadReplay({ context, itemId }),
      },
      attempt: itemAttempt,
      signal: args.signal,
    });
    await this.persistRuntimeSteps({
      context,
      itemId,
      attempt: itemAttempt,
      steps: receipt.terminal.steps,
    });
    if (receipt.terminal.status === "completed") {
      await this.completeItem({
        context,
        job: args.job,
        itemId,
        status: "succeeded",
        output: requireJson(receipt.terminal.result),
      });
      return;
    }
    if (receipt.terminal.status === "suspended") {
      await this.parkAtPhysicalStep({
        context,
        item: { id: item.id, key: item.item_key, attempt: itemAttempt },
        suspension: receipt.terminal.suspension,
      });
      return;
    }
    if (receipt.terminal.status === "skipped") {
      await this.completeItem({
        context,
        job: args.job,
        itemId,
        status: "skipped",
        error: receipt.terminal.reason,
      });
      return;
    }
    const error = receipt.terminal.error;
    if (args.job.attempt >= args.job.maxAttempts) {
      await this.completeItem({
        context,
        job: args.job,
        itemId,
        status: "failed",
        error,
      });
      return;
    }
    await this.db
      .updateTable("batch_items")
      .set({
        status: "pending",
        attempt: itemAttempt + 1,
        error,
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    throw new Error(error);
  }

  private async parkAtPhysicalStep(args: {
    context: BatchContext;
    item: { id: string; key: string; attempt: number };
    suspension: RuntimeBatchStepSuspension;
  }): Promise<void> {
    const compatibilityKey = await sha256(
      JSON.stringify({
        artifactId: args.context.artifactId,
        runId: args.context.runId,
        workflowStepAttemptId: args.context.workflowStepAttemptId,
        nodeId: args.suspension.nodeId,
        occurrence: args.suspension.occurrence,
        functionName: args.suspension.functionName,
        partition: args.suspension.partition ?? null,
      }),
    );
    const closesAt = new Date(Date.now() + args.suspension.policy.maxWaitMs);
    const inputBytes = jsonByteLength(args.suspension.input);
    const invocation = await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${compatibilityKey}, 0))`.execute(
        trx,
      );
      const candidate = await findCompatibleInvocation({
        trx,
        context: args.context,
        nodeId: args.suspension.nodeId,
        functionName: args.suspension.functionName,
        compatibilityKey,
        maxItems: args.suspension.policy.maxItems,
        maxBytes: args.suspension.policy.maxBytes,
        inputBytes,
      });
      const physical =
        candidate ??
        (await trx
          .insertInto("batch_step_invocations")
          .values({
            run_id: args.context.runId,
            workflow_step_attempt_id: args.context.workflowStepAttemptId,
            node_id: args.suspension.nodeId,
            function_name: args.suspension.functionName,
            compatibility_key: compatibilityKey,
            policy: batchPolicyJson(args.suspension.policy),
            closes_at: closesAt,
          })
          .returning(["id", "closes_at"])
          .executeTakeFirstOrThrow());
      const admitted = await trx
        .insertInto("batch_step_members")
        .values({
          run_id: args.context.runId,
          workflow_step_attempt_id: args.context.workflowStepAttemptId,
          invocation_id: physical.id,
          item_id: args.item.id,
          member_key: args.item.key,
          input: jsonColumn(requireJson(args.suspension.input)),
          input_present: true,
          occurrence: args.suspension.occurrence,
        })
        .onConflict((conflict) =>
          conflict
            .columns([
              "run_id",
              "workflow_step_attempt_id",
              "invocation_id",
              "item_id",
            ])
            .doNothing(),
        )
        .returning("item_id")
        .executeTakeFirst();
      // The counters make admission O(1): capacity is read off the invocation
      // row instead of re-summing every member under the advisory lock, which
      // cost O(members) per admission and O(members²) per coalescing window.
      // Only a winning insert counts — a redelivered job must not double-add.
      if (admitted) {
        await trx
          .updateTable("batch_step_invocations")
          .set((eb) => ({
            member_count: eb("member_count", "+", 1),
            member_bytes: eb("member_bytes", "+", String(inputBytes)),
            updated_at: new Date(),
          }))
          .where("id", "=", physical.id)
          .execute();
      }
      await trx
        .insertInto("batch_item_steps")
        .values({
          run_id: args.context.runId,
          workflow_step_attempt_id: args.context.workflowStepAttemptId,
          item_id: args.item.id,
          node_id: args.suspension.nodeId,
          occurrence: args.suspension.occurrence,
          attempt: args.item.attempt,
          name: args.suspension.name,
          status: "waiting",
          input: jsonColumn(requireJson(args.suspension.input)),
          input_present: true,
        })
        .onConflict((conflict) =>
          conflict
            .columns([
              "run_id",
              "workflow_step_attempt_id",
              "item_id",
              "node_id",
              "occurrence",
              "attempt",
            ])
            .doUpdateSet({
              status: "waiting",
              input: jsonColumn(requireJson(args.suspension.input)),
              input_present: true,
            }),
        )
        .execute();
      await trx
        .updateTable("batch_items")
        .set({
          status: "waiting",
          current_node_id: args.suspension.nodeId,
          updated_at: new Date(),
        })
        .where("id", "=", args.item.id)
        .execute();
      const counters = await trx
        .selectFrom("batch_step_invocations")
        .where("id", "=", physical.id)
        .select("member_count")
        .executeTakeFirstOrThrow();
      return {
        id: physical.id,
        closesAt: physical.closes_at,
        full: Number(counters.member_count) >= args.suspension.policy.maxItems,
      };
    });
    const dedupeKey = scopeKey(args.context, `physical:${invocation.id}`);
    await this.deps.jobs.enqueue({
      tenantId: args.context.identity.tenantId,
      workflowRunId: args.context.runId,
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      kind: "batch_step",
      payload: { invocationId: invocation.id },
      availableAt: invocation.full ? new Date() : invocation.closesAt,
      dedupeKey,
    });
    if (invocation.full) {
      await this.deps.jobs.makeAvailable({
        tenantId: args.context.identity.tenantId,
        dedupeKey,
      });
    }
  }

  private async executePhysicalStep(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const invocationId = requireString(
      jsonRecord(args.job.payload).invocationId,
      "invocationId",
    );
    const context = await this.loadContext(args.job);
    if (!context || !this.assertRunnable(context)) return;
    const invocation = await this.db
      .selectFrom("batch_step_invocations")
      .where("id", "=", invocationId)
      .where("run_id", "=", context.runId)
      .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
      .selectAll()
      .executeTakeFirst();
    if (!invocation || ["completed", "canceled"].includes(invocation.status)) {
      return;
    }
    const members = await this.db
      .selectFrom("batch_step_members")
      .innerJoin("batch_items", (join) =>
        join
          .onRef("batch_items.id", "=", "batch_step_members.item_id")
          .onRef("batch_items.run_id", "=", "batch_step_members.run_id")
          .onRef(
            "batch_items.workflow_step_attempt_id",
            "=",
            "batch_step_members.workflow_step_attempt_id",
          ),
      )
      .where("batch_step_members.run_id", "=", context.runId)
      .where(
        "batch_step_members.workflow_step_attempt_id",
        "=",
        context.workflowStepAttemptId,
      )
      .where("batch_step_members.invocation_id", "=", invocationId)
      .where("batch_step_members.status", "=", "pending")
      .select([
        "batch_step_members.item_id",
        "batch_step_members.member_key",
        "batch_step_members.input",
        "batch_step_members.occurrence",
        "batch_items.attempt as item_attempt",
      ])
      .orderBy("batch_step_members.member_key")
      .execute();
    if (members.length === 0) return;
    const limits = readRateLimits({
      policy: invocation.policy,
      itemCount: members.length,
    });
    if (limits.length > 0) {
      const reservation = await this.deps.rateReservations.reserve({
        tenantId: context.identity.tenantId,
        limits,
      });
      if (!reservation.reserved) {
        throw new ExecutionJobDeferredError(reservation.retryAt);
      }
    }
    await this.db
      .updateTable("batch_step_invocations")
      .set({
        status: "running",
        attempt: args.job.attempt,
        started_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", invocationId)
      .execute();
    try {
      const target = physicalTarget({
        executionPlan: context.executionPlan,
        nodeId: invocation.node_id,
        functionName: invocation.function_name,
      });
      const receipt = await this.invoke({
        context,
        job: args.job,
        invocationId: `${args.job.id}:batch:attempt:${args.job.attempt}`,
        kind: "batch-step",
        operation: "run",
        modulePath: target.modulePath,
        exportName: target.exportName,
        stepIndex: undefined,
        input: {
          items: members.map((member) => ({
            key: member.member_key,
            value: member.input,
            attempt: member.item_attempt,
          })),
        },
        signal: args.signal,
      });
      if (receipt.terminal.status !== "completed") {
        throw new Error(
          receipt.terminal.status === "suspended"
            ? "A physical batch step suspended recursively"
            : receipt.terminal.status === "skipped"
              ? `A physical batch step skipped: ${receipt.terminal.reason}`
              : receipt.terminal.error,
        );
      }
      await this.persistPhysicalOutcomes({
        context,
        job: args.job,
        invocation,
        members,
        outcomes: parseBatchOutcomes({
          value: receipt.terminal.result,
          expectedKeys: members.map((member) => member.member_key),
        }),
      });
    } catch (error) {
      if (error instanceof RuntimeInvocationFencedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = args.job.attempt >= args.job.maxAttempts;
      await this.db
        .updateTable("batch_step_invocations")
        .set({
          status: exhausted ? "failed" : "pending",
          error: message,
          completed_at: exhausted ? new Date() : null,
          updated_at: new Date(),
        })
        .where("id", "=", invocationId)
        .execute();
      throw error;
    }
  }

  private async persistPhysicalOutcomes(args: {
    context: BatchContext;
    job: ExecutionJob;
    invocation: { id: string; node_id: string };
    members: readonly {
      item_id: string;
      member_key: string;
      input: Json | null;
      occurrence: number;
      item_attempt: number;
    }[];
    outcomes: readonly BatchOutcome[];
  }): Promise<void> {
    const byKey = new Map(
      args.outcomes.map((outcome) => [outcome.key, outcome]),
    );
    const terminal: Array<{
      itemId: string;
      status: "failed" | "skipped";
      error?: string;
    }> = [];
    // Resolved up front so the writes below can be grouped by shape instead of
    // interleaved per member. A physical step coalesces many items into one
    // invocation, so this loop ran 3-4 statements per member serially.
    const resolved = args.members.map((member) => {
      const outcome = byKey.get(member.member_key);
      if (!outcome) throw new Error(`Missing outcome '${member.member_key}'`);
      const retry =
        outcome.status === "failed" &&
        outcome.retryable === true &&
        member.item_attempt < MAX_BATCH_ITEM_ATTEMPTS;
      return {
        member,
        outcome,
        retry,
        nextAttempt: retry ? member.item_attempt + 1 : member.item_attempt,
        resumes: outcome.status === "succeeded" || retry,
      };
    });

    await this.db.transaction().execute(async (trx) => {
      const now = new Date();
      // One UPDATE ... FROM (VALUES ...) per table rather than one per member.
      // The join carries each member's own outcome, so distinct values still
      // land on distinct rows.
      await trx
        .updateTable("batch_step_members")
        .from(
          memberOutcomeValues(
            resolved.map((entry) => ({
              itemId: entry.member.item_id,
              status: entry.retry ? "unresolved" : entry.outcome.status,
              output: entry.outcome.result,
              error: entry.outcome.error ?? null,
            })),
          ),
        )
        .set((eb) => ({
          status: eb.ref("outcome.status"),
          output: eb.ref("outcome.output"),
          output_present: eb.ref("outcome.output_present"),
          error: eb.ref("outcome.error"),
          completed_at: now,
        }))
        .whereRef("batch_step_members.item_id", "=", "outcome.item_id")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .where("invocation_id", "=", args.invocation.id)
        .execute();

      await trx
        .updateTable("batch_item_steps")
        .from(
          memberOutcomeValues(
            resolved.map((entry) => ({
              itemId: entry.member.item_id,
              status:
                entry.outcome.status === "succeeded"
                  ? "completed"
                  : entry.outcome.status,
              output: entry.outcome.result,
              error: entry.outcome.error ?? null,
              occurrence: entry.member.occurrence,
              attempt: entry.member.item_attempt,
            })),
          ),
        )
        .set((eb) => ({
          status: eb.ref("outcome.status"),
          output: eb.ref("outcome.output"),
          output_present: eb.ref("outcome.output_present"),
          error: eb.ref("outcome.error"),
          completed_at: now,
          updated_at: now,
        }))
        .whereRef("batch_item_steps.item_id", "=", "outcome.item_id")
        .whereRef("batch_item_steps.occurrence", "=", "outcome.occurrence")
        .whereRef("batch_item_steps.attempt", "=", "outcome.attempt")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .where("node_id", "=", args.invocation.node_id)
        .execute();

      const resuming = resolved.filter((entry) => entry.resumes);
      if (resuming.length > 0) {
        await trx
          .updateTable("batch_items")
          .from(
            itemAttemptValues(
              resuming.map((entry) => ({
                itemId: entry.member.item_id,
                attempt: entry.nextAttempt,
              })),
            ),
          )
          .set((eb) => ({
            status: "pending",
            current_node_id: null,
            attempt: eb.ref("resume.attempt"),
            updated_at: now,
          }))
          .whereRef("batch_items.id", "=", "resume.item_id")
          .execute();
        await this.deps.jobs.enqueueMany({
          trx,
          jobs: resuming.map((entry) => ({
            tenantId: args.context.identity.tenantId,
            workflowRunId: args.context.runId,
            workflowStepAttemptId: args.context.workflowStepAttemptId,
            kind: "batch_item" as const,
            payload: {
              itemId: entry.member.item_id,
              itemAttempt: entry.nextAttempt,
            },
            maxAttempts: MAX_BATCH_ITEM_ATTEMPTS,
            dedupeKey: scopeKey(
              args.context,
              `item:${entry.member.item_id}:resume:${args.invocation.id}`,
            ),
          })),
        });
      }
      for (const entry of resolved) {
        if (entry.resumes) continue;
        terminal.push({
          itemId: entry.member.item_id,
          status: entry.outcome.status as "failed" | "skipped",
          error: entry.outcome.error,
        });
      }

      await trx
        .updateTable("batch_step_invocations")
        .set({
          status: "completed",
          completed_at: now,
          error: null,
          updated_at: now,
        })
        .where("id", "=", args.invocation.id)
        .execute();
    });
    for (const outcome of terminal) {
      await this.completeItem({
        context: args.context,
        job: args.job,
        itemId: outcome.itemId,
        status: outcome.status,
        error: outcome.error,
      });
    }
  }

  private async completeItem(args: {
    context: BatchContext;
    job: ExecutionJob;
    itemId: string;
    status: "succeeded" | "failed" | "skipped";
    output?: Json;
    error?: string;
  }): Promise<void> {
    let completed = false;
    await this.db.transaction().execute(async (trx) => {
      const item = await trx
        .selectFrom("batch_items")
        .where("id", "=", args.itemId)
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .select("status")
        .forUpdate()
        .executeTakeFirst();
      if (!item || isTerminalItem(item.status)) return;
      completed = true;
      const now = new Date();
      await trx
        .updateTable("batch_items")
        .set({
          status: args.status,
          output: args.output === undefined ? null : jsonColumn(args.output),
          error: args.error ?? null,
          completed_at: now,
          updated_at: now,
        })
        .where("id", "=", args.itemId)
        .execute();
      await trx
        .updateTable("batch_execution_states")
        .set((eb) => ({
          completed_count:
            args.status === "succeeded"
              ? eb("completed_count", "+", "1")
              : eb.ref("completed_count"),
          failed_count:
            args.status === "failed"
              ? eb("failed_count", "+", "1")
              : eb.ref("failed_count"),
          skipped_count:
            args.status === "skipped"
              ? eb("skipped_count", "+", "1")
              : eb.ref("skipped_count"),
          updated_at: now,
        }))
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .execute();
    });
    if (!completed) return;
    if (
      args.status === "failed" &&
      (await this.applyFailurePolicy(args.context, args.job))
    ) {
      return;
    }
    await this.scheduleSourcePage(args.context);
    await this.finalizeIfComplete(args.context);
  }

  private async applyFailurePolicy(
    context: BatchContext,
    job: ExecutionJob,
  ): Promise<boolean> {
    const state = await this.db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", context.runId)
      .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
      .select(["failure_policy", "failed_count"])
      .executeTakeFirstOrThrow();
    const policy = jsonRecord(state.failure_policy);
    const failFast = policy.mode === "fail_fast";
    const maxFailures =
      typeof policy.maxFailures === "number" ? policy.maxFailures : undefined;
    if (
      !failFast &&
      (maxFailures === undefined || Number(state.failed_count) < maxFailures)
    ) {
      return false;
    }
    await this.deps.coordinator.failStep({
      workflowStepAttemptId: context.workflowStepAttemptId,
      error: failFast
        ? "Batch stopped after the first failed item"
        : `Batch stopped after ${Number(state.failed_count)} failed items`,
      job,
    });
    return true;
  }

  private async scheduleSourcePage(context: BatchContext): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom("batch_execution_states")
        .where("run_id", "=", context.runId)
        .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
        .select([
          "source_done",
          "source_page_queued",
          "source_cursor",
          "source_cursor_present",
        ])
        .forUpdate()
        .executeTakeFirst();
      if (!state || state.source_done || state.source_page_queued) return;
      const backlog = await trx
        .selectFrom("batch_items")
        .where("run_id", "=", context.runId)
        .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
        .where("status", "in", ["pending", "running", "waiting"])
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      if (Number(backlog.count) >= SOURCE_LOW_WATER_MARK) return;
      await this.enqueueSourcePage({
        trx,
        context,
        cursor: state.source_cursor,
        cursorPresent: state.source_cursor_present,
      });
      await trx
        .updateTable("batch_execution_states")
        .set({ source_page_queued: true, updated_at: new Date() })
        .where("run_id", "=", context.runId)
        .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
        .execute();
    });
  }

  private async finalizeIfComplete(context: BatchContext): Promise<void> {
    const state = await this.db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", context.runId)
      .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
      .selectAll()
      .executeTakeFirstOrThrow();
    const terminal =
      Number(state.completed_count) +
      Number(state.failed_count) +
      Number(state.skipped_count);
    if (!state.source_done || terminal < Number(state.discovered_count)) return;
    await this.db.transaction().execute(async (trx) => {
      const pendingSink = await trx
        .selectFrom("execution_jobs")
        .where("workflow_run_id", "=", context.runId)
        .where("workflow_step_attempt_id", "=", context.workflowStepAttemptId)
        .where("kind", "=", "batch_sink")
        .where("status", "in", ["pending", "running", "completed"])
        .select("id")
        .limit(1)
        .executeTakeFirst();
      if (pendingSink) return;
      await this.deps.coordinator.setPhase({
        runId: context.runId,
        workflowStepAttemptId: context.workflowStepAttemptId,
        phase: "sink",
      });
      await this.deps.jobs.enqueue({
        trx,
        tenantId: context.identity.tenantId,
        workflowRunId: context.runId,
        workflowStepAttemptId: context.workflowStepAttemptId,
        kind: "batch_sink",
        payload: { operation: "start" },
        dedupeKey: scopeKey(context, "sink:start"),
      });
    });
  }

  private async executeSink(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const payload = jsonRecord(args.job.payload);
    const operation = requireString(payload.operation, "operation");
    const context = await this.loadContext(args.job);
    if (!context || !this.assertRunnable(context)) return;
    await this.deps.coordinator.setPhase({
      runId: context.runId,
      workflowStepAttemptId: context.workflowStepAttemptId,
      phase: "sink",
    });
    try {
      if (operation === "start") {
        await this.startSink({ context, job: args.job, signal: args.signal });
        return;
      }
      if (operation === "write") {
        await this.writeSinkChunk({
          context,
          job: args.job,
          chunkId: requireString(payload.chunkId, "chunkId"),
          signal: args.signal,
        });
        return;
      }
      if (operation === "finalize") {
        await this.finalizeSink({
          context,
          job: args.job,
          signal: args.signal,
        });
        return;
      }
      throw new Error(`Unknown batch sink operation '${operation}'`);
    } catch (error) {
      if (args.signal.aborted) throw error;
      if (args.job.attempt >= args.job.maxAttempts) {
        await this.deps.coordinator.failStep({
          workflowStepAttemptId: context.workflowStepAttemptId,
          error: error instanceof Error ? error.message : String(error),
          job: args.job,
        });
      }
      throw error;
    }
  }

  private async startSink(args: {
    context: BatchContext;
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const started = await this.db
      .selectFrom("batch_sink_chunks")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .select("id")
      .limit(1)
      .executeTakeFirst();
    if (started) {
      await this.scheduleNextSinkWork(args.context);
      return;
    }
    const inspection = jsonRecord(
      await this.invokeSink({
        context: args.context,
        job: args.job,
        operation: "inspect",
        input: {},
        signal: args.signal,
      }),
    );
    if (inspection.present !== true) {
      await this.completeBatchStep({ context: args.context, job: args.job });
      return;
    }
    const concurrency = sinkConcurrency(inspection);
    if (concurrency > 1 && inspection.hasInitialize === true) {
      // State is one value threaded from chunk to chunk; concurrent writers
      // would race on it, so the combination is a sink authoring error.
      throw new Error(
        "A batch sink with initialize (state) cannot declare concurrency > 1",
      );
    }
    const state =
      inspection.hasInitialize === true
        ? await this.invokeSink({
            context: args.context,
            job: args.job,
            operation: "initialize",
            input: {},
            signal: args.signal,
          })
        : undefined;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("batch_execution_states")
        .set({
          sink_state:
            state === undefined ? null : jsonColumn(requireJson(state)),
          sink_state_present: state !== undefined,
          sink_concurrency: concurrency,
          updated_at: new Date(),
        })
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .execute();
      await this.createSinkChunks({ trx, context: args.context });
      const count = await trx
        .selectFrom("batch_sink_chunks")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("batch_execution_states")
        .set({ sink_total_chunks: Number(count.count), updated_at: new Date() })
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .execute();
      await this.enqueueNextSinkWork({ trx, context: args.context });
    });
  }

  private async createSinkChunks(args: {
    trx: Transaction<DB>;
    context: BatchContext;
  }): Promise<void> {
    const existing = await args.trx
      .selectFrom("batch_sink_chunks")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .select("id")
      .limit(1)
      .executeTakeFirst();
    if (existing) return;
    let after = "-1";
    while (true) {
      const items = await args.trx
        .selectFrom("batch_items")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .where("source_order", ">", after)
        .where("status", "in", ["succeeded", "failed", "skipped"])
        .select("source_order")
        .orderBy("source_order")
        .limit(SINK_CHUNK_SIZE)
        .execute();
      if (items.length === 0) return;
      const first = items[0]?.source_order;
      const last = items.at(-1)?.source_order;
      if (first === undefined || last === undefined) return;
      await args.trx
        .insertInto("batch_sink_chunks")
        .values({
          run_id: args.context.runId,
          workflow_step_attempt_id: args.context.workflowStepAttemptId,
          chunk_key: `${first}:${last}`,
          first_order: first,
          last_order: last,
          item_count: items.length,
        })
        .execute();
      after = String(last);
    }
  }

  private async writeSinkChunk(args: {
    context: BatchContext;
    job: ExecutionJob;
    chunkId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const chunk = await this.db
      .selectFrom("batch_sink_chunks")
      .where("id", "=", args.chunkId)
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .selectAll()
      .executeTakeFirst();
    if (!chunk) throw new Error(`Batch sink chunk '${args.chunkId}' not found`);
    if (chunk.status === "completed") {
      await this.scheduleNextSinkWork(args.context);
      return;
    }
    const [state, items] = await Promise.all([
      this.db
        .selectFrom("batch_execution_states")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .select(["sink_state", "sink_state_present", "sink_concurrency"])
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom("batch_items")
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .where("source_order", ">=", chunk.first_order)
        .where("source_order", "<=", chunk.last_order)
        .where("status", "in", ["succeeded", "failed", "skipped"])
        .select([
          "item_key",
          "source_order",
          "status",
          "output",
          "error",
          "attempt",
        ])
        .orderBy("source_order")
        .execute(),
    ]);
    await this.db
      .updateTable("batch_sink_chunks")
      .set({
        status: "running",
        attempt: args.job.attempt,
        updated_at: new Date(),
      })
      .where("id", "=", chunk.id)
      .execute();
    const result = jsonRecord(
      await this.invokeSink({
        context: args.context,
        job: args.job,
        operation: "writeBatch",
        input: {
          chunkKey: chunk.chunk_key,
          records: items.map((item) => ({
            key: item.item_key,
            ordinal: Number(item.source_order),
            attempt: item.attempt,
            outcome:
              item.status === "succeeded"
                ? {
                    key: item.item_key,
                    status: "succeeded",
                    result: item.output,
                  }
                : item.status === "failed"
                  ? {
                      key: item.item_key,
                      status: "failed",
                      error: { message: item.error ?? "Batch item failed" },
                    }
                  : {
                      key: item.item_key,
                      status: "skipped",
                      reason: item.error ?? undefined,
                    },
          })),
          ...(state.sink_state_present ? { state: state.sink_state } : {}),
        },
        signal: args.signal,
      }),
    );
    const acknowledged = requireStringArray(
      result.acknowledgedKeys,
      "acknowledgedKeys",
    );
    const expected = items.map((item) => item.item_key);
    if (
      acknowledged.length !== expected.length ||
      expected.some((key) => !acknowledged.includes(key))
    ) {
      throw new Error(
        `Batch sink chunk '${chunk.chunk_key}' was not fully acknowledged`,
      );
    }
    if (state.sink_concurrency > 1 && result.state !== undefined) {
      // Concurrent writers would race on the single state row; a sink that
      // wants state must stay serial.
      throw new Error(
        "A batch sink with concurrency > 1 must not return state",
      );
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("batch_sink_chunks")
        .set({
          status: "completed",
          acknowledgement: jsonColumn(acknowledged),
          completed_at: new Date(),
          error: null,
          updated_at: new Date(),
        })
        .where("id", "=", chunk.id)
        .execute();
      await trx
        .updateTable("batch_execution_states")
        .set((eb) => ({
          sink_state:
            result.state === undefined
              ? null
              : jsonColumn(requireJson(result.state)),
          sink_state_present: result.state !== undefined,
          sink_completed_chunks: eb("sink_completed_chunks", "+", "1"),
          updated_at: new Date(),
        }))
        .where("run_id", "=", args.context.runId)
        .where(
          "workflow_step_attempt_id",
          "=",
          args.context.workflowStepAttemptId,
        )
        .execute();
      await this.enqueueNextSinkWork({ trx, context: args.context });
    });
  }

  private async finalizeSink(args: {
    context: BatchContext;
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const state = await this.db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .selectAll()
      .executeTakeFirstOrThrow();
    const summary = batchSummary(state);
    const artifact = requireJson(
      await this.invokeSink({
        context: args.context,
        job: args.job,
        operation: "finalize",
        input: {
          ...(state.sink_state_present ? { state: state.sink_state } : {}),
          summary,
        },
        signal: args.signal,
      }),
    );
    await this.db
      .updateTable("batch_execution_states")
      .set({ sink_artifact: jsonColumn(artifact), updated_at: new Date() })
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .execute();
    await this.completeBatchStep({
      context: args.context,
      job: args.job,
      artifact,
    });
  }

  private async completeBatchStep(args: {
    context: BatchContext;
    job: ExecutionJob;
    artifact?: Json;
  }): Promise<void> {
    const state = await this.db
      .selectFrom("batch_execution_states")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .selectAll()
      .executeTakeFirstOrThrow();
    await this.deps.coordinator.completeStep({
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      output: toJson({
        summary: batchSummary(state),
        ...(args.artifact === undefined ? {} : { artifact: args.artifact }),
      }),
      job: args.job,
    });
  }

  private async invokeSink(args: {
    context: BatchContext;
    job: ExecutionJob;
    operation: "inspect" | "initialize" | "writeBatch" | "finalize";
    input: unknown;
    signal: AbortSignal;
  }): Promise<unknown> {
    const receipt = await this.invoke({
      context: args.context,
      job: args.job,
      invocationId: `${args.job.id}:${args.operation}:attempt:${args.job.attempt}`,
      kind: "batch-sink",
      operation: args.operation,
      input: args.input,
      signal: args.signal,
    });
    if (receipt.terminal.status !== "completed") {
      throw new Error(
        receipt.terminal.status === "suspended"
          ? "A batch sink suspended"
          : receipt.terminal.status === "skipped"
            ? `A batch sink skipped: ${receipt.terminal.reason}`
            : receipt.terminal.error,
      );
    }
    return receipt.terminal.result;
  }

  private async scheduleNextSinkWork(context: BatchContext): Promise<void> {
    await this.db
      .transaction()
      .execute((trx) => this.enqueueNextSinkWork({ trx, context }));
  }

  /**
   * Keeps the sink pipeline full up to the sink's declared concurrency.
   *
   * Serial sinks (the default, and any sink that threads state) see exactly
   * the old behaviour: one chunk job at a time, in source order. A sink that
   * declared `concurrency` gets the next N pending chunks enqueued at once —
   * the per-chunk dedupe key makes re-enqueueing an already-queued chunk a
   * no-op, so every completion can top the window back up without
   * coordination. Finalize waits for every chunk to complete, not merely for
   * the pending set to drain, so an in-flight sibling cannot be finalized
   * over.
   */
  private async enqueueNextSinkWork(args: {
    trx: Transaction<DB>;
    context: BatchContext;
  }): Promise<void> {
    const state = await args.trx
      .selectFrom("batch_execution_states")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .select("sink_concurrency")
      .executeTakeFirstOrThrow();
    const next = await args.trx
      .selectFrom("batch_sink_chunks")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .where("status", "=", "pending")
      .select("id")
      .orderBy("first_order")
      .limit(Math.max(1, state.sink_concurrency))
      .execute();
    if (next.length > 0) {
      await this.deps.jobs.enqueueMany({
        trx: args.trx,
        jobs: next.map((chunk) => ({
          tenantId: args.context.identity.tenantId,
          workflowRunId: args.context.runId,
          workflowStepAttemptId: args.context.workflowStepAttemptId,
          kind: "batch_sink" as const,
          payload: { operation: "write", chunkId: chunk.id },
          dedupeKey: scopeKey(args.context, `sink:chunk:${chunk.id}`),
        })),
      });
      return;
    }
    const incomplete = await args.trx
      .selectFrom("batch_sink_chunks")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .where("status", "!=", "completed")
      .select("id")
      .limit(1)
      .executeTakeFirst();
    if (incomplete) return;
    await this.deps.jobs.enqueue({
      trx: args.trx,
      tenantId: args.context.identity.tenantId,
      workflowRunId: args.context.runId,
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      kind: "batch_sink",
      payload: { operation: "finalize" },
      dedupeKey: scopeKey(args.context, "sink:finalize"),
    });
  }

  private async enqueueSourcePage(args: {
    trx: Transaction<DB>;
    context: BatchContext;
    cursor: Json | null;
    cursorPresent: boolean;
  }): Promise<void> {
    await this.deps.jobs.enqueue({
      trx: args.trx,
      tenantId: args.context.identity.tenantId,
      workflowRunId: args.context.runId,
      workflowStepAttemptId: args.context.workflowStepAttemptId,
      kind: "batch_source",
      payload: { operation: "read_page" },
      dedupeKey: scopeKey(
        args.context,
        `source:${await sha256(
          JSON.stringify({
            present: args.cursorPresent,
            ...(args.cursorPresent ? { value: args.cursor } : {}),
          }),
        )}`,
      ),
    });
  }

  private async invoke(args: {
    context: BatchContext;
    job: ExecutionJob;
    invocationId: string;
    kind: RuntimeInvocation["kind"];
    operation?: string;
    modulePath?: string;
    exportName?: string;
    stepIndex?: number;
    input: unknown;
    attempt?: number;
    signal: AbortSignal;
  }): Promise<RuntimeInvocationReceipt> {
    return this.deps.coordinator.invokeRuntime({
      job: args.job,
      invocationId: args.invocationId,
      invoke: () =>
        this.deps.invokeRuntime({
          identity: args.context.identity,
          projectId: args.context.projectId,
          workflowName: args.context.workflowName,
          commitSha: args.context.commitSha,
          artifactId: args.context.artifactId,
          invocationId: args.invocationId,
          kind: args.kind,
          operation: args.operation,
          modulePath: args.modulePath ?? args.context.modulePath,
          exportName: args.exportName ?? args.context.exportName,
          stepIndex:
            args.stepIndex === undefined &&
            !(args.kind === "batch-step" && args.operation === "run")
              ? args.context.stepIndex
              : args.stepIndex,
          input: args.input,
          attempt: args.attempt ?? args.job.attempt,
          signal: args.signal,
        }),
    });
  }

  private async loadReplay(args: {
    context: BatchContext;
    itemId: string;
  }): Promise<Record<string, Json>> {
    const rows = await this.db
      .selectFrom("batch_item_steps")
      .where("run_id", "=", args.context.runId)
      .where(
        "workflow_step_attempt_id",
        "=",
        args.context.workflowStepAttemptId,
      )
      .where("item_id", "=", args.itemId)
      .where("status", "=", "completed")
      .where("output_present", "=", true)
      .select(["node_id", "occurrence", "output"])
      .execute();
    return Object.fromEntries(
      rows.map((row) => [`${row.node_id}:${row.occurrence}`, row.output]),
    );
  }

  private async persistRuntimeSteps(args: {
    context: BatchContext;
    itemId: string;
    attempt: number;
    steps: RuntimeInvocationReceipt["terminal"]["steps"];
  }): Promise<void> {
    if (args.steps.length === 0) return;
    const now = new Date();
    // One statement for the whole ledger. This runs once per item, so a
    // per-step round trip made the cost of a batch scale with items × steps.
    await this.db
      .insertInto("batch_item_steps")
      .values(
        args.steps.map((step) => ({
          run_id: args.context.runId,
          workflow_step_attempt_id: args.context.workflowStepAttemptId,
          item_id: args.itemId,
          node_id: step.nodeId,
          occurrence: step.occurrence,
          attempt: args.attempt,
          name: step.name,
          status: step.status,
          input:
            step.input === undefined
              ? null
              : jsonColumn(requireJson(step.input)),
          input_present: step.input !== undefined,
          output:
            step.output === undefined
              ? null
              : jsonColumn(requireJson(step.output)),
          output_present: step.output !== undefined,
          error: step.error ?? null,
          started_at: new Date(step.startedAt),
          completed_at: new Date(step.completedAt),
        })),
      )
      .onConflict((conflict) =>
        conflict
          .columns([
            "run_id",
            "workflow_step_attempt_id",
            "item_id",
            "node_id",
            "occurrence",
            "attempt",
          ])
          // Redelivery replays the same ledger, so each row takes the values
          // from its own proposed insert rather than a per-step closure.
          .doUpdateSet((eb) => ({
            status: eb.ref("excluded.status"),
            input: eb.ref("excluded.input"),
            input_present: eb.ref("excluded.input_present"),
            output: eb.ref("excluded.output"),
            output_present: eb.ref("excluded.output_present"),
            error: eb.ref("excluded.error"),
            started_at: eb.ref("excluded.started_at"),
            completed_at: eb.ref("excluded.completed_at"),
            updated_at: now,
          })),
      )
      .execute();
  }

  private async loadContext(job: ExecutionJob): Promise<BatchContext | null> {
    if (!job.workflowStepAttemptId) return null;
    const row = await this.db
      .selectFrom("workflow_step_attempts")
      .innerJoin(
        "workflow_runs",
        "workflow_runs.id",
        "workflow_step_attempts.run_id",
      )
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .innerJoin(
        "deployment_artifacts",
        "deployment_artifacts.id",
        "workflow_runs.deployment_artifact_id",
      )
      .innerJoin(
        "workflow_run_states",
        "workflow_run_states.run_id",
        "workflow_runs.id",
      )
      .where("workflow_step_attempts.id", "=", job.workflowStepAttemptId)
      .where("workflow_runs.id", "=", job.workflowRunId)
      .where("projects.tenant_id", "=", job.tenantId)
      .select([
        "workflow_runs.id as run_id",
        "workflow_runs.project_id",
        "workflow_runs.workflow_name",
        "workflow_runs.external_user_id",
        "workflow_runs.deployment_artifact_id",
        "workflow_runs.status",
        "workflow_runs.phase",
        "deployment_artifacts.commit_sha",
        "projects.tenant_id",
        "workflow_step_attempts.id as workflow_step_attempt_id",
        "workflow_step_attempts.step_index",
        "workflow_step_attempts.input",
        "workflow_run_states.execution_plan",
      ])
      .executeTakeFirst();
    if (!row?.external_user_id || !row.deployment_artifact_id) return null;
    const target = jsonRecord(jsonRecord(row.execution_plan).exportTarget);
    const modulePath = stringValue(target.modulePath);
    const exportName = stringValue(target.exportName);
    if (!modulePath || !exportName)
      throw new Error("Execution target is invalid");
    return {
      identity: {
        tenantId: row.tenant_id,
        externalUserId: row.external_user_id,
      },
      runId: row.run_id,
      workflowStepAttemptId: row.workflow_step_attempt_id,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      commitSha: row.commit_sha,
      artifactId: row.deployment_artifact_id,
      modulePath,
      exportName,
      stepIndex: row.step_index,
      workflowInput: row.input,
      status: row.status,
      phase: row.phase,
      executionPlan: row.execution_plan,
    };
  }

  private assertRunnable(context: BatchContext): boolean {
    if (context.status === "paused") {
      // Park rather than poll: every item job on a paused batch would other-
      // wise cycle through claim+release indefinitely, burning queue capacity
      // that the tenant's live runs need. `resume` wakes them explicitly, and
      // release re-checks the run for a resume that landed mid-flight.
      throw new ExecutionJobDeferredError(
        new Date(Date.now() + PAUSED_RUN_PARK_MS),
        { parkedForPausedRunId: context.runId },
      );
    }
    return !["canceling", "canceled", "completed", "failed"].includes(
      context.status,
    );
  }
}

function scopeKey(context: BatchContext, suffix: string): string {
  return `run:${context.runId}:step-attempt:${context.workflowStepAttemptId}:${suffix}`;
}

function batchAttributes(context: BatchContext): SpanAttributes {
  return {
    "catamorphic.tenant.id": context.identity.tenantId,
    "catamorphic.project.id": context.projectId,
    "catamorphic.workflow.name": context.workflowName,
    "catamorphic.run.id": context.runId,
    "catamorphic.workflow_step_attempt.id": context.workflowStepAttemptId,
    "catamorphic.deployment_artifact.id": context.artifactId,
  };
}

/**
 * Finds an open invocation with room for one more member.
 *
 * Capacity comes from the counters on the invocation row, maintained by the
 * same advisory-lock-serialized transaction that admits members. The previous
 * shape re-read every member's input to re-derive fullness, which made each
 * admission O(members) inside the serial section — a full coalescing window
 * cost O(members²) in payload bytes.
 */
async function findCompatibleInvocation(args: {
  trx: Transaction<DB>;
  context: BatchContext;
  nodeId: string;
  functionName: string;
  compatibilityKey: string;
  maxItems: number;
  maxBytes?: number;
  inputBytes: number;
}): Promise<{ id: string; closes_at: Date } | null> {
  let query = args.trx
    .selectFrom("batch_step_invocations")
    .where("run_id", "=", args.context.runId)
    .where("workflow_step_attempt_id", "=", args.context.workflowStepAttemptId)
    .where("node_id", "=", args.nodeId)
    .where("function_name", "=", args.functionName)
    .where("compatibility_key", "=", args.compatibilityKey)
    .where("status", "=", "pending")
    .where("closes_at", ">", new Date())
    .where("member_count", "<", args.maxItems);
  if (args.maxBytes !== undefined) {
    query = query.where(
      "member_bytes",
      "<=",
      String(args.maxBytes - args.inputBytes),
    );
  }
  const candidate = await query
    .select(["id", "closes_at"])
    .orderBy("created_at")
    .limit(1)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  return candidate ?? null;
}

function physicalTarget(args: {
  executionPlan: Json;
  nodeId: string;
  functionName: string;
}): { modulePath: string; exportName: string } {
  const steps = jsonRecord(args.executionPlan).steps;
  if (!Array.isArray(steps)) throw new Error("Execution plan is invalid");
  for (const step of steps) {
    const physicalSteps = jsonRecord(jsonRecord(step).process).physicalSteps;
    if (!Array.isArray(physicalSteps)) continue;
    for (const physical of physicalSteps) {
      const descriptor = jsonRecord(physical);
      if (
        descriptor.nodeId !== args.nodeId ||
        descriptor.functionName !== args.functionName
      ) {
        continue;
      }
      const target = jsonRecord(descriptor.exportTarget);
      return {
        modulePath: requireString(
          target.modulePath,
          "physical step modulePath",
        ),
        exportName: requireString(
          target.exportName,
          "physical step exportName",
        ),
      };
    }
  }
  throw new Error(
    `Physical batch step '${args.functionName}' was not described`,
  );
}

function batchSummary(state: {
  discovered_count: string;
  completed_count: string;
  failed_count: string;
  skipped_count: string;
}) {
  return {
    total: Number(state.discovered_count),
    succeeded: Number(state.completed_count),
    failed: Number(state.failed_count),
    skipped: Number(state.skipped_count),
  };
}

function parseSourceInitialization(receipt: RuntimeInvocationReceipt): {
  snapshot: Json;
  cursor: Json | null;
  cursorPresent: boolean;
  estimatedCount?: number;
  consistency: "snapshot" | "bounded" | "best_effort";
} {
  if (receipt.terminal.status !== "completed") {
    throw new Error("Batch source initialization failed");
  }
  const result = jsonRecord(receipt.terminal.result);
  const cursorPresent = Object.hasOwn(result, "cursor");
  return {
    snapshot: requireJson(result.snapshot),
    cursor: cursorPresent ? requireJson(result.cursor) : null,
    cursorPresent,
    estimatedCount:
      typeof result.estimatedCount === "number"
        ? result.estimatedCount
        : undefined,
    consistency:
      result.consistency === "bounded" || result.consistency === "best_effort"
        ? result.consistency
        : "snapshot",
  };
}

function parseSourcePage(receipt: RuntimeInvocationReceipt): {
  items: Array<{ key: string; value: Json }>;
  nextCursor: Json | null;
  nextCursorPresent: boolean;
  done: boolean;
} {
  if (receipt.terminal.status !== "completed") {
    throw new Error("Batch source page failed");
  }
  const result = jsonRecord(receipt.terminal.result);
  if (!Array.isArray(result.items) || typeof result.done !== "boolean") {
    throw new Error("Batch source returned an invalid page");
  }
  const nextCursorPresent = Object.hasOwn(result, "nextCursor");
  return {
    items: result.items.map((item) => {
      const value = jsonRecord(item);
      return {
        key: requireString(value.key, "source item key"),
        value: requireJson(value.value),
      };
    }),
    nextCursor: nextCursorPresent ? requireJson(result.nextCursor) : null,
    nextCursorPresent,
    done: result.done,
  };
}

function uniqueSourceItems(
  items: readonly { key: string; value: Json }[],
): Array<{ key: string; value: Json }> {
  const keys = new Set<string>();
  return items.filter((item) => {
    if (keys.has(item.key)) return false;
    keys.add(item.key);
    return true;
  });
}

function parseBatchOutcomes(args: {
  value: unknown;
  expectedKeys: readonly string[];
}): BatchOutcome[] {
  if (!Array.isArray(args.value)) {
    throw new Error("Batch step returned non-array outcomes");
  }
  const outcomes = args.value.map((entry): BatchOutcome => {
    const value = jsonRecord(entry);
    const key = requireString(value.key, "outcome key");
    if (value.status === "succeeded") {
      return { key, status: "succeeded", result: requireJson(value.result) };
    }
    if (value.status === "skipped") {
      return {
        key,
        status: "skipped",
        error: typeof value.reason === "string" ? value.reason : "Item skipped",
      };
    }
    if (value.status === "failed") {
      const error = jsonRecord(value.error);
      return {
        key,
        status: "failed",
        error: requireString(error.message, "outcome error"),
        retryable: error.retryable === true,
      };
    }
    throw new Error(`Batch outcome '${key}' has an invalid status`);
  });
  const expected = new Set(args.expectedKeys);
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (!expected.has(outcome.key)) {
      throw new Error(`Batch step returned unknown key '${outcome.key}'`);
    }
    if (seen.has(outcome.key)) {
      throw new Error(`Batch step returned duplicate key '${outcome.key}'`);
    }
    seen.add(outcome.key);
  }
  const missing = args.expectedKeys.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(`Batch step omitted keys: ${missing.join(", ")}`);
  }
  return outcomes;
}

function batchPolicyJson(policy: RuntimeBatchStepSuspension["policy"]): Json {
  return toJson(policy);
}

const MAX_SINK_CONCURRENCY = 16;

function sinkConcurrency(inspection: Record<string, unknown>): number {
  const declared = inspection.concurrency;
  if (declared === undefined) return 1;
  if (
    typeof declared !== "number" ||
    !Number.isInteger(declared) ||
    declared < 1
  ) {
    throw new Error("Batch sink concurrency must be a positive integer");
  }
  return Math.min(declared, MAX_SINK_CONCURRENCY);
}

function readRateLimits(args: {
  policy: Json;
  itemCount: number;
}): RateLimit[] {
  const value = jsonRecord(args.policy).rateLimits;
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("Batch step rateLimits must be an array");
  return value.map((entry) => {
    const limit = jsonRecord(entry);
    const cost =
      (typeof limit.costPerItem === "number" ? limit.costPerItem : 1) *
      args.itemCount;
    return {
      key: {
        globalKey: requireString(limit.globalKey, "globalKey"),
        ...(typeof limit.partitionKey === "string"
          ? { partitionKey: limit.partitionKey }
          : {}),
      },
      capacity: requirePositiveNumber(limit.capacity, "capacity"),
      refillRatePerSecond: requirePositiveNumber(
        limit.refillRatePerSecond,
        "refillRatePerSecond",
      ),
      cost,
    };
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Expected ${field} to be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Expected ${field} to be a positive integer`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${field} to be a positive number`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Expected ${field} to be an array of strings`);
  }
  return value;
}

function requireJson(value: unknown): Json {
  if (!isJson(value)) throw new Error("Runtime value is not JSON serializable");
  return value;
}

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  return Object.values(value).every(
    (entry) => entry === undefined || isJson(entry),
  );
}

/**
 * Builds an `outcome` VALUES list for joining per-member results into an UPDATE.
 *
 * Types are cast explicitly: Postgres infers `unknown` for bare literals in a
 * VALUES list, which then fails to compare against the typed columns it is
 * joined to. The first row carries the casts and the rest follow it.
 */
function memberOutcomeValues(
  rows: readonly {
    itemId: string;
    status: string;
    output?: Json;
    error: string | null;
    occurrence?: number;
    attempt?: number;
  }[],
) {
  const hasStepKey = rows[0]?.occurrence !== undefined;
  // UNION ALL of SELECTs rather than a VALUES list: a VALUES row needs its
  // column names supplied as `alias(cols)`, which collides with the alias
  // Kysely appends via `.as()`. Naming the columns in the leading SELECT
  // carries the same types with no second alias.
  const selects = rows.map((row, index) => {
    const label = (name: string) =>
      index === 0 ? sql.raw(` AS ${name}`) : sql``;
    const output =
      row.output === undefined ? sql`NULL::jsonb` : jsonColumn(row.output);
    const base = sql`SELECT ${row.itemId}::uuid${label("item_id")}, ${row.status}::varchar${label("status")}, ${output}${label("output")}, ${row.output !== undefined}::boolean${label("output_present")}, ${row.error}::text${label("error")}`;
    return hasStepKey
      ? sql`${base}, ${row.occurrence ?? 0}::integer${label("occurrence")}, ${row.attempt ?? 0}::integer${label("attempt")}`
      : base;
  });
  return sql<never>`(${sql.join(selects, sql` UNION ALL `)})`.as("outcome");
}

/** Builds a `resume` row set pairing each item with its next attempt. */
function itemAttemptValues(
  rows: readonly { itemId: string; attempt: number }[],
) {
  const selects = rows.map((row, index) => {
    const label = (name: string) =>
      index === 0 ? sql.raw(` AS ${name}`) : sql``;
    return sql`SELECT ${row.itemId}::uuid${label("item_id")}, ${row.attempt}::integer${label("attempt")}`;
  });
  return sql<never>`(${sql.join(selects, sql` UNION ALL `)})`.as("resume");
}

function isTerminalItem(status: string): boolean {
  return ["succeeded", "failed", "skipped", "canceled"].includes(status);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
