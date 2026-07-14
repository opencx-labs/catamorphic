import { createDatabase, migrateToLatest } from "@catamorphic/db";
import type {
  RuntimeInvocationReceipt,
  RuntimeTerminalResult,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BatchExecutionService } from "../services/batch-execution-service.js";
import { BatchRunsService } from "../services/batch-runs-service.js";
import type { DeploymentArtifact } from "../services/deployment-artifacts-service.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { ExecutionWorkerService } from "../services/execution-worker-service.js";
import { RateReservationsService } from "../services/rate-reservations-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_batch_execution_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const jobs = new ExecutionJobsService(db);
const worker = new ExecutionWorkerService(jobs);
const rateReservations = new RateReservationsService(db);
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const artifactId = crypto.randomUUID();
const identity = {
  tenantId,
  externalUserId: "batch-execution-user",
};
const artifact: DeploymentArtifact = {
  id: artifactId,
  projectId,
  commitSha: "d".repeat(40),
  artifactDigest: "e".repeat(64),
  pluginDigest: "f".repeat(64),
  transformVersion: "test-transform",
  runtimeVersion: "test-runtime",
  status: "ready",
  createdAt: new Date().toISOString(),
  readyAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
};
const batchRuns = new BatchRunsService(db, {
  jobs,
  resolveProductionArtifact: async () => artifact,
  getWorkflowKind: async () => "batch",
});
const physicalBatches: string[][] = [];
const sinkChunks: string[][] = [];
let physicalAttempt = 0;

new BatchExecutionService(db, {
  batchRuns,
  jobs,
  rateReservations,
  worker,
  invokeRuntime: async (args) => {
    if (args.kind === "batch-source" && args.operation === "initialize") {
      return receipt({
        invocationId: args.invocationId,
        terminal: completed({
          snapshot: { highWaterMark: 2 },
          cursor: 0,
          estimatedCount: 2,
          consistency: "snapshot",
        }),
      });
    }
    if (args.kind === "batch-source" && args.operation === "readPage") {
      return receipt({
        invocationId: args.invocationId,
        terminal: completed({
          items: [
            { key: "feedback-1", value: { text: "great" } },
            { key: "feedback-2", value: { text: "bad" } },
          ],
          nextCursor: 2,
          done: true,
        }),
      });
    }
    if (
      args.kind === "batch-step" &&
      args.operation === "process" &&
      args.exportName === undefined
    ) {
      const input = record(args.input);
      const replay = record(input.replay);
      const item = record(input.item);
      const replayed = replay["batch-node:0"];
      if (typeof replayed === "string") {
        return receipt({
          invocationId: args.invocationId,
          terminal: completed({ category: replayed }),
        });
      }
      return receipt({
        invocationId: args.invocationId,
        terminal: {
          status: "suspended",
          suspension: {
            nodeId: "batch-node",
            name: "Classify Feedback",
            functionName: "classifyFeedback",
            input: item,
            policy: {
              maxItems: 2,
              maxWaitMs: 200,
              rateLimits: [
                {
                  globalKey: "feedback-classifier",
                  capacity: 100,
                  refillRatePerSecond: 1,
                },
              ],
            },
          },
          steps: [],
        },
      });
    }
    if (
      args.kind === "batch-step" &&
      args.operation === "run" &&
      args.exportName === "classifyFeedback"
    ) {
      const items = record(args.input).items;
      if (!Array.isArray(items)) throw new Error("Expected physical items");
      const keys = items.map((item) => String(record(item).key));
      physicalBatches.push(keys);
      physicalAttempt += 1;
      return receipt({
        invocationId: args.invocationId,
        terminal: completed(
          items.map((item, index) => {
            const member = record(item);
            const key = String(member.key);
            if (physicalAttempt === 1 && index === 1) {
              return {
                key,
                status: "failed",
                error: {
                  message: "deterministic fail once",
                  retryable: true,
                },
              };
            }
            return {
              key,
              status: "succeeded",
              result: key === "feedback-1" ? "positive" : "negative",
            };
          }),
        ),
      });
    }
    if (args.kind === "batch-sink" && args.operation === "inspect") {
      return receipt({
        invocationId: args.invocationId,
        terminal: completed({ present: true, hasInitialize: true }),
      });
    }
    if (args.kind === "batch-sink" && args.operation === "initialize") {
      return receipt({
        invocationId: args.invocationId,
        terminal: completed({ written: 0 }),
      });
    }
    if (args.kind === "batch-sink" && args.operation === "writeBatch") {
      const input = record(args.input);
      const records = input.records;
      if (!Array.isArray(records)) throw new Error("Expected sink records");
      const keys = records.map((entry) => String(record(entry).key));
      sinkChunks.push(keys);
      return receipt({
        invocationId: args.invocationId,
        terminal: completed({
          state: { written: keys.length },
          acknowledgedKeys: keys,
        }),
      });
    }
    if (args.kind === "batch-sink" && args.operation === "finalize") {
      return receipt({
        invocationId: args.invocationId,
        terminal: completed({
          fileName: "feedback-analysis.json",
          itemCount: 2,
        }),
      });
    }
    throw new Error(
      `Unexpected invocation ${args.kind}:${args.operation ?? "none"}`,
    );
  },
});

describeIf("BatchExecutionService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Batch execution tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        tenant_id: tenantId,
        name: "Batch execution project",
      })
      .execute();
    await db
      .insertInto("deployment_artifacts")
      .values({
        id: artifactId,
        project_id: projectId,
        commit_sha: artifact.commitSha,
        artifact_digest: artifact.artifactDigest,
        plugin_digest: artifact.pluginDigest,
        transform_version: artifact.transformVersion,
        runtime_version: artifact.runtimeVersion,
        status: "ready",
      })
      .execute();
  });

  afterAll(async () => {
    worker.stopAll();
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("pages, coalesces, retries unresolved members, and resumes items", async () => {
    const run = await batchRuns.triggerProduction({
      identity,
      projectId,
      workflowName: "analyzeFeedback",
    });
    const workerId = worker.start({
      workerId: "batch-execution-worker",
      concurrency: 3,
      pollIntervalMs: 5,
      leaseSeconds: 5,
    });

    await vi.waitFor(
      async () => {
        const current = await batchRuns.get({
          identity,
          batchRunId: run.id,
        });
        expect(current.status).toBe("completed");
      },
      { timeout: 5_000, interval: 20 },
    );
    worker.stop({ workerId });

    const completed = await batchRuns.get({
      identity,
      batchRunId: run.id,
    });
    const items = await batchRuns.listItems({
      identity,
      batchRunId: run.id,
    });
    expect(completed).toMatchObject({
      discoveredCount: 2,
      completedCount: 2,
      failedCount: 0,
      artifact: {
        fileName: "feedback-analysis.json",
        itemCount: 2,
      },
    });
    expect(items.items.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(physicalBatches).toEqual([
      ["feedback-1", "feedback-2"],
      ["feedback-2"],
    ]);
    expect(sinkChunks).toEqual([["feedback-1", "feedback-2"]]);
    const reservation = await db
      .selectFrom("rate_reservation_buckets")
      .where("tenant_id", "=", tenantId)
      .where("global_key", "=", "feedback-classifier")
      .select("global_key")
      .executeTakeFirst();
    expect(reservation?.global_key).toBe("feedback-classifier");
  }, 15_000);
});

function receipt(args: {
  invocationId: string;
  terminal: RuntimeTerminalResult;
}): RuntimeInvocationReceipt {
  return {
    runtimeId: "test-runtime",
    invocationId: args.invocationId,
    events: [],
    terminal: args.terminal,
  };
}

function completed(result: unknown): RuntimeTerminalResult {
  return {
    status: "completed",
    result,
    steps: [],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return Object.fromEntries(Object.entries(value));
}
