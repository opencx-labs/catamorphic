import {
  type Project,
  ProjectFileNotFoundError,
  ProjectNotFoundError,
  type WorkflowSummary,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
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

/**
 * HTTP-facing shape of a project. Drops `tenantId` because the header already
 * scopes the caller and the dashboard never renders it.
 */
function toDto(project: Project) {
  return {
    id: project.id,
    name: project.name,
    storageType: project.storageType,
    remoteUrl: project.remoteUrl,
    defaultBranch: project.defaultBranch,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/projects",
    schema: {
      body: CreateProjectSchema,
      response: { 201: ProjectSchema, 400: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const project = await ctx.core.projects.create(identity, request.body);
      return reply.status(201).send(toDto(project));
    },
  });

  typed.route({
    method: "GET",
    url: "/projects",
    schema: {
      querystring: PaginationQuerySchema,
      response: { 200: ListSchema(ProjectSchema) },
    },
    handler: async (request, reply) => {
      if (!ctx.core) return reply.send({ items: [], total: 0 });
      const identity = resolveIdentity(request);
      const result = await ctx.core.projects.list(identity, request.query);
      return reply.send({
        items: result.items.map(toDto),
        total: result.total,
      });
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: ProjectDetailSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;

      try {
        const project = await ctx.core.projects.get(identity, projectId);
        const summary = await safeListWorkflows(ctx.core, identity, projectId);
        return reply.send({
          ...toDto(project),
          workflows: summary.workflows,
          files: summary.files,
        });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "PATCH",
    url: "/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      body: UpdateProjectSchema,
      response: { 200: ProjectSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const project = await ctx.core.projects.update(
          identity,
          request.params.projectId,
          request.body,
        );
        return reply.send(toDto(project));
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: z.object({ deleted: z.boolean() }),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        await ctx.core.projects.delete(identity, request.params.projectId);
        return reply.send({ deleted: true });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/files",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: FileEntrySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      try {
        const entries = await ctx.core.projects.listFiles(
          identity,
          request.params.projectId,
        );
        return reply.send(entries);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/files/*",
    schema: {
      params: ProjectFileParamsSchema,
      response: { 200: FileContentSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      const filePath = request.params["*"];
      try {
        const content = await ctx.core.projects.readFile(
          identity,
          projectId,
          filePath,
        );
        return reply.send({ path: filePath, content });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        if (err instanceof ProjectFileNotFoundError) {
          return reply.status(404).send({ error: "File not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/files/*",
    schema: {
      params: ProjectFileParamsSchema,
      body: WriteFileSchema,
      response: { 200: FileContentSchema, 404: ErrorSchema, 503: ErrorSchema },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      const filePath = request.params["*"];
      try {
        const content = await ctx.core.projects.writeFile(
          identity,
          projectId,
          filePath,
          request.body,
        );
        return reply.send({ path: filePath, content });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/commits",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const commits = await ctx.core.deployment.listCommits(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          { maxCount: request.query.limit },
        );
        return reply.send({ items: commits, total: commits.length });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/status",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: RepoStatusSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const status = await ctx.core.deployment.getStatus(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        return reply.send(status);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/branches",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: BranchInfoSchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const branches = await ctx.core.deployment.listBranches(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        return reply.send(branches);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/branches",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const result = await ctx.core.deployment.ensureWorkBranch(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/checkout",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const status = await ctx.core.deployment.checkoutBranch(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          request.body.ref,
        );
        return reply.send({ ...status, remoteHeadTimestamp: null });
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/workdir",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: DiffEntrySchema.array(),
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const diff = await ctx.core.deployment.workdirDiff(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        return reply.send(diff);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/diff",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const diff = await ctx.core.deployment.diffRefs(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          request.query.base,
          request.query.head,
        );
        return reply.send(diff);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/deploy",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const result = await ctx.core.deployment.deploy(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          { message: request.body.message, files: request.body.files },
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/pull",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const result = await ctx.core.deployment.pullFromRemote(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          { files: request.body.files },
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/discard",
    schema: {
      params: ProjectIdParamsSchema,
      response: {
        200: DiscardResponseSchema,
        404: ErrorSchema,
        503: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const result = await ctx.core.deployment.discardDraft(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/resolve-conflicts",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const result = await ctx.core.deployment.resolveConflicts(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          {
            resolutions: request.body.resolutions,
            message: request.body.message,
          },
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/projects/:projectId/ai-resolve-conflicts",
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
    url: "/projects/:projectId/files-at-ref",
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
      if (!ctx.core)
        return reply.status(503).send({ error: "Service not configured" });
      const identity = resolveIdentity(request);
      const { projectId } = request.params;
      try {
        await ctx.core.projects.get(identity, projectId);
        const files = await ctx.core.deployment.filesAtRef(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          request.query.ref,
        );
        return reply.send(files);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: "Project not found" });
        }
        throw err;
      }
    },
  });
}

async function safeListWorkflows(
  core: NonNullable<RouteContext["core"]>,
  identity: { tenantId: string; externalUserId: string },
  projectId: string,
): Promise<{
  workflows: WorkflowSummary[];
  files: string[];
}> {
  try {
    const workflows = await core.workflows.list({ identity, projectId });
    const allFiles = await core.projects.readAllFiles(identity, projectId);
    return { workflows, files: Object.keys(allFiles) };
  } catch {
    return { workflows: [], files: [] };
  }
}
