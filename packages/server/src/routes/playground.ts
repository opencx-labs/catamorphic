import { PlaygroundExecutor, SYSTEM_AUTHOR } from "@catamorphic/core";
import type { DB, JsonObject } from "@catamorphic/db";
import { layoutGraph, parseWorkflowFromProject } from "@catamorphic/parser";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  PlaygroundParseRequestSchema,
  PlaygroundParseResponseSchema,
  PlaygroundRunRequestSchema,
  PlaygroundRunResponseSchema,
} from "../schemas.js";

export function registerPlaygroundRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/playground/parse",
    schema: {
      body: PlaygroundParseRequestSchema,
      response: {
        200: PlaygroundParseResponseSchema,
      },
    },
    handler: async (request, reply) => {
      // Parse is a pure CPU operation over in-memory files; no DB, no repo,
      // no identity required. We just need a server because ts-morph pulls in
      // `node:fs` which cannot run in a browser bundle.
      const { files, workflowName, preferredFilePath } = request.body;
      const graph = parseWorkflowFromProject(files, workflowName, {
        preferredFilePath,
      });
      if (!graph) return reply.send(null);
      layoutGraph({ nodes: graph.nodes, edges: graph.edges });
      return reply.send(graph);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/playground/run",
    schema: {
      body: PlaygroundRunRequestSchema,
      response: {
        200: PlaygroundRunResponseSchema,
        400: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core?.sandboxProvider) {
        return reply.status(503).send({
          error:
            "Sandbox provider not configured. Set CLOUDFLARE_SANDBOX_API_URL and CLOUDFLARE_SANDBOX_API_KEY (recommended) or DAYTONA_API_KEY to enable workflow execution.",
        });
      }

      const identity = resolveIdentity(request);
      const { projectId, files, workflowName, triggerData } = request.body;

      let resolvedFiles = files;
      let commitSha: string | null = null;

      if (projectId) {
        const repo = await ctx.core.projectManager.openDev(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        try {
          for (const [filePath, content] of Object.entries(files)) {
            await repo.writeFile(filePath, content);
          }
          const sha = await repo.commit(
            `Test run ${new Date().toISOString()}`,
            SYSTEM_AUTHOR,
          );
          commitSha = sha;
          resolvedFiles = await repo.readAllFiles();
        } finally {
          await repo.dispose();
        }
      }

      let runId: string | null = null;
      const db: Kysely<DB> | undefined = ctx.core.db;

      if (projectId && commitSha && db) {
        runId = crypto.randomUUID();
        await db
          .insertInto("workflow_runs")
          .values({
            id: runId,
            project_id: projectId,
            workflow_name: workflowName,
            commit_sha: commitSha,
            is_test: true,
            status: "running",
            trigger_data: (triggerData ?? null) as JsonObject | null,
            started_at: new Date(),
          })
          .execute();
      }

      let plugins:
        | Awaited<
            ReturnType<NonNullable<typeof ctx.core.runPluginsLoader>["load"]>
          >
        | undefined;
      if (projectId && ctx.core.runPluginsLoader) {
        plugins = await ctx.core.runPluginsLoader.load(projectId);
        if (plugins.missingRequiredSecrets.length > 0) {
          return reply.status(400).send({
            error: `Missing required plugin secrets: ${plugins.missingRequiredSecrets.join(
              ", ",
            )}. Set them in the project settings before running.`,
          });
        }
      }

      const executor = new PlaygroundExecutor(ctx.core.sandboxProvider);
      const result = await executor.execute({
        files: resolvedFiles,
        workflowName,
        triggerData,
        commitSha,
        plugins: plugins?.plugins,
        secrets: plugins?.secrets,
      });

      if (runId && db) {
        await db
          .updateTable("workflow_runs")
          .set({
            status: result.status,
            result: (result.result ?? null) as JsonObject | null,
            error: result.error ?? null,
            completed_at: new Date(result.completedAt),
          })
          .where("id", "=", runId)
          .execute();

        if (result.steps.length > 0) {
          await db
            .insertInto("workflow_run_steps")
            .values(
              result.steps.map((step) => ({
                id: crypto.randomUUID(),
                run_id: runId as string,
                node_id: step.nodeId,
                name: step.name,
                status: step.status,
                input: (step.input ?? null) as JsonObject | null,
                output: (step.output ?? null) as JsonObject | null,
                error: step.error ?? null,
                started_at: new Date(step.startedAt),
                completed_at: new Date(step.completedAt),
              })),
            )
            .execute();
        }
      }

      return reply.status(200).send({ runId, ...result });
    },
  });
}
