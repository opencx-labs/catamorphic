import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import type { DeploymentArtifact } from "./deployment-artifacts-service.js";
import type { ExecutionJobsService } from "./execution-jobs-service.js";
import { ProjectNotFoundError } from "./projects-service.js";

type BatchRunRow = Selectable<DB["batch_runs"]>;
type BatchItemRow = Selectable<DB["batch_items"]>;
const tracer = getTracer("@catamorphic/core");

export type BatchRunStatus =
  | "pending"
  | "sourcing"
  | "running"
  | "paused"
  | "sinking"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "canceled";

export type BatchItemStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

export interface BatchFailurePolicy extends JsonObject {
  mode: "continue" | "fail_fast";
  maxFailures?: number;
}

export interface BatchRun {
  id: string;
  projectId: string;
  workflowName: string;
  deploymentArtifactId: string | null;
  mode: "test" | "production";
  initiatedBy: string | null;
  status: BatchRunStatus;
  triggerData: Json | null;
  sourceSnapshot: Json | null;
  sourceCursor: Json | null;
  sourceConsistency: string | null;
  estimatedCount: number | null;
  discoveredCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  failurePolicy: Json | null;
  artifact: Json | null;
  sinkCompletedChunks: number;
  sinkTotalChunks: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface BatchItem {
  id: string;
  batchRunId: string;
  key: string;
  sourceOrder: number;
  status: BatchItemStatus;
  value: Json | null;
  valueReference: Json | null;
  output: Json | null;
  outputReference: Json | null;
  error: string | null;
  currentNodeId: string | null;
  availableAt: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface BatchItemStep {
  id: string;
  itemId: string;
  nodeId: string;
  occurrence: number;
  attempt: number;
  name: string;
  status: string;
  input: Json | null;
  output: Json | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ListBatchRunsResult {
  items: BatchRun[];
  total: number;
}

export interface ListBatchItemsResult {
  items: BatchItem[];
  total: number;
}

export class BatchRunNotFoundError extends Error {
  constructor(readonly batchRunId: string) {
    super(`Batch run '${batchRunId}' not found`);
    this.name = "BatchRunNotFoundError";
  }
}

export class BatchItemNotFoundError extends Error {
  constructor(readonly itemId: string) {
    super(`Batch item '${itemId}' not found`);
    this.name = "BatchItemNotFoundError";
  }
}

export class BatchWorkflowRequiredError extends Error {
  constructor(readonly workflowName: string) {
    super(`Workflow '${workflowName}' is not a batch workflow`);
    this.name = "BatchWorkflowRequiredError";
  }
}

export class BatchRunsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      jobs: ExecutionJobsService;
      resolveProductionArtifact: (args: {
        identity: Identity;
        projectId: string;
        workflowName: string;
      }) => Promise<DeploymentArtifact>;
      getWorkflowKind: (args: {
        identity: Identity;
        projectId: string;
        workflowName: string;
        ref: string;
      }) => Promise<"regular" | "batch">;
      cancelRuntimeInvocations?: (args: {
        artifactId: string;
        invocationIds: readonly string[];
      }) => Promise<void>;
    },
  ) {}

  async triggerProduction(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    triggerData?: Json;
    failurePolicy?: BatchFailurePolicy;
  }): Promise<BatchRun> {
    return withSpan(
      {
        tracer,
        name: "batch.run.trigger",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.project.id": args.projectId,
          "catamorphic.workflow.name": args.workflowName,
        },
      },
      async (span) => {
        const artifact = await this.deps.resolveProductionArtifact(args);
        const workflowKind = await this.deps.getWorkflowKind({
          identity: args.identity,
          projectId: args.projectId,
          workflowName: args.workflowName,
          ref: artifact.commitSha,
        });
        if (workflowKind !== "batch") {
          throw new BatchWorkflowRequiredError(args.workflowName);
        }
        const batchRunId = crypto.randomUUID();
        span.setAttribute("catamorphic.batch_run.id", batchRunId);
        span.setAttribute("catamorphic.deployment_artifact.id", artifact.id);
        await this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("batch_runs")
            .values({
              id: batchRunId,
              project_id: args.projectId,
              workflow_name: args.workflowName,
              deployment_artifact_id: artifact.id,
              mode: "production",
              external_user_id: args.identity.externalUserId,
              status: "pending",
              source_page_queued: true,
              trigger_data: args.triggerData ?? null,
              failure_policy: args.failurePolicy ?? null,
            })
            .execute();
          await this.deps.jobs.enqueue({
            tenantId: args.identity.tenantId,
            kind: "batch_source",
            payload: { batchRunId, operation: "initialize" },
            dedupeKey: `batch:${batchRunId}:source:initialize`,
            trx,
          });
        });
        return this.get({
          identity: args.identity,
          batchRunId,
        });
      },
    );
  }

  async get(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<BatchRun> {
    const row = await this.db
      .selectFrom("batch_runs")
      .innerJoin("projects", "projects.id", "batch_runs.project_id")
      .where("batch_runs.id", "=", args.batchRunId)
      .where("projects.tenant_id", "=", args.identity.tenantId)
      .selectAll("batch_runs")
      .executeTakeFirst();
    if (!row) throw new BatchRunNotFoundError(args.batchRunId);
    return mapBatchRun(row);
  }

  async list(args: {
    identity: Identity;
    projectId: string;
    workflowName?: string;
    limit?: number;
    offset?: number;
  }): Promise<ListBatchRunsResult> {
    await this.requireProject(args.identity, args.projectId);
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const offset = Math.max(0, args.offset ?? 0);
    let query = this.db
      .selectFrom("batch_runs")
      .where("project_id", "=", args.projectId);
    let countQuery = this.db
      .selectFrom("batch_runs")
      .where("project_id", "=", args.projectId);
    if (args.workflowName) {
      query = query.where("workflow_name", "=", args.workflowName);
      countQuery = countQuery.where("workflow_name", "=", args.workflowName);
    }
    const [rows, count] = await Promise.all([
      query
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      countQuery
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map(mapBatchRun),
      total: Number(count.count),
    };
  }

  async listItems(args: {
    identity: Identity;
    batchRunId: string;
    status?: BatchItemStatus;
    limit?: number;
    offset?: number;
  }): Promise<ListBatchItemsResult> {
    await this.get(args);
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const offset = Math.max(0, args.offset ?? 0);
    let query = this.db
      .selectFrom("batch_items")
      .where("batch_run_id", "=", args.batchRunId);
    let countQuery = this.db
      .selectFrom("batch_items")
      .where("batch_run_id", "=", args.batchRunId);
    if (args.status) {
      query = query.where("status", "=", args.status);
      countQuery = countQuery.where("status", "=", args.status);
    }
    const [rows, count] = await Promise.all([
      query
        .selectAll()
        .orderBy("source_order", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      countQuery
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map(mapBatchItem),
      total: Number(count.count),
    };
  }

  async listItemSteps(args: {
    identity: Identity;
    batchRunId: string;
    itemId: string;
  }): Promise<BatchItemStep[]> {
    await this.get(args);
    const item = await this.db
      .selectFrom("batch_items")
      .where("id", "=", args.itemId)
      .where("batch_run_id", "=", args.batchRunId)
      .select("id")
      .executeTakeFirst();
    if (!item) throw new BatchItemNotFoundError(args.itemId);
    const rows = await this.db
      .selectFrom("batch_item_steps")
      .where("item_id", "=", args.itemId)
      .selectAll()
      .orderBy("attempt", "asc")
      .orderBy("started_at", "asc")
      .orderBy("occurrence", "asc")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      nodeId: row.node_id,
      occurrence: row.occurrence,
      attempt: row.attempt,
      name: row.name,
      status: row.status,
      input: row.input,
      output: row.output,
      error: row.error,
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
    }));
  }

  async initializeSource(args: {
    identity: Identity;
    batchRunId: string;
    snapshot: Json;
    cursor?: Json;
    consistency: "snapshot" | "bounded" | "best_effort";
    estimatedCount?: number;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "batch.source.initialize",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.batch_run.id": args.batchRunId,
          "catamorphic.source.consistency": args.consistency,
        },
      },
      async (span) => {
        const run = await this.get(args);
        span.setAttribute("catamorphic.project.id", run.projectId);
        span.setAttribute("catamorphic.workflow.name", run.workflowName);
        await this.db
          .updateTable("batch_runs")
          .set({
            status: "sourcing",
            source_snapshot: args.snapshot,
            source_cursor: args.cursor ?? null,
            source_consistency: args.consistency,
            estimated_count: args.estimatedCount ?? null,
            started_at: new Date(),
          })
          .where("id", "=", args.batchRunId)
          .where("status", "=", "pending")
          .execute();
      },
    );
  }

  async acceptSourcePage(args: {
    identity: Identity;
    batchRunId: string;
    items: readonly {
      key: string;
      value?: Json;
      valueReference?: Json;
    }[];
    nextCursor?: Json;
    done: boolean;
    highWaterMark?: number;
  }): Promise<{ accepted: number }> {
    return withSpan(
      {
        tracer,
        name: "batch.source.accept_page",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.batch_run.id": args.batchRunId,
          "catamorphic.source.page.item_count": args.items.length,
          "catamorphic.source.page.done": args.done,
        },
      },
      async (span) => {
        const batchRun = await this.get(args);
        span.setAttribute("catamorphic.project.id", batchRun.projectId);
        span.setAttribute("catamorphic.workflow.name", batchRun.workflowName);
        if (!args.done && args.nextCursor === undefined) {
          throw new Error("A non-terminal source page must include nextCursor");
        }
        for (const item of args.items) {
          if (
            (item.value === undefined) ===
            (item.valueReference === undefined)
          ) {
            throw new Error(
              `Batch source item '${item.key}' must have exactly one value or valueReference`,
            );
          }
        }
        const nextCursorKey = await cursorKey(args.nextCursor);
        const accepted = await this.db.transaction().execute(async (trx) => {
          const inserted =
            args.items.length === 0
              ? []
              : await trx
                  .insertInto("batch_items")
                  .values(
                    args.items.map((item, index) => ({
                      batch_run_id: args.batchRunId,
                      item_key: item.key,
                      source_order: batchRun.discoveredCount + index,
                      value: item.value ?? null,
                      value_reference: item.valueReference ?? null,
                    })),
                  )
                  .onConflict((conflict) =>
                    conflict.columns(["batch_run_id", "item_key"]).doNothing(),
                  )
                  .returning(["id", "item_key"])
                  .execute();

          for (const item of inserted) {
            await this.deps.jobs.enqueue({
              tenantId: args.identity.tenantId,
              kind: "batch_item",
              payload: {
                batchRunId: args.batchRunId,
                itemId: item.id,
                itemAttempt: 1,
              },
              dedupeKey: `batch:${args.batchRunId}:item:${item.id}`,
              trx,
            });
          }

          const backlog = await trx
            .selectFrom("batch_items")
            .where("batch_run_id", "=", args.batchRunId)
            .where("status", "in", ["pending", "running", "waiting"])
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow();
          const shouldQueueNextPage =
            !args.done && Number(backlog.count) < (args.highWaterMark ?? 1_000);
          await trx
            .updateTable("batch_runs")
            .set((eb) => ({
              status: args.done ? "running" : "sourcing",
              source_cursor: args.nextCursor ?? null,
              source_done: args.done,
              source_page_queued: shouldQueueNextPage,
              discovered_count: eb(
                "discovered_count",
                "+",
                String(inserted.length),
              ),
            }))
            .where("id", "=", args.batchRunId)
            .where("status", "in", ["sourcing", "running"])
            .execute();

          if (shouldQueueNextPage) {
            await this.deps.jobs.enqueue({
              tenantId: args.identity.tenantId,
              kind: "batch_source",
              payload: {
                batchRunId: args.batchRunId,
                operation: "read_page",
              },
              dedupeKey: `batch:${args.batchRunId}:source:${nextCursorKey}`,
              trx,
            });
          }
          return inserted.length;
        });
        if (args.done) {
          await this.finalizeIfComplete({
            identity: args.identity,
            batchRunId: args.batchRunId,
          });
        }
        span.setAttribute("catamorphic.source.page.accepted_count", accepted);
        return { accepted };
      },
    );
  }

  async completeItem(args: {
    identity: Identity;
    batchRunId: string;
    itemId: string;
    status: "succeeded" | "failed" | "skipped";
    output?: Json;
    outputReference?: Json;
    error?: string;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "batch.item.complete",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.batch_run.id": args.batchRunId,
          "catamorphic.item.id": args.itemId,
          "catamorphic.item.status": args.status,
        },
      },
      async (span) => {
        const run = await this.get(args);
        span.setAttribute("catamorphic.project.id", run.projectId);
        span.setAttribute("catamorphic.workflow.name", run.workflowName);
        await this.db.transaction().execute(async (trx) => {
          const item = await trx
            .selectFrom("batch_items")
            .where("id", "=", args.itemId)
            .where("batch_run_id", "=", args.batchRunId)
            .select(["status"])
            .forUpdate()
            .executeTakeFirst();
          if (!item || isTerminalItemStatus(item.status)) return;

          await trx
            .updateTable("batch_items")
            .set({
              status: args.status,
              output: jsonColumn(args.output),
              output_reference: args.outputReference ?? null,
              error: args.error ?? null,
              completed_at: new Date(),
              updated_at: new Date(),
            })
            .where("id", "=", args.itemId)
            .execute();

          await trx
            .updateTable("batch_runs")
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
            }))
            .where("id", "=", args.batchRunId)
            .execute();
        });
        if (
          args.status === "failed" &&
          (await this.applyFailurePolicy({
            identity: args.identity,
            batchRunId: args.batchRunId,
          }))
        ) {
          return;
        }
        await this.scheduleSourcePage({
          identity: args.identity,
          batchRunId: args.batchRunId,
        });
        await this.finalizeIfComplete({
          identity: args.identity,
          batchRunId: args.batchRunId,
        });
      },
    );
  }

  async cancel(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<BatchRun> {
    const existing = await this.get(args);
    const runningJobs = await this.db
      .selectFrom("execution_jobs")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("status", "=", "running")
      .where("dedupe_key", "like", `batch:${args.batchRunId}:%`)
      .select(["id", "kind", "payload"])
      .execute();
    const now = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("batch_runs")
        .set({
          status: "canceled",
          cancel_requested_at: now,
          completed_at: now,
        })
        .where("id", "=", args.batchRunId)
        .where("status", "not in", [
          "completed",
          "completed_with_errors",
          "failed",
          "canceled",
        ])
        .execute();
      await trx
        .updateTable("batch_items")
        .set({
          status: "canceled",
          completed_at: now,
          updated_at: now,
        })
        .where("batch_run_id", "=", args.batchRunId)
        .where("status", "in", ["pending", "waiting"])
        .execute();
    });
    await this.deps.jobs.cancelByDedupePrefix({
      tenantId: args.identity.tenantId,
      dedupePrefix: `batch:${args.batchRunId}:`,
    });
    if (
      existing.deploymentArtifactId &&
      this.deps.cancelRuntimeInvocations &&
      runningJobs.length > 0
    ) {
      await this.deps.cancelRuntimeInvocations({
        artifactId: existing.deploymentArtifactId,
        invocationIds: runningJobs.map(runtimeInvocationId),
      });
    }
    return this.get(args);
  }

  async pause(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<BatchRun> {
    const run = await this.get(args);
    if (
      run.status === "completed" ||
      run.status === "completed_with_errors" ||
      run.status === "failed" ||
      run.status === "canceled" ||
      run.status === "paused"
    ) {
      return run;
    }
    await this.db
      .updateTable("batch_runs")
      .set({
        status: "paused",
        paused_from_status: run.status,
      })
      .where("id", "=", args.batchRunId)
      .execute();
    return this.get(args);
  }

  async resume(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<BatchRun> {
    await this.get(args);
    const row = await this.db
      .selectFrom("batch_runs")
      .where("id", "=", args.batchRunId)
      .select(["status", "paused_from_status"])
      .executeTakeFirstOrThrow();
    if (row.status !== "paused") {
      return this.get(args);
    }
    await this.db
      .updateTable("batch_runs")
      .set({
        status: row.paused_from_status ?? "running",
        paused_from_status: null,
      })
      .where("id", "=", args.batchRunId)
      .where("status", "=", "paused")
      .execute();
    return this.get(args);
  }

  async retryFailedItems(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<BatchRun> {
    const run = await this.get(args);
    if (run.status !== "completed_with_errors") return run;
    await this.db.transaction().execute(async (trx) => {
      const failedItems = await trx
        .selectFrom("batch_items")
        .where("batch_run_id", "=", args.batchRunId)
        .where("status", "=", "failed")
        .select(["id", "attempt"])
        .forUpdate()
        .execute();
      if (failedItems.length === 0) return;
      await trx
        .deleteFrom("batch_sink_chunks")
        .where("batch_run_id", "=", args.batchRunId)
        .execute();
      await trx
        .deleteFrom("execution_jobs")
        .where("tenant_id", "=", args.identity.tenantId)
        .where("dedupe_key", "like", `batch:${args.batchRunId}:sink:%`)
        .where("status", "in", ["completed", "failed", "canceled"])
        .execute();
      await trx
        .updateTable("batch_items")
        .set({
          status: "pending",
          error: null,
          completed_at: null,
          updated_at: new Date(),
        })
        .where(
          "id",
          "in",
          failedItems.map((item) => item.id),
        )
        .execute();
      await trx
        .updateTable("batch_runs")
        .set((eb) => ({
          status: "running",
          failed_count: eb("failed_count", "-", String(failedItems.length)),
          completed_at: null,
          error: null,
          sink_state: null,
          artifact: null,
          sink_completed_chunks: 0,
          sink_total_chunks: 0,
        }))
        .where("id", "=", args.batchRunId)
        .execute();
      for (const item of failedItems) {
        await this.deps.jobs.enqueue({
          tenantId: args.identity.tenantId,
          kind: "batch_item",
          payload: {
            batchRunId: args.batchRunId,
            itemId: item.id,
            itemAttempt: item.attempt + 1,
          },
          dedupeKey: `batch:${args.batchRunId}:item:${item.id}:manual:${item.attempt + 1}`,
          trx,
        });
      }
    });
    return this.get(args);
  }

  private async applyFailurePolicy(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<boolean> {
    const run = await this.get(args);
    const policy = parseFailurePolicy(run.failurePolicy);
    const limitReached =
      policy.mode === "fail_fast" ||
      (policy.maxFailures !== undefined &&
        run.failedCount >= policy.maxFailures);
    if (!limitReached) return false;
    const now = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("batch_runs")
        .set({
          status: "failed",
          error:
            policy.mode === "fail_fast"
              ? "Batch stopped after the first failed item"
              : `Batch stopped after ${run.failedCount} failed items`,
          completed_at: now,
        })
        .where("id", "=", args.batchRunId)
        .where("status", "in", ["sourcing", "running"])
        .execute();
      await trx
        .updateTable("batch_items")
        .set({
          status: "canceled",
          completed_at: now,
          updated_at: now,
        })
        .where("batch_run_id", "=", args.batchRunId)
        .where("status", "in", ["pending", "waiting"])
        .execute();
    });
    await this.deps.jobs.cancelByDedupePrefix({
      tenantId: args.identity.tenantId,
      dedupePrefix: `batch:${args.batchRunId}:`,
    });
    return true;
  }

  private async finalizeIfComplete(args: {
    identity: Identity;
    batchRunId: string;
  }): Promise<void> {
    const run = await this.get(args);
    const terminal = run.completedCount + run.failedCount + run.skippedCount;
    if (terminal < run.discoveredCount || run.status === "sourcing") return;
    await this.db.transaction().execute(async (trx) => {
      const transitioned = await trx
        .updateTable("batch_runs")
        .set({ status: "sinking" })
        .where("id", "=", args.batchRunId)
        .where("status", "=", "running")
        .returning("id")
        .executeTakeFirst();
      if (!transitioned) return;
      await this.deps.jobs.enqueue({
        tenantId: args.identity.tenantId,
        kind: "batch_sink",
        payload: {
          batchRunId: args.batchRunId,
          operation: "start",
        },
        dedupeKey: `batch:${args.batchRunId}:sink:start`,
        trx,
      });
    });
  }

  async completeSink(args: {
    identity: Identity;
    batchRunId: string;
    artifact?: Json;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "batch.sink.complete",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.batch_run.id": args.batchRunId,
        },
      },
      async (span) => {
        const run = await this.get(args);
        const status =
          run.failedCount > 0 ? "completed_with_errors" : "completed";
        span.setAttribute("catamorphic.project.id", run.projectId);
        span.setAttribute("catamorphic.workflow.name", run.workflowName);
        span.setAttribute("catamorphic.batch_run.status", status);
        await this.db
          .updateTable("batch_runs")
          .set({
            status,
            artifact: jsonColumn(args.artifact),
            completed_at: new Date(),
          })
          .where("id", "=", args.batchRunId)
          .where("status", "=", "sinking")
          .execute();
      },
    );
  }

  async failSink(args: {
    identity: Identity;
    batchRunId: string;
    error: string;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "batch.sink.fail",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.batch_run.id": args.batchRunId,
        },
      },
      async (span) => {
        const run = await this.get(args);
        span.setAttribute("catamorphic.project.id", run.projectId);
        span.setAttribute("catamorphic.workflow.name", run.workflowName);
        await this.db
          .updateTable("batch_runs")
          .set({
            status: "failed",
            error: args.error,
            completed_at: new Date(),
          })
          .where("id", "=", args.batchRunId)
          .where("status", "=", "sinking")
          .execute();
      },
    );
  }

  private async scheduleSourcePage(args: {
    identity: Identity;
    batchRunId: string;
    lowWaterMark?: number;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const run = await trx
        .selectFrom("batch_runs")
        .where("id", "=", args.batchRunId)
        .select([
          "status",
          "source_done",
          "source_page_queued",
          "source_cursor",
        ])
        .forUpdate()
        .executeTakeFirst();
      if (
        !run ||
        run.source_done ||
        run.source_page_queued ||
        (run.status !== "sourcing" && run.status !== "running")
      ) {
        return;
      }
      const backlog = await trx
        .selectFrom("batch_items")
        .where("batch_run_id", "=", args.batchRunId)
        .where("status", "in", ["pending", "running", "waiting"])
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      if (Number(backlog.count) >= (args.lowWaterMark ?? 500)) return;

      const nextCursorKey = await cursorKey(run.source_cursor ?? undefined);
      await this.deps.jobs.enqueue({
        tenantId: args.identity.tenantId,
        kind: "batch_source",
        payload: {
          batchRunId: args.batchRunId,
          operation: "read_page",
        },
        dedupeKey: `batch:${args.batchRunId}:source:${nextCursorKey}`,
        trx,
      });
      await trx
        .updateTable("batch_runs")
        .set({ source_page_queued: true })
        .where("id", "=", args.batchRunId)
        .execute();
    });
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const project = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!project) throw new ProjectNotFoundError(projectId);
  }
}

async function cursorKey(cursor: Json | undefined): Promise<string> {
  if (cursor === undefined) return "done";
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isTerminalItemStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "canceled"
  );
}

function mapBatchRun(row: BatchRunRow): BatchRun {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowName: row.workflow_name,
    deploymentArtifactId: row.deployment_artifact_id,
    mode: row.mode === "test" ? "test" : "production",
    initiatedBy: row.external_user_id,
    status: parseBatchRunStatus(row.status),
    triggerData: row.trigger_data,
    sourceSnapshot: row.source_snapshot,
    sourceCursor: row.source_cursor,
    sourceConsistency: row.source_consistency,
    estimatedCount:
      row.estimated_count === null ? null : Number(row.estimated_count),
    discoveredCount: Number(row.discovered_count),
    completedCount: Number(row.completed_count),
    failedCount: Number(row.failed_count),
    skippedCount: Number(row.skipped_count),
    failurePolicy: row.failure_policy,
    artifact: row.artifact,
    sinkCompletedChunks: Number(row.sink_completed_chunks),
    sinkTotalChunks: Number(row.sink_total_chunks),
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapBatchItem(row: BatchItemRow): BatchItem {
  return {
    id: row.id,
    batchRunId: row.batch_run_id,
    key: row.item_key,
    sourceOrder: Number(row.source_order),
    status: parseBatchItemStatus(row.status),
    value: row.value,
    valueReference: row.value_reference,
    output: row.output,
    outputReference: row.output_reference,
    error: row.error,
    currentNodeId: row.current_node_id,
    availableAt: row.available_at.toISOString(),
    attempt: row.attempt,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function parseBatchRunStatus(value: string): BatchRunStatus {
  if (
    value === "pending" ||
    value === "sourcing" ||
    value === "running" ||
    value === "paused" ||
    value === "sinking" ||
    value === "completed" ||
    value === "completed_with_errors" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`Unknown batch run status: ${value}`);
}

function parseBatchItemStatus(value: string): BatchItemStatus {
  if (
    value === "pending" ||
    value === "running" ||
    value === "waiting" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped" ||
    value === "canceled"
  ) {
    return value;
  }
  throw new Error(`Unknown batch item status: ${value}`);
}

function jsonColumn(value: Json | undefined) {
  return value === undefined
    ? null
    : sql<Json>`${JSON.stringify(value)}::jsonb`;
}

function parseFailurePolicy(value: Json | null): BatchFailurePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { mode: "continue" };
  }
  const mode = value.mode === "fail_fast" ? "fail_fast" : "continue";
  const maxFailures =
    typeof value.maxFailures === "number" &&
    Number.isInteger(value.maxFailures) &&
    value.maxFailures > 0
      ? value.maxFailures
      : undefined;
  return { mode, maxFailures };
}

function runtimeInvocationId(job: {
  id: string;
  kind: string;
  payload: Json;
}): string {
  const payload =
    typeof job.payload === "object" &&
    job.payload !== null &&
    !Array.isArray(job.payload)
      ? job.payload
      : {};
  const operation =
    typeof payload.operation === "string" ? payload.operation : undefined;
  if (job.kind === "batch_source") {
    return `${job.id}:${operation === "initialize" ? "initialize" : "read-page"}`;
  }
  if (job.kind === "batch_item") return `${job.id}:process`;
  if (job.kind === "batch_step") return `${job.id}:batch`;
  if (job.kind === "batch_sink") return `${job.id}:${operation ?? "start"}`;
  return job.id;
}
