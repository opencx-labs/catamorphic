import type { DB } from "@catamorphic/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely, Selectable } from "kysely";
import {
  ErrorSchema,
  RunDetailSchema,
  RunIdParamsSchema,
  RunReportSchema,
  RunSchema,
} from "../schemas.js";

type RunRow = Selectable<DB["workflow_runs"]>;
type StepRow = Selectable<DB["workflow_run_steps"]>;

function mapRun(row: RunRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowName: row.workflow_name,
    commitSha: row.commit_sha,
    isTest: row.is_test,
    status: row.status as
      | "pending"
      | "running"
      | "completed"
      | "failed"
      | "cancelled",
    triggerData: row.trigger_data,
    result: row.result,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapStep(row: StepRow) {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    name: row.name,
    status: row.status as
      | "pending"
      | "running"
      | "completed"
      | "failed"
      | "skipped",
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export function registerRunRoutes(app: FastifyInstance, db?: Kysely<DB>) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/runs/:runId",
    schema: {
      params: RunIdParamsSchema,
      response: { 200: RunDetailSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!db)
        return reply.status(503).send({ error: "Service not configured" });

      const { runId } = request.params;

      const run = await db
        .selectFrom("workflow_runs")
        .where("id", "=", runId)
        .selectAll()
        .executeTakeFirst();

      if (!run) return reply.status(404).send({ error: "Run not found" });

      const steps = await db
        .selectFrom("workflow_run_steps")
        .where("run_id", "=", runId)
        .selectAll()
        .orderBy("started_at", "asc")
        .execute();

      return reply.send({ ...mapRun(run), steps: steps.map(mapStep) });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/runs/:runId/cancel",
    schema: {
      params: RunIdParamsSchema,
      response: { 200: RunSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/runs/:runId/report",
    schema: {
      params: RunIdParamsSchema,
      body: RunReportSchema,
      response: { 200: RunDetailSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });
}
