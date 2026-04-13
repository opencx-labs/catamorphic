import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import {
  layoutGraph,
  parseProject,
  parseWorkflowFromProject,
} from "@catamorphic/parser";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely, Selectable } from "kysely";
import {
  ErrorSchema,
  ListSchema,
  PaginationQuerySchema,
  RefQuerySchema,
  RunSchema,
  TriggerRunSchema,
  WorkflowGraphSchema,
  WorkflowNameParamsSchema,
  WorkflowSummarySchema,
} from "../schemas.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

type RunRow = Selectable<DB["workflow_runs"]>;

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

export function registerWorkflowRoutes(
  app: FastifyInstance,
  db?: Kysely<DB>,
  projectManager?: ProjectManager,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows",
    schema: {
      params: WorkflowNameParamsSchema.pick({ projectId: true }),
      querystring: RefQuerySchema,
      response: {
        200: WorkflowSummarySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;

      const exists = await db
        .selectFrom("projects")
        .where("id", "=", projectId)
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .select("id")
        .executeTakeFirst();

      if (!exists)
        return reply.status(404).send({ error: "Project not found" });

      const repo = await projectManager.open(DEFAULT_TENANT_ID, projectId);
      try {
        const files = await repo.readAllFiles();
        const { workflows } = parseProject(files);
        return reply.send(
          workflows.map((wf) => ({
            name: wf.functionName,
            displayName: wf.graph.displayName ?? null,
            description: wf.graph.description ?? null,
            filePath: wf.filePath,
            parameterCount: wf.graph.trigger.parameters.length,
          })),
        );
      } finally {
        await repo.dispose();
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows/:name",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: RefQuerySchema,
      response: {
        200: WorkflowGraphSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId, name } = request.params;

      const exists = await db
        .selectFrom("projects")
        .where("id", "=", projectId)
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .select("id")
        .executeTakeFirst();

      if (!exists)
        return reply.status(404).send({ error: "Project not found" });

      const repo = await projectManager.open(DEFAULT_TENANT_ID, projectId);
      try {
        const allFiles = await repo.readAllFiles();
        const graph = parseWorkflowFromProject(allFiles, name);

        if (!graph) {
          return reply.status(404).send({ error: "Workflow not found" });
        }

        layoutGraph({ nodes: graph.nodes, edges: graph.edges });

        return reply.send({
          ...graph,
          filePath: graph.filePath ?? "",
          displayName: graph.displayName ?? null,
          description: graph.description ?? null,
          trigger: {
            parameters: graph.trigger.parameters.map((p) => ({
              name: p.name,
              type: p.type,
              displayName: p.displayName ?? null,
              description: p.description ?? null,
              required: !p.optional,
              defaultValue: p.defaultValue ?? null,
            })),
          },
          projectFiles: Object.keys(allFiles),
          allFiles,
        });
      } finally {
        await repo.dispose();
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      body: TriggerRunSchema,
      response: { 201: RunSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workflows/:name/runs",
    schema: {
      params: WorkflowNameParamsSchema,
      querystring: PaginationQuerySchema,
      response: {
        200: ListSchema(RunSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId, name } = request.params;
      const { limit, offset } = request.query;

      const rows = await db
        .selectFrom("workflow_runs")
        .where("project_id", "=", projectId)
        .where("workflow_name", "=", name)
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute();

      const total = await db
        .selectFrom("workflow_runs")
        .where("project_id", "=", projectId)
        .where("workflow_name", "=", name)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.count));

      return reply.send({ items: rows.map(mapRun), total });
    },
  });
}
