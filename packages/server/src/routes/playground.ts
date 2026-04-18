import type { DB, JsonObject } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import {
  DEFAULT_TENANT_ID,
  getExternalUserId,
  SYSTEM_AUTHOR,
} from "../identity.js";
import {
  ErrorSchema,
  PlaygroundRunRequestSchema,
  PlaygroundRunResponseSchema,
} from "../schemas.js";
import { PlaygroundExecutor } from "../services/playground-executor.js";

export function registerPlaygroundRoutes(
  app: FastifyInstance,
  db?: Kysely<DB>,
  sandboxProvider?: SandboxProvider,
  projectManager?: ProjectManager,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/playground/run",
    schema: {
      body: PlaygroundRunRequestSchema,
      response: {
        200: PlaygroundRunResponseSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!sandboxProvider) {
        return reply.status(503).send({
          error:
            "Sandbox provider not configured. Set CLOUDFLARE_SANDBOX_API_URL and CLOUDFLARE_SANDBOX_API_KEY (recommended) or DAYTONA_API_KEY to enable workflow execution.",
        });
      }

      const { projectId, files, workflowName, triggerData } = request.body;
      const externalUserId = getExternalUserId(request);

      let resolvedFiles = files;
      let commitSha: string | null = null;

      if (projectId && projectManager) {
        const repo = await projectManager.openDev(
          DEFAULT_TENANT_ID,
          projectId,
          externalUserId,
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

      const executor = new PlaygroundExecutor(sandboxProvider);
      const result = await executor.execute({
        files: resolvedFiles,
        workflowName,
        triggerData,
        commitSha,
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
