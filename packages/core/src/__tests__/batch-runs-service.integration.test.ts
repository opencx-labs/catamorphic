import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchRunsService } from "../services/batch-runs-service.js";
import type { DeploymentArtifact } from "../services/deployment-artifacts-service.js";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_batch_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });
const jobs = new ExecutionJobsService(db);
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const artifactId = crypto.randomUUID();
const identity = {
  tenantId,
  externalUserId: "batch-test-user",
};
const artifact: DeploymentArtifact = {
  id: artifactId,
  projectId,
  commitSha: "a".repeat(40),
  artifactDigest: "b".repeat(64),
  pluginDigest: "c".repeat(64),
  transformVersion: "test-transform",
  runtimeVersion: "test-runtime",
  status: "ready",
  createdAt: new Date().toISOString(),
  readyAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
};
const service = new BatchRunsService(db, {
  jobs,
  resolveProductionArtifact: async () => artifact,
  getWorkflowKind: async () => "batch",
});

describeIf("BatchRunsService integration", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Batch test tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({
        id: projectId,
        tenant_id: tenantId,
        name: "Batch test project",
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
    await sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).execute(db);
    await db.destroy();
  });

  it("materializes deduplicated items and finalizes partial outcomes", async () => {
    const run = await service.triggerProduction({
      identity,
      projectId,
      workflowName: "analyzeFeedback",
      triggerData: { after: "2026-01-01" },
    });
    expect(run.status).toBe("pending");
    expect(run.deploymentArtifactId).toBe(artifactId);

    await service.initializeSource({
      identity,
      batchRunId: run.id,
      snapshot: { highWaterMark: 2 },
      consistency: "snapshot",
      estimatedCount: 2,
    });
    const page = await service.acceptSourcePage({
      identity,
      batchRunId: run.id,
      items: [
        { key: "feedback-1", value: { text: "Great" } },
        { key: "feedback-2", value: { text: "Broken" } },
      ],
      done: true,
    });
    const duplicate = await service.acceptSourcePage({
      identity,
      batchRunId: run.id,
      items: [{ key: "feedback-1", value: { text: "Great" } }],
      done: true,
    });
    expect(page.accepted).toBe(2);
    expect(duplicate.accepted).toBe(0);

    const items = await service.listItems({
      identity,
      batchRunId: run.id,
    });
    expect(items.total).toBe(2);
    const first = items.items[0];
    const second = items.items[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("Expected two batch items");

    await service.completeItem({
      identity,
      batchRunId: run.id,
      itemId: first.id,
      status: "succeeded",
      output: { category: "positive" },
    });
    await service.completeItem({
      identity,
      batchRunId: run.id,
      itemId: second.id,
      status: "failed",
      error: "Classification failed",
    });
    expect(
      (
        await service.get({
          identity,
          batchRunId: run.id,
        })
      ).status,
    ).toBe("sinking");
    await service.completeSink({
      identity,
      batchRunId: run.id,
      artifact: { report: "feedback-analysis.json" },
    });

    const completed = await service.get({
      identity,
      batchRunId: run.id,
    });
    expect(completed).toMatchObject({
      status: "completed_with_errors",
      discoveredCount: 2,
      completedCount: 1,
      failedCount: 1,
      artifact: { report: "feedback-analysis.json" },
    });

    const retrying = await service.retryFailedItems({
      identity,
      batchRunId: run.id,
    });
    expect(retrying).toMatchObject({
      status: "running",
      failedCount: 0,
      artifact: null,
    });
    await service.completeItem({
      identity,
      batchRunId: run.id,
      itemId: second.id,
      status: "succeeded",
      output: { category: "negative" },
    });
    await service.completeSink({
      identity,
      batchRunId: run.id,
      artifact: { report: "feedback-analysis-retried.json" },
    });
    expect(
      await service.get({
        identity,
        batchRunId: run.id,
      }),
    ).toMatchObject({
      status: "completed",
      completedCount: 2,
      failedCount: 0,
    });
  });

  it("pauses, resumes, and cancels without touching terminal runs", async () => {
    const run = await service.triggerProduction({
      identity,
      projectId,
      workflowName: "analyzeFeedback",
    });
    await service.initializeSource({
      identity,
      batchRunId: run.id,
      snapshot: {},
      consistency: "bounded",
    });
    expect(
      (
        await service.pause({
          identity,
          batchRunId: run.id,
        })
      ).status,
    ).toBe("paused");
    expect(
      (
        await service.resume({
          identity,
          batchRunId: run.id,
        })
      ).status,
    ).toBe("sourcing");
    expect(
      (
        await service.cancel({
          identity,
          batchRunId: run.id,
        })
      ).status,
    ).toBe("canceled");
  });

  it("stops future work when the failure threshold is reached", async () => {
    const run = await service.triggerProduction({
      identity,
      projectId,
      workflowName: "analyzeFeedback",
      failurePolicy: { mode: "continue", maxFailures: 1 },
    });
    await service.initializeSource({
      identity,
      batchRunId: run.id,
      snapshot: { highWaterMark: 2 },
      consistency: "snapshot",
    });
    await service.acceptSourcePage({
      identity,
      batchRunId: run.id,
      items: [
        { key: "feedback-threshold-1", value: { text: "Broken" } },
        { key: "feedback-threshold-2", value: { text: "Waiting" } },
      ],
      done: true,
    });
    const items = await service.listItems({
      identity,
      batchRunId: run.id,
    });
    const first = items.items[0];
    if (!first) throw new Error("Expected a batch item");
    await service.completeItem({
      identity,
      batchRunId: run.id,
      itemId: first.id,
      status: "failed",
      error: "Threshold failure",
    });

    expect(
      await service.get({
        identity,
        batchRunId: run.id,
      }),
    ).toMatchObject({
      status: "failed",
      failedCount: 1,
    });
  });
});
