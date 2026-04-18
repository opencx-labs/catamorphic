import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { parseProject } from "@catamorphic/parser";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import {
  DEFAULT_TENANT_ID,
  getExternalUserId,
  SYSTEM_AUTHOR,
} from "../identity.js";
import {
  BranchInfoSchema,
  CommitSchema,
  CreateBranchSchema,
  CreateProjectSchema,
  DeployRequestSchema,
  DeployResponseSchema,
  DiffEntrySchema,
  DiscardResponseSchema,
  ErrorSchema,
  FileContentSchema,
  FileEntrySchema,
  ListSchema,
  PaginationQuerySchema,
  ProjectDetailSchema,
  ProjectFileParamsSchema,
  ProjectIdParamsSchema,
  ProjectSchema,
  PullRequestSchema,
  PullResponseSchema,
  RefQuerySchema,
  RepoStatusSchema,
  ResolveConflictsSchema,
  UpdateProjectSchema,
  WriteFileSchema,
} from "../schemas.js";
import { DeploymentService } from "../services/deployment-service.js";
import { findTemplate } from "../templates.js";

type ProjectRow = Selectable<DB["projects"]>;

function mapProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    storageType: row.storage_type as "managed" | "remote",
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function registerProjectRoutes(
  app: FastifyInstance,
  db?: Kysely<DB>,
  projectManager?: ProjectManager,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const deploymentService = projectManager
    ? new DeploymentService(projectManager)
    : undefined;

  async function projectExists(projectId: string): Promise<boolean> {
    if (!db) return false;
    const row = await db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", DEFAULT_TENANT_ID)
      .select("id")
      .executeTakeFirst();
    return Boolean(row);
  }

  typed.route({
    method: "POST",
    url: "/api/projects",
    schema: {
      body: CreateProjectSchema,
      response: { 201: ProjectSchema, 400: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { name, templateId } = request.body;
      const template = templateId ? findTemplate(templateId) : undefined;

      const projectId = crypto.randomUUID();

      await db
        .insertInto("projects")
        .values({
          id: projectId,
          tenant_id: DEFAULT_TENANT_ID,
          name,
          storage_type: "managed",
        })
        .execute();

      await projectManager.create(DEFAULT_TENANT_ID, projectId, {
        name,
        initialFiles: template?.files,
      });

      const row = await db
        .selectFrom("projects")
        .where("id", "=", projectId)
        .selectAll()
        .executeTakeFirstOrThrow();

      return reply.status(201).send(mapProject(row));
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects",
    schema: {
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(ProjectSchema) },
    },
    handler: async (request, reply) => {
      if (!db) return reply.send({ items: [], total: 0 });

      const { limit, offset } = request.query;

      const rows = await db
        .selectFrom("projects")
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute();

      const total = await db
        .selectFrom("projects")
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow()
        .then((r) => Number(r.count));

      return reply.send({ items: rows.map(mapProject), total });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: ProjectDetailSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;

      const row = await db
        .selectFrom("projects")
        .where("id", "=", projectId)
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .selectAll()
        .executeTakeFirst();

      if (!row) return reply.status(404).send({ error: "Project not found" });

      const externalUserId = getExternalUserId(request);
      const parsed = await loadWorkflows(
        projectManager,
        projectId,
        externalUserId,
      );

      return reply.send({
        ...mapProject(row),
        workflows: parsed.workflows,
        files: parsed.files,
      });
    },
  });

  typed.route({
    method: "PATCH",
    url: "/api/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      body: UpdateProjectSchema,
      response: { 200: ProjectSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!db)
        return reply.status(503).send({ error: "Service not configured" });

      const { projectId } = request.params;
      const { name } = request.body;

      const existing = await db
        .selectFrom("projects")
        .where("id", "=", projectId)
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .selectAll()
        .executeTakeFirst();

      if (!existing)
        return reply.status(404).send({ error: "Project not found" });

      const updated = await db
        .updateTable("projects")
        .set({ name: name ?? existing.name, updated_at: new Date() })
        .where("id", "=", projectId)
        .returningAll()
        .executeTakeFirstOrThrow();

      return reply.send(mapProject(updated));
    },
  });

  typed.route({
    method: "DELETE",
    url: "/api/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.object({ deleted: z.boolean() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;

      const existing = await db
        .selectFrom("projects")
        .where("id", "=", projectId)
        .where("tenant_id", "=", DEFAULT_TENANT_ID)
        .select("id")
        .executeTakeFirst();

      if (!existing)
        return reply.status(404).send({ error: "Project not found" });

      await db.deleteFrom("projects").where("id", "=", projectId).execute();
      await projectManager.delete(DEFAULT_TENANT_ID, projectId).catch(() => {});

      return reply.send({ deleted: true });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/files",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: FileEntrySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);

      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });

      const repo = await projectManager.openDev(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      try {
        const filePaths = await repo.listFiles();
        return reply.send(filePaths.map((p) => ({ path: p, size: 0 })));
      } finally {
        await repo.dispose();
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/files/*",
    schema: {
      params: ProjectFileParamsSchema,
      response: { 200: FileContentSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;
      const filePath = request.params["*"];
      const externalUserId = getExternalUserId(request);

      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });

      const repo = await projectManager.openDev(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      try {
        const content = await repo.readFile(filePath);
        return reply.send({ path: filePath, content });
      } catch {
        return reply.status(404).send({ error: "File not found" });
      } finally {
        await repo.dispose();
      }
    },
  });

  typed.route({
    method: "PUT",
    url: "/api/projects/:projectId/files/*",
    schema: {
      params: ProjectFileParamsSchema,
      body: WriteFileSchema,
      response: { 200: FileContentSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;
      const filePath = request.params["*"];
      const { content, commitMessage } = request.body;
      const externalUserId = getExternalUserId(request);

      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });

      const repo = await projectManager.openDev(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      try {
        await repo.writeFile(filePath, content);
        if (commitMessage) {
          await repo.commit(commitMessage, SYSTEM_AUTHOR);
        }
        return reply.send({ path: filePath, content });
      } finally {
        await repo.dispose();
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/commits",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: PaginationQuerySchema,
      response: {
        200: ListSchema(CommitSchema),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!db || !projectManager) {
        return reply.status(503).send({ error: "Service not configured" });
      }

      const { projectId } = request.params;
      const { limit } = request.query;
      const externalUserId = getExternalUserId(request);

      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });

      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const commits = await deploymentService.listCommits(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        { maxCount: limit },
      );
      return reply.send({ items: commits, total: commits.length });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/status",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: RepoStatusSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const status = await deploymentService.getStatus(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      return reply.send(status);
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/branches",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: BranchInfoSchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const branches = await deploymentService.listBranches(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      return reply.send(branches);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/branches",
    schema: {
      params: ProjectIdParamsSchema,
      body: CreateBranchSchema,
      response: {
        200: z.object({ branch: z.string(), created: z.boolean() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const result = await deploymentService.ensureWorkBranch(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      return reply.send(result);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/checkout",
    schema: {
      params: ProjectIdParamsSchema,
      body: z.object({ ref: z.string().min(1) }),
      response: {
        200: RepoStatusSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const status = await deploymentService.checkoutBranch(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        request.body.ref,
      );
      return reply.send({ ...status, remoteHeadTimestamp: null });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/workdir",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: DiffEntrySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const diff = await deploymentService.workdirDiff(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      return reply.send(diff);
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/diff",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        base: z.string().min(1),
        head: z.string().min(1),
      }),
      response: {
        200: DiffEntrySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const diff = await deploymentService.diffRefs(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        request.query.base,
        request.query.head,
      );
      return reply.send(diff);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/deploy",
    schema: {
      params: ProjectIdParamsSchema,
      body: DeployRequestSchema,
      response: {
        200: DeployResponseSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const result = await deploymentService.deploy(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        { message: request.body.message, files: request.body.files },
      );
      return reply.send(result);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/pull",
    schema: {
      params: ProjectIdParamsSchema,
      body: PullRequestSchema,
      response: {
        200: PullResponseSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const result = await deploymentService.pullFromRemote(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        { files: request.body.files },
      );
      return reply.send(result);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/discard",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: DiscardResponseSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const result = await deploymentService.discardDraft(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
      );
      return reply.send(result);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/resolve-conflicts",
    schema: {
      params: ProjectIdParamsSchema,
      body: ResolveConflictsSchema,
      response: {
        200: z.object({ commitSha: z.string() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const result = await deploymentService.resolveConflicts(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        {
          resolutions: request.body.resolutions,
          message: request.body.message,
        },
      );
      return reply.send(result);
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/ai-resolve-conflicts",
    schema: {
      params: ProjectIdParamsSchema,
      body: z.object({
        conflicts: z.array(
          z.object({
            path: z.string(),
            base: z.string().nullable(),
            ours: z.string().nullable(),
            theirs: z.string().nullable(),
          }),
        ),
      }),
      response: {
        200: z.object({
          resolutions: z.record(z.string(), z.string()),
          notes: z.string().optional(),
        }),
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      // Stub: naive "prefer theirs" resolution until Codex-backed resolver lands.
      // Falls back to ours if theirs is null (file deleted upstream we want to keep).
      const resolutions: Record<string, string> = {};
      for (const conflict of request.body.conflicts) {
        const resolved =
          conflict.theirs ?? conflict.ours ?? conflict.base ?? "";
        resolutions[conflict.path] = resolved;
      }
      return reply.send({
        resolutions,
        notes: "Placeholder resolver; prefers remote version.",
      });
    },
  });

  typed.route({
    method: "GET",
    url: "/api/projects/:projectId/files-at-ref",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: RefQuerySchema.extend({ ref: z.string().min(1) }),
      response: {
        200: z.record(z.string(), z.string()),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!deploymentService)
        return reply.status(503).send({ error: "Service not configured" });
      const { projectId } = request.params;
      const externalUserId = getExternalUserId(request);
      if (!(await projectExists(projectId)))
        return reply.status(404).send({ error: "Project not found" });
      const files = await deploymentService.filesAtRef(
        DEFAULT_TENANT_ID,
        projectId,
        externalUserId,
        request.query.ref,
      );
      return reply.send(files);
    },
  });
}

async function loadWorkflows(
  projectManager: ProjectManager,
  projectId: string,
  externalUserId: string,
): Promise<{
  workflows: {
    name: string;
    displayName: string | null;
    description: string | null;
    filePath: string;
    parameterCount: number;
  }[];
  files: string[];
}> {
  try {
    const repo = await projectManager.openDev(
      DEFAULT_TENANT_ID,
      projectId,
      externalUserId,
    );
    try {
      const allFiles = await repo.readAllFiles();
      const files = Object.keys(allFiles);
      const parsed = parseProject(allFiles);
      return {
        files,
        workflows: parsed.workflows.map((wf) => ({
          name: wf.functionName,
          displayName: wf.graph.displayName ?? null,
          description: wf.graph.description ?? null,
          filePath: wf.filePath ?? "",
          parameterCount: wf.graph.trigger.parameters.length,
        })),
      };
    } finally {
      await repo.dispose();
    }
  } catch {
    return { workflows: [], files: [] };
  }
}
