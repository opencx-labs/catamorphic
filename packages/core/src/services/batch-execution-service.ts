import type { DB, Json } from "@catamorphic/db";
import { getTracer, type SpanAttributes, withSpan } from "@catamorphic/otel";
import type {
  RuntimeBatchStepSuspension,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import type { Identity } from "../identity.js";
import type { BatchRunsService } from "./batch-runs-service.js";
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

const tracer = getTracer("@catamorphic/core");
const MAX_BATCH_ITEM_ATTEMPTS = 5;

interface BatchExecutionContext {
  identity: Identity;
  batchRunId: string;
  projectId: string;
  workflowName: string;
  commitSha: string;
  artifactId: string;
  triggerData: Json | null;
  status: string;
}

interface BatchOutcome {
  key: string;
  status: "succeeded" | "failed" | "skipped";
  result?: Json;
  error?: string;
  retryable?: boolean;
}

export class BatchExecutionService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      batchRuns: BatchRunsService;
      jobs: ExecutionJobsService;
      rateReservations: RateReservationsService;
      worker: ExecutionWorkerService;
      invokeRuntime: (args: {
        identity: Identity;
        projectId: string;
        workflowName: string;
        commitSha: string;
        artifactId: string;
        invocationId: string;
        kind: RuntimeInvocation["kind"];
        operation?: string;
        exportName?: string;
        input: unknown;
        attempt: number;
        timeoutSeconds?: number;
      }) => Promise<RuntimeInvocationReceipt>;
    },
  ) {
    deps.worker.registerHandler({
      kind: "batch_source",
      handler: ({ job }) => this.executeSourceJob({ job }),
    });
    deps.worker.registerHandler({
      kind: "batch_item",
      handler: ({ job }) => this.executeItemJob({ job }),
    });
    deps.worker.registerHandler({
      kind: "batch_step",
      handler: ({ job }) => this.executeBatchStepJob({ job }),
    });
    deps.worker.registerHandler({
      kind: "batch_sink",
      handler: ({ job }) => this.executeSinkJob({ job }),
    });
  }

  private async executeSourceJob(args: { job: ExecutionJob }): Promise<void> {
    const payload = requireRecord(args.job.payload);
    const batchRunId = requireString(payload.batchRunId, "batchRunId");
    const operation = requireString(payload.operation, "operation");
    const context = await this.loadContext({
      tenantId: args.job.tenantId,
      batchRunId,
    });
    if (!this.assertRunnable(context)) return;

    return withSpan(
      {
        tracer,
        name: "batch.source.execute",
        attributes: {
          ...batchAttributes(context),
          "catamorphic.source.operation": operation,
          "catamorphic.invocation.id": `${args.job.id}:${
            operation === "initialize" ? "initialize" : "read-page"
          }`,
        },
      },
      async () => {
        if (operation === "initialize") {
          const initialized = await this.deps.invokeRuntime({
            ...runtimeIdentity(context),
            invocationId: `${args.job.id}:initialize`,
            kind: "batch-source",
            operation: "initialize",
            input: { workflowInput: context.triggerData ?? {} },
            attempt: args.job.attempt,
          });
          const source = parseSourceInitialization(initialized);
          await this.deps.batchRuns.initializeSource({
            identity: context.identity,
            batchRunId,
            snapshot: source.snapshot,
            cursor: source.cursor,
            consistency: source.consistency,
            estimatedCount: source.estimatedCount,
          });
          await this.readSourcePage({
            context,
            job: args.job,
            snapshot: source.snapshot,
            cursor: source.cursor,
          });
          return;
        }

        if (operation !== "read_page") {
          throw new Error(`Unknown batch source operation '${operation}'`);
        }
        const run = await this.db
          .selectFrom("batch_runs")
          .where("id", "=", batchRunId)
          .select(["source_snapshot", "source_cursor"])
          .executeTakeFirstOrThrow();
        if (run.source_snapshot === null) {
          throw new Error(`Batch run '${batchRunId}' has no source snapshot`);
        }
        await this.readSourcePage({
          context,
          job: args.job,
          snapshot: run.source_snapshot,
          cursor: run.source_cursor ?? undefined,
        });
      },
    );
  }

  private async readSourcePage(args: {
    context: BatchExecutionContext;
    job: ExecutionJob;
    snapshot: Json;
    cursor?: Json;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "batch.source.read_page",
        attributes: {
          ...batchAttributes(args.context),
          "catamorphic.invocation.id": `${args.job.id}:read-page`,
          "catamorphic.source.page.limit": 250,
        },
      },
      async (span) => {
        const receipt = await this.deps.invokeRuntime({
          ...runtimeIdentity(args.context),
          invocationId: `${args.job.id}:read-page`,
          kind: "batch-source",
          operation: "readPage",
          input: {
            workflowInput: args.context.triggerData ?? {},
            snapshot: args.snapshot,
            cursor: args.cursor,
            limit: 250,
          },
          attempt: args.job.attempt,
        });
        const page = parseSourcePage(receipt);
        span.setAttribute(
          "catamorphic.source.page.item_count",
          page.items.length,
        );
        span.setAttribute("catamorphic.source.page.done", page.done);
        const accepted = await this.deps.batchRuns.acceptSourcePage({
          identity: args.context.identity,
          batchRunId: args.context.batchRunId,
          items: page.items,
          nextCursor: page.nextCursor,
          done: page.done,
        });
        span.setAttribute(
          "catamorphic.source.page.accepted_count",
          accepted.accepted,
        );
      },
    );
  }

  private async executeItemJob(args: { job: ExecutionJob }): Promise<void> {
    const payload = requireRecord(args.job.payload);
    const batchRunId = requireString(payload.batchRunId, "batchRunId");
    const itemId = requireString(payload.itemId, "itemId");
    const baseAttempt = requirePositiveInteger(
      payload.itemAttempt,
      "itemAttempt",
    );
    const itemAttempt = baseAttempt + args.job.attempt - 1;
    const context = await this.loadContext({
      tenantId: args.job.tenantId,
      batchRunId,
    });
    if (!this.assertRunnable(context)) return;
    return withSpan(
      {
        tracer,
        name: "batch.item.execute",
        attributes: {
          ...batchAttributes(context),
          "catamorphic.item.id": itemId,
          "catamorphic.invocation.id": `${args.job.id}:process`,
        },
      },
      async () => {
        const item = await this.db
          .selectFrom("batch_items")
          .where("id", "=", itemId)
          .where("batch_run_id", "=", batchRunId)
          .selectAll()
          .executeTakeFirst();
        if (!item || isTerminal(item.status)) return;
        if (item.value === null) {
          await this.deps.batchRuns.completeItem({
            identity: context.identity,
            batchRunId,
            itemId,
            status: "failed",
            error: "Referenced batch item values require a host resolver",
          });
          return;
        }

        await this.db
          .updateTable("batch_items")
          .set({
            status: "running",
            attempt: itemAttempt,
            updated_at: new Date(),
          })
          .where("id", "=", itemId)
          .where("status", "in", ["pending", "waiting", "running"])
          .execute();
        const replay = await this.loadReplay({ itemId });
        const receipt = await this.deps.invokeRuntime({
          ...runtimeIdentity(context),
          invocationId: `${args.job.id}:process`,
          kind: "batch-step",
          operation: "process",
          input: {
            key: item.item_key,
            item: item.value,
            replay,
          },
          attempt: itemAttempt,
        });
        await this.persistRuntimeSteps({
          itemId,
          attempt: itemAttempt,
          steps: receipt.terminal.steps,
        });

        if (receipt.terminal.status === "completed") {
          await this.deps.batchRuns.completeItem({
            identity: context.identity,
            batchRunId,
            itemId,
            status: "succeeded",
            output: requireJson(receipt.terminal.result),
          });
          return;
        }
        if (receipt.terminal.status === "suspended") {
          await this.parkAtBatchStep({
            context,
            item: {
              id: item.id,
              key: item.item_key,
              attempt: itemAttempt,
            },
            suspension: receipt.terminal.suspension,
          });
          return;
        }
        if (receipt.terminal.status === "skipped") {
          await this.deps.batchRuns.completeItem({
            identity: context.identity,
            batchRunId,
            itemId,
            status: "skipped",
            error: receipt.terminal.reason,
          });
          return;
        }

        const error = receipt.terminal.error;
        if (args.job.attempt >= args.job.maxAttempts) {
          await this.deps.batchRuns.completeItem({
            identity: context.identity,
            batchRunId,
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
            error,
            updated_at: new Date(),
          })
          .where("id", "=", itemId)
          .execute();
        throw new Error(error);
      },
    );
  }

  private async parkAtBatchStep(args: {
    context: BatchExecutionContext;
    item: { id: string; key: string; attempt: number };
    suspension: RuntimeBatchStepSuspension;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "batch.step.coordinate",
        attributes: {
          ...batchAttributes(args.context),
          "catamorphic.item.id": args.item.id,
          "catamorphic.step.node_id": args.suspension.nodeId,
          "catamorphic.step.name": args.suspension.name,
          "catamorphic.step.function_name": args.suspension.functionName,
        },
      },
      async (span) => {
        const compatibilityKey = await sha256(
          JSON.stringify({
            artifactId: args.context.artifactId,
            workflowName: args.context.workflowName,
            nodeId: args.suspension.nodeId,
            functionName: args.suspension.functionName,
            partition: args.suspension.partition ?? null,
          }),
        );
        const closesAt = new Date(
          Date.now() + args.suspension.policy.maxWaitMs,
        );
        const invocation = await this.db.transaction().execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${compatibilityKey}, 0))`.execute(
            trx,
          );
          const candidate = await findCompatibleInvocation({
            trx,
            batchRunId: args.context.batchRunId,
            nodeId: args.suspension.nodeId,
            functionName: args.suspension.functionName,
            compatibilityKey,
            maxItems: args.suspension.policy.maxItems,
            maxBytes: args.suspension.policy.maxBytes,
            input: args.suspension.input,
          });
          const physical =
            candidate ??
            (await trx
              .insertInto("batch_step_invocations")
              .values({
                batch_run_id: args.context.batchRunId,
                node_id: args.suspension.nodeId,
                function_name: args.suspension.functionName,
                compatibility_key: compatibilityKey,
                policy: batchPolicyJson(args.suspension.policy),
                closes_at: closesAt,
              })
              .returning(["id", "closes_at"])
              .executeTakeFirstOrThrow());
          await trx
            .insertInto("batch_step_members")
            .values({
              invocation_id: physical.id,
              item_id: args.item.id,
              member_key: args.item.key,
              input: requireJson(args.suspension.input),
            })
            .onConflict((conflict) =>
              conflict.columns(["invocation_id", "item_id"]).doNothing(),
            )
            .execute();
          await trx
            .insertInto("batch_item_steps")
            .values({
              item_id: args.item.id,
              node_id: args.suspension.nodeId,
              occurrence: 0,
              attempt: args.item.attempt,
              name: args.suspension.name,
              status: "waiting",
              input: requireJson(args.suspension.input),
            })
            .onConflict((conflict) =>
              conflict
                .columns(["item_id", "node_id", "occurrence", "attempt"])
                .doUpdateSet({
                  status: "waiting",
                  input: requireJson(args.suspension.input),
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
          const members = await trx
            .selectFrom("batch_step_members")
            .where("invocation_id", "=", physical.id)
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow();
          return {
            id: physical.id,
            closesAt: physical.closes_at,
            full: Number(members.count) >= args.suspension.policy.maxItems,
          };
        });

        span.setAttribute("catamorphic.invocation.id", invocation.id);
        span.setAttribute("catamorphic.step.batch_full", invocation.full);
        const dedupeKey = `batch:${args.context.batchRunId}:step:${invocation.id}`;
        await this.deps.jobs.enqueue({
          tenantId: args.context.identity.tenantId,
          kind: "batch_step",
          payload: {
            batchRunId: args.context.batchRunId,
            invocationId: invocation.id,
          },
          availableAt: invocation.full ? new Date() : invocation.closesAt,
          dedupeKey,
        });
        if (invocation.full) {
          await this.deps.jobs.makeAvailable({
            tenantId: args.context.identity.tenantId,
            dedupeKey,
          });
        }
      },
    );
  }

  private async executeBatchStepJob(args: {
    job: ExecutionJob;
  }): Promise<void> {
    const payload = requireRecord(args.job.payload);
    const batchRunId = requireString(payload.batchRunId, "batchRunId");
    const invocationId = requireString(payload.invocationId, "invocationId");
    const context = await this.loadContext({
      tenantId: args.job.tenantId,
      batchRunId,
    });
    if (!this.assertRunnable(context)) return;
    return withSpan(
      {
        tracer,
        name: "batch.step.execute",
        attributes: {
          ...batchAttributes(context),
          "catamorphic.invocation.id": invocationId,
          "catamorphic.runtime_invocation.id": `${args.job.id}:batch`,
        },
      },
      async (span) => {
        const invocation = await this.db
          .selectFrom("batch_step_invocations")
          .where("id", "=", invocationId)
          .where("batch_run_id", "=", batchRunId)
          .selectAll()
          .executeTakeFirst();
        if (!invocation || invocation.status === "completed") return;
        span.setAttribute("catamorphic.step.node_id", invocation.node_id);
        span.setAttribute(
          "catamorphic.step.function_name",
          invocation.function_name,
        );
        const members = await this.db
          .selectFrom("batch_step_members")
          .innerJoin(
            "batch_items",
            "batch_items.id",
            "batch_step_members.item_id",
          )
          .where("invocation_id", "=", invocationId)
          .where("batch_step_members.status", "=", "pending")
          .select([
            "batch_step_members.item_id",
            "batch_step_members.member_key",
            "batch_step_members.input",
            "batch_items.attempt as item_attempt",
          ])
          .orderBy("member_key", "asc")
          .execute();
        if (members.length === 0) return;
        span.setAttribute("catamorphic.step.member_count", members.length);
        const rateLimits = readRateLimits({
          policy: invocation.policy,
          itemCount: members.length,
        });
        if (rateLimits.length > 0) {
          const reservation = await this.deps.rateReservations.reserve({
            tenantId: context.identity.tenantId,
            limits: rateLimits,
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
          })
          .where("id", "=", invocationId)
          .execute();

        const receipt = await this.deps.invokeRuntime({
          ...runtimeIdentity(context),
          invocationId: `${args.job.id}:batch`,
          kind: "batch-step",
          exportName: invocation.function_name,
          operation: "run",
          input: {
            items: members.map((member) => ({
              key: member.member_key,
              value: member.input,
              attempt: member.item_attempt,
            })),
          },
          attempt: args.job.attempt,
        });
        if (receipt.terminal.status !== "completed") {
          const error =
            receipt.terminal.status === "suspended"
              ? "A physical batch step suspended recursively"
              : receipt.terminal.status === "skipped"
                ? `A physical batch step skipped: ${receipt.terminal.reason}`
                : receipt.terminal.error;
          await this.db
            .updateTable("batch_step_invocations")
            .set({
              status:
                args.job.attempt >= args.job.maxAttempts ? "failed" : "pending",
              error,
            })
            .where("id", "=", invocationId)
            .execute();
          throw new Error(error);
        }
        const outcomes = parseBatchOutcomes({
          value: receipt.terminal.result,
          expectedKeys: members.map((member) => member.member_key),
        });
        await this.persistBatchOutcomes({
          context,
          invocationId,
          members,
          outcomes,
        });
      },
    );
  }

  private async executeSinkJob(args: { job: ExecutionJob }): Promise<void> {
    const payload = requireRecord(args.job.payload);
    const batchRunId = requireString(payload.batchRunId, "batchRunId");
    const operation = requireString(payload.operation, "operation");
    const context = await this.loadContext({
      tenantId: args.job.tenantId,
      batchRunId,
    });
    if (context.status === "paused") {
      throw new ExecutionJobDeferredError(new Date(Date.now() + 5_000));
    }
    if (context.status !== "sinking") return;

    const chunkId =
      typeof payload.chunkId === "string" ? payload.chunkId : undefined;
    return withSpan(
      {
        tracer,
        name: "batch.sink.execute",
        attributes: {
          ...batchAttributes(context),
          "catamorphic.sink.operation": operation,
          "catamorphic.invocation.id": `${args.job.id}:${operation}`,
          ...(chunkId ? { "catamorphic.sink.chunk.id": chunkId } : {}),
        },
      },
      async () => {
        try {
          if (operation === "start") {
            await this.startSink({ context, job: args.job });
            return;
          }
          if (operation === "write") {
            await this.writeSinkChunk({
              context,
              job: args.job,
              chunkId: requireString(payload.chunkId, "chunkId"),
            });
            return;
          }
          if (operation === "finalize") {
            await this.finalizeSink({ context, job: args.job });
            return;
          }
          throw new Error(`Unknown batch sink operation '${operation}'`);
        } catch (error) {
          if (args.job.attempt >= args.job.maxAttempts) {
            await this.deps.batchRuns.failSink({
              identity: context.identity,
              batchRunId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      },
    );
  }

  private async startSink(args: {
    context: BatchExecutionContext;
    job: ExecutionJob;
  }): Promise<void> {
    const inspection = await this.invokeSink({
      context: args.context,
      job: args.job,
      operation: "inspect",
      input: {},
    });
    const details = requireRecord(inspection);
    if (details.present !== true) {
      await this.deps.batchRuns.completeSink({
        identity: args.context.identity,
        batchRunId: args.context.batchRunId,
      });
      return;
    }

    const state =
      details.hasInitialize === true
        ? await this.invokeSink({
            context: args.context,
            job: args.job,
            operation: "initialize",
            input: {},
          })
        : undefined;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("batch_runs")
        .set({ sink_state: jsonColumn(optionalJson(state)) })
        .where("id", "=", args.context.batchRunId)
        .execute();
      await this.createSinkChunks({
        trx,
        batchRunId: args.context.batchRunId,
      });
      const chunkCount = await trx
        .selectFrom("batch_sink_chunks")
        .where("batch_run_id", "=", args.context.batchRunId)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("batch_runs")
        .set({ sink_total_chunks: Number(chunkCount.count) })
        .where("id", "=", args.context.batchRunId)
        .execute();
      await this.enqueueNextSinkWork({
        trx,
        tenantId: args.context.identity.tenantId,
        batchRunId: args.context.batchRunId,
      });
    });
  }

  private async createSinkChunks(args: {
    trx: Transaction<DB>;
    batchRunId: string;
  }): Promise<void> {
    const existing = await args.trx
      .selectFrom("batch_sink_chunks")
      .where("batch_run_id", "=", args.batchRunId)
      .select("id")
      .limit(1)
      .executeTakeFirst();
    if (existing) return;

    const createPage = async (after: string): Promise<void> => {
      const items = await args.trx
        .selectFrom("batch_items")
        .where("batch_run_id", "=", args.batchRunId)
        .where("source_order", ">", after)
        .where("status", "in", ["succeeded", "failed", "skipped"])
        .select(["source_order"])
        .orderBy("source_order", "asc")
        .limit(100)
        .execute();
      if (items.length === 0) return;
      const firstOrder = items[0]?.source_order;
      const lastOrder = items.at(-1)?.source_order;
      if (firstOrder === undefined || lastOrder === undefined) return;
      await args.trx
        .insertInto("batch_sink_chunks")
        .values({
          batch_run_id: args.batchRunId,
          chunk_key: `${firstOrder}:${lastOrder}`,
          status: "pending",
          first_order: firstOrder,
          last_order: lastOrder,
          item_count: items.length,
        })
        .execute();
      await createPage(lastOrder);
    };
    await createPage("-1");
  }

  private async writeSinkChunk(args: {
    context: BatchExecutionContext;
    job: ExecutionJob;
    chunkId: string;
  }): Promise<void> {
    const chunk = await this.db
      .selectFrom("batch_sink_chunks")
      .where("id", "=", args.chunkId)
      .where("batch_run_id", "=", args.context.batchRunId)
      .selectAll()
      .executeTakeFirst();
    if (!chunk) throw new Error(`Batch sink chunk '${args.chunkId}' not found`);
    if (chunk.status === "completed") {
      await this.scheduleNextSinkWork({ context: args.context });
      return;
    }
    await withSpan(
      {
        tracer,
        name: "batch.sink.write_chunk",
        attributes: {
          ...batchAttributes(args.context),
          "catamorphic.sink.chunk.id": chunk.id,
          "catamorphic.sink.chunk.key": chunk.chunk_key,
          "catamorphic.sink.chunk.item_count": chunk.item_count,
          "catamorphic.invocation.id": `${args.job.id}:writeBatch`,
        },
      },
      async () => {
        const [run, items] = await Promise.all([
          this.db
            .selectFrom("batch_runs")
            .where("id", "=", args.context.batchRunId)
            .select("sink_state")
            .executeTakeFirstOrThrow(),
          this.db
            .selectFrom("batch_items")
            .where("batch_run_id", "=", args.context.batchRunId)
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
            .orderBy("source_order", "asc")
            .execute(),
        ]);
        await this.db
          .updateTable("batch_sink_chunks")
          .set({ status: "running", attempt: args.job.attempt })
          .where("id", "=", args.chunkId)
          .execute();
        const result = requireRecord(
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
              state: run.sink_state ?? undefined,
            },
          }),
        );
        const acknowledgedKeys = requireStringArray(
          result.acknowledgedKeys,
          "acknowledgedKeys",
        );
        const expectedKeys = items.map((item) => item.item_key);
        if (
          acknowledgedKeys.length !== expectedKeys.length ||
          expectedKeys.some((key) => !acknowledgedKeys.includes(key))
        ) {
          throw new Error(
            `Batch sink chunk '${chunk.chunk_key}' was not fully acknowledged`,
          );
        }
        await this.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("batch_sink_chunks")
            .set({
              status: "completed",
              acknowledgement: jsonColumn(acknowledgedKeys),
              completed_at: new Date(),
              error: null,
            })
            .where("id", "=", args.chunkId)
            .execute();
          await trx
            .updateTable("batch_runs")
            .set((eb) => ({
              sink_state: jsonColumn(optionalJson(result.state)),
              sink_completed_chunks: eb("sink_completed_chunks", "+", "1"),
            }))
            .where("id", "=", args.context.batchRunId)
            .execute();
          await this.enqueueNextSinkWork({
            trx,
            tenantId: args.context.identity.tenantId,
            batchRunId: args.context.batchRunId,
          });
        });
      },
    );
  }

  private async finalizeSink(args: {
    context: BatchExecutionContext;
    job: ExecutionJob;
  }): Promise<void> {
    const run = await this.db
      .selectFrom("batch_runs")
      .where("id", "=", args.context.batchRunId)
      .select([
        "sink_state",
        "discovered_count",
        "completed_count",
        "failed_count",
        "skipped_count",
      ])
      .executeTakeFirstOrThrow();
    const artifact = requireJson(
      await this.invokeSink({
        context: args.context,
        job: args.job,
        operation: "finalize",
        input: {
          state: run.sink_state ?? undefined,
          summary: {
            total: Number(run.discovered_count),
            succeeded: Number(run.completed_count),
            failed: Number(run.failed_count),
            skipped: Number(run.skipped_count),
          },
        },
      }),
    );
    await this.deps.batchRuns.completeSink({
      identity: args.context.identity,
      batchRunId: args.context.batchRunId,
      artifact,
    });
  }

  private async invokeSink(args: {
    context: BatchExecutionContext;
    job: ExecutionJob;
    operation: string;
    input: Json | Record<string, unknown>;
  }): Promise<unknown> {
    const receipt = await this.deps.invokeRuntime({
      ...runtimeIdentity(args.context),
      invocationId: `${args.job.id}:${args.operation}`,
      kind: "batch-sink",
      operation: args.operation,
      input: args.input,
      attempt: args.job.attempt,
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

  private async scheduleNextSinkWork(args: {
    context: BatchExecutionContext;
  }): Promise<void> {
    await this.db.transaction().execute((trx) =>
      this.enqueueNextSinkWork({
        trx,
        tenantId: args.context.identity.tenantId,
        batchRunId: args.context.batchRunId,
      }),
    );
  }

  private async enqueueNextSinkWork(args: {
    trx: Transaction<DB>;
    tenantId: string;
    batchRunId: string;
  }): Promise<void> {
    const nextChunk = await args.trx
      .selectFrom("batch_sink_chunks")
      .where("batch_run_id", "=", args.batchRunId)
      .where("status", "=", "pending")
      .select("id")
      .orderBy("first_order", "asc")
      .limit(1)
      .executeTakeFirst();
    const operation = nextChunk ? "write" : "finalize";
    await this.deps.jobs.enqueue({
      tenantId: args.tenantId,
      kind: "batch_sink",
      payload: {
        batchRunId: args.batchRunId,
        operation,
        ...(nextChunk ? { chunkId: nextChunk.id } : {}),
      },
      dedupeKey: nextChunk
        ? `batch:${args.batchRunId}:sink:chunk:${nextChunk.id}`
        : `batch:${args.batchRunId}:sink:finalize`,
      trx: args.trx,
    });
  }

  private async persistBatchOutcomes(args: {
    context: BatchExecutionContext;
    invocationId: string;
    members: readonly {
      item_id: string;
      member_key: string;
      input: Json | null;
      item_attempt: number;
    }[];
    outcomes: readonly BatchOutcome[];
  }): Promise<void> {
    const byKey = new Map(
      args.outcomes.map((outcome) => [outcome.key, outcome]),
    );
    await this.db.transaction().execute(async (trx) => {
      for (const member of args.members) {
        const outcome = byKey.get(member.member_key);
        if (!outcome) throw new Error(`Missing outcome '${member.member_key}'`);
        const shouldRetry =
          outcome.status === "failed" &&
          outcome.retryable &&
          member.item_attempt < MAX_BATCH_ITEM_ATTEMPTS;
        await trx
          .updateTable("batch_step_members")
          .set({
            status: shouldRetry ? "unresolved" : outcome.status,
            output: jsonColumn(outcome.result),
            error: outcome.error ?? null,
          })
          .where("invocation_id", "=", args.invocationId)
          .where("item_id", "=", member.item_id)
          .execute();
        if (outcome.status === "succeeded" || shouldRetry) {
          await trx
            .updateTable("batch_item_steps")
            .set({
              status: outcome.status === "succeeded" ? "completed" : "failed",
              output:
                outcome.status === "succeeded"
                  ? jsonColumn(outcome.result)
                  : null,
              error:
                outcome.status === "failed" ? (outcome.error ?? null) : null,
              completed_at: new Date(),
            })
            .where("item_id", "=", member.item_id)
            .where(
              "node_id",
              "=",
              (
                await trx
                  .selectFrom("batch_step_invocations")
                  .where("id", "=", args.invocationId)
                  .select("node_id")
                  .executeTakeFirstOrThrow()
              ).node_id,
            )
            .where("occurrence", "=", 0)
            .where("attempt", "=", member.item_attempt)
            .execute();
          await trx
            .updateTable("batch_items")
            .set({
              status: "pending",
              current_node_id: null,
              attempt: shouldRetry
                ? member.item_attempt + 1
                : member.item_attempt,
              updated_at: new Date(),
            })
            .where("id", "=", member.item_id)
            .execute();
          await this.deps.jobs.enqueue({
            tenantId: args.context.identity.tenantId,
            kind: "batch_item",
            payload: {
              batchRunId: args.context.batchRunId,
              itemId: member.item_id,
              itemAttempt: shouldRetry
                ? member.item_attempt + 1
                : member.item_attempt,
            },
            dedupeKey: `batch:${args.context.batchRunId}:item:${member.item_id}:resume:${args.invocationId}`,
            trx,
          });
        }
      }
      await trx
        .updateTable("batch_step_invocations")
        .set({
          status: "completed",
          completed_at: new Date(),
          error: null,
        })
        .where("id", "=", args.invocationId)
        .execute();
    });
    for (const member of args.members) {
      const outcome = byKey.get(member.member_key);
      const shouldRetry =
        outcome?.status === "failed" &&
        outcome.retryable &&
        member.item_attempt < MAX_BATCH_ITEM_ATTEMPTS;
      if (!outcome || outcome.status === "succeeded" || shouldRetry) {
        continue;
      }
      await this.deps.batchRuns.completeItem({
        identity: args.context.identity,
        batchRunId: args.context.batchRunId,
        itemId: member.item_id,
        status: outcome.status,
        error: outcome.error,
      });
    }
  }

  private async persistRuntimeSteps(args: {
    itemId: string;
    attempt: number;
    steps: RuntimeInvocationReceipt["terminal"]["steps"];
  }): Promise<void> {
    const occurrences = new Map<string, number>();
    for (const step of args.steps) {
      const occurrence = occurrences.get(step.nodeId) ?? 0;
      occurrences.set(step.nodeId, occurrence + 1);
      await this.db
        .insertInto("batch_item_steps")
        .values({
          item_id: args.itemId,
          node_id: step.nodeId,
          occurrence,
          attempt: args.attempt,
          name: step.name,
          status: step.status,
          input: optionalJson(step.input),
          output: optionalJson(step.output),
          error: step.error ?? null,
          started_at: new Date(step.startedAt),
          completed_at: new Date(step.completedAt),
        })
        .onConflict((conflict) =>
          conflict
            .columns(["item_id", "node_id", "occurrence", "attempt"])
            .doUpdateSet({
              status: step.status,
              input: optionalJson(step.input),
              output: optionalJson(step.output),
              error: step.error ?? null,
              started_at: new Date(step.startedAt),
              completed_at: new Date(step.completedAt),
            }),
        )
        .execute();
    }
  }

  private async loadReplay(args: {
    itemId: string;
  }): Promise<Record<string, Json>> {
    const rows = await this.db
      .selectFrom("batch_item_steps")
      .where("item_id", "=", args.itemId)
      .where("status", "=", "completed")
      .where("output", "is not", null)
      .select(["node_id", "occurrence", "output"])
      .execute();
    return Object.fromEntries(
      rows.flatMap((row) =>
        row.output === null
          ? []
          : [[`${row.node_id}:${row.occurrence}`, row.output]],
      ),
    );
  }

  private async loadContext(args: {
    tenantId: string;
    batchRunId: string;
  }): Promise<BatchExecutionContext> {
    const row = await this.db
      .selectFrom("batch_runs")
      .innerJoin("projects", "projects.id", "batch_runs.project_id")
      .innerJoin(
        "deployment_artifacts",
        "deployment_artifacts.id",
        "batch_runs.deployment_artifact_id",
      )
      .where("batch_runs.id", "=", args.batchRunId)
      .where("projects.tenant_id", "=", args.tenantId)
      .select([
        "batch_runs.id",
        "batch_runs.project_id",
        "batch_runs.workflow_name",
        "batch_runs.external_user_id",
        "batch_runs.trigger_data",
        "batch_runs.status",
        "deployment_artifacts.id as artifact_id",
        "deployment_artifacts.commit_sha",
        "projects.tenant_id",
      ])
      .executeTakeFirst();
    if (!row?.external_user_id) {
      throw new Error(`Batch run '${args.batchRunId}' has invalid provenance`);
    }
    return {
      identity: {
        tenantId: row.tenant_id,
        externalUserId: row.external_user_id,
      },
      batchRunId: row.id,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      commitSha: row.commit_sha,
      artifactId: row.artifact_id,
      triggerData: row.trigger_data,
      status: row.status,
    };
  }

  private assertRunnable(context: BatchExecutionContext): boolean {
    if (context.status === "paused") {
      throw new ExecutionJobDeferredError(new Date(Date.now() + 5_000));
    }
    if (
      context.status === "canceled" ||
      context.status === "completed" ||
      context.status === "completed_with_errors" ||
      context.status === "failed"
    ) {
      return false;
    }
    return true;
  }
}

async function findCompatibleInvocation(args: {
  trx: Transaction<DB>;
  batchRunId: string;
  nodeId: string;
  functionName: string;
  compatibilityKey: string;
  maxItems: number;
  maxBytes?: number;
  input: unknown;
}): Promise<{ id: string; closes_at: Date } | null> {
  const candidates = await args.trx
    .selectFrom("batch_step_invocations")
    .where("batch_run_id", "=", args.batchRunId)
    .where("node_id", "=", args.nodeId)
    .where("function_name", "=", args.functionName)
    .where("compatibility_key", "=", args.compatibilityKey)
    .where("status", "=", "pending")
    .where("closes_at", ">", new Date())
    .select(["id", "closes_at"])
    .orderBy("created_at", "asc")
    .forUpdate()
    .skipLocked()
    .execute();
  for (const candidate of candidates) {
    const members = await args.trx
      .selectFrom("batch_step_members")
      .where("invocation_id", "=", candidate.id)
      .select("input")
      .execute();
    if (members.length >= args.maxItems) continue;
    const byteCount =
      members.reduce(
        (total, member) => total + jsonByteLength(member.input),
        0,
      ) + jsonByteLength(args.input);
    if (args.maxBytes !== undefined && byteCount > args.maxBytes) continue;
    return candidate;
  }
  return null;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function batchPolicyJson(policy: RuntimeBatchStepSuspension["policy"]): Json {
  return {
    maxItems: policy.maxItems,
    maxWaitMs: policy.maxWaitMs,
    ...(policy.maxBytes === undefined ? {} : { maxBytes: policy.maxBytes }),
    ...(policy.rateLimits === undefined
      ? {}
      : {
          rateLimits: policy.rateLimits.map((limit) => ({
            globalKey: limit.globalKey,
            capacity: limit.capacity,
            refillRatePerSecond: limit.refillRatePerSecond,
            ...(limit.partitionKey === undefined
              ? {}
              : { partitionKey: limit.partitionKey }),
            ...(limit.costPerItem === undefined
              ? {}
              : { costPerItem: limit.costPerItem }),
          })),
        }),
  };
}

function readRateLimits(args: {
  policy: Json;
  itemCount: number;
}): RateLimit[] {
  if (
    typeof args.policy !== "object" ||
    args.policy === null ||
    Array.isArray(args.policy)
  ) {
    return [];
  }
  const value = Reflect.get(args.policy, "rateLimits");
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Batch step rateLimits must be an array");
  }
  return value.map((entry) => {
    const limit = requireRecord(entry);
    const globalKey = requireString(limit.globalKey, "globalKey");
    const capacity = requirePositiveNumber(limit.capacity, "capacity");
    const refillRatePerSecond = requirePositiveNumber(
      limit.refillRatePerSecond,
      "refillRatePerSecond",
    );
    const costPerItem =
      limit.costPerItem === undefined
        ? 1
        : requirePositiveNumber(limit.costPerItem, "costPerItem");
    return {
      key: {
        globalKey,
        ...(typeof limit.partitionKey === "string"
          ? { partitionKey: limit.partitionKey }
          : {}),
      },
      capacity,
      refillRatePerSecond,
      cost: costPerItem * args.itemCount,
    };
  });
}

function batchAttributes(context: BatchExecutionContext): SpanAttributes {
  return {
    "catamorphic.tenant.id": context.identity.tenantId,
    "catamorphic.project.id": context.projectId,
    "catamorphic.workflow.name": context.workflowName,
    "catamorphic.batch_run.id": context.batchRunId,
    "catamorphic.deployment_artifact.id": context.artifactId,
  };
}

function runtimeIdentity(context: BatchExecutionContext): {
  identity: Identity;
  projectId: string;
  workflowName: string;
  commitSha: string;
  artifactId: string;
} {
  return {
    identity: context.identity,
    projectId: context.projectId,
    workflowName: context.workflowName,
    commitSha: context.commitSha,
    artifactId: context.artifactId,
  };
}

function parseSourceInitialization(receipt: RuntimeInvocationReceipt): {
  snapshot: Json;
  cursor?: Json;
  estimatedCount?: number;
  consistency: "snapshot" | "bounded" | "best_effort";
} {
  if (receipt.terminal.status !== "completed") {
    throw new Error("Batch source initialization failed");
  }
  const result = requireRecord(receipt.terminal.result);
  const consistency =
    result.consistency === "bounded" || result.consistency === "best_effort"
      ? result.consistency
      : "snapshot";
  return {
    snapshot: requireJson(result.snapshot),
    cursor: optionalJson(result.cursor) ?? undefined,
    estimatedCount:
      typeof result.estimatedCount === "number"
        ? result.estimatedCount
        : undefined,
    consistency,
  };
}

function parseSourcePage(receipt: RuntimeInvocationReceipt): {
  items: { key: string; value: Json }[];
  nextCursor?: Json;
  done: boolean;
} {
  if (receipt.terminal.status !== "completed") {
    throw new Error("Batch source page failed");
  }
  const result = requireRecord(receipt.terminal.result);
  if (!Array.isArray(result.items) || typeof result.done !== "boolean") {
    throw new Error("Batch source returned an invalid page");
  }
  return {
    items: result.items.map((item) => {
      const record = requireRecord(item);
      return {
        key: requireString(record.key, "source item key"),
        value: requireJson(record.value),
      };
    }),
    nextCursor: optionalJson(result.nextCursor) ?? undefined,
    done: result.done,
  };
}

function parseBatchOutcomes(args: {
  value: unknown;
  expectedKeys: readonly string[];
}): BatchOutcome[] {
  if (!Array.isArray(args.value)) {
    throw new Error("Batch step returned non-array outcomes");
  }
  const outcomes = args.value.map((value) => {
    const record = requireRecord(value);
    const key = requireString(record.key, "outcome key");
    if (record.status === "succeeded") {
      const status: BatchOutcome["status"] = "succeeded";
      return {
        key,
        status,
        result: requireJson(record.result),
      };
    }
    if (record.status === "skipped") {
      const status: BatchOutcome["status"] = "skipped";
      return {
        key,
        status,
        error:
          typeof record.reason === "string" ? record.reason : "Item skipped",
      };
    }
    if (record.status === "failed") {
      const failure = requireRecord(record.error);
      const status: BatchOutcome["status"] = "failed";
      return {
        key,
        status,
        error: requireString(failure.message, "outcome error"),
        retryable: failure.retryable === true,
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return Object.fromEntries(Object.entries(value));
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

function optionalJson(value: unknown): Json | null {
  return value === undefined ? null : requireJson(value);
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

function isTerminal(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "canceled"
  );
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

function jsonColumn(value: Json | undefined) {
  return value === undefined
    ? null
    : sql<Json>`${JSON.stringify(value)}::jsonb`;
}
