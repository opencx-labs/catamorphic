import { randomUUID } from "node:crypto";
import { type DB, migrateToLatest } from "@catamorphic/db";
import { getTracer, withSpan, withTelemetryContext } from "@catamorphic/otel";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { context, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExecutionJobsService } from "../services/execution-jobs-service.js";
import { ExecutionWorkerService } from "../services/execution-worker-service.js";

const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin("job_telemetry")],
});
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tenantId = randomUUID();
const projectId = randomUUID();
const runId = randomUUID();
beforeAll(async () => {
  provider.register();
  await migrateToLatest({ db, schema: "job_telemetry" });
  await db
    .insertInto("tenants")
    .values({ id: tenantId, name: "tenant" })
    .execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: tenantId, name: "project" })
    .execute();
  await db
    .insertInto("workflow_runs")
    .values({
      id: runId,
      project_id: projectId,
      workflow_name: "process",
      provenance: { commitSha: "a".repeat(40) },
      external_user_id: "persisted-user",
    })
    .execute();
});
afterAll(async () => {
  await Promise.all([db.destroy(), provider.shutdown()]);
  trace.disable();
  context.disable();
});

it("reconstructs correlation for claimed jobs, including retries, without inheriting the worker caller", async () => {
  const jobs = new ExecutionJobsService(db);
  const queued = await jobs.enqueue({
    tenantId,
    workflowRunId: runId,
    kind: "durable_boundary",
    payload: { "user.id": "spoofed" },
  });
  for (const attempt of [1, 2]) {
    // A fresh service models a new worker process resuming the persisted job.
    const worker = new ExecutionWorkerService(new ExecutionJobsService(db));
    worker.registerHandler({
      kind: "durable_boundary",
      handler: async () => {
        await withSpan(
          { tracer: getTracer("job-test"), name: `nested-${attempt}` },
          async () => {
            if (attempt === 1) throw new Error("retry");
          },
        );
      },
    });
    const claimed = await jobs.claimById({
      jobId: queued.id,
      workerId: "worker",
      leaseSeconds: 60,
    });
    expect(claimed?.attempt).toBe(attempt);
    if (!claimed) throw new Error("Expected claim");
    await withTelemetryContext(
      {
        attributes: {
          "catamorphic.tenant.id": "wrong-tenant",
          "catamorphic.project.id": "wrong-project",
          "user.id": "wrong-user",
          "catamorphic.agent.session.id": "unrelated",
        },
      },
      () =>
        worker.runClaimedJob({
          job: claimed,
          workerId: "worker",
          leaseSeconds: 60,
          signal: new AbortController().signal,
        }),
    );
    // Make the retry available without sleeping through its production backoff.
    if (attempt === 1)
      await db
        .updateTable("execution_jobs")
        .set({ available_at: new Date(0) })
        .where("id", "=", queued.id)
        .execute();
    const nested = exporter
      .getFinishedSpans()
      .find((span) => span.name === `nested-${attempt}`);
    expect(nested?.attributes).toMatchObject({
      "catamorphic.tenant.id": tenantId,
      "catamorphic.project.id": projectId,
      "user.id": "persisted-user",
      "catamorphic.workflow.name": "process",
      "catamorphic.run.id": runId,
      "catamorphic.queue.job.id": queued.id,
      "catamorphic.queue.job.attempt": attempt,
    });
    expect(nested?.attributes["catamorphic.agent.session.id"]).toBeUndefined();
  }
  const roots = exporter
    .getFinishedSpans()
    .filter((span) => span.name === "queue.process");
  expect(roots).toHaveLength(2);
  expect(
    roots.every(
      (span) => span.attributes["catamorphic.project.id"] === projectId,
    ),
  ).toBe(true);
  expect(
    roots.map((span) => span.attributes["catamorphic.queue.job.outcome"]),
  ).toEqual(["failed", "completed"]);
});
