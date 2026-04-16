import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { parseProject } from "@catamorphic/parser";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import {
  CommitSchema,
  CreateProjectSchema,
  ErrorSchema,
  FileContentSchema,
  FileEntrySchema,
  ListSchema,
  PaginationQuerySchema,
  ProjectDetailSchema,
  ProjectFileParamsSchema,
  ProjectIdParamsSchema,
  ProjectSchema,
  SetRemoteSchema,
  UpdateProjectSchema,
  WriteFileSchema,
} from "../schemas.js";
import { findTemplate } from "../templates.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const SYSTEM_AUTHOR = { name: "Catamorphic", email: "system@catamorphic.dev" };

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

      let workflows: {
        name: string;
        displayName: string | null;
        description: string | null;
        filePath: string;
        parameterCount: number;
      }[] = [];
      let files: string[] = [];

      try {
        const repo = await projectManager.open(DEFAULT_TENANT_ID, projectId);
        try {
          const allFiles = await repo.readAllFiles();
          files = Object.keys(allFiles);
          const parsed = parseProject(allFiles);
          workflows = parsed.workflows.map((wf) => ({
            name: wf.functionName,
            displayName: wf.graph.displayName ?? null,
            description: wf.graph.description ?? null,
            filePath: wf.filePath ?? "",
            parameterCount: wf.graph.trigger.parameters.length,
          }));
        } finally {
          await repo.dispose();
        }
      } catch {
        // repo may not exist yet — return project with empty workflows
      }

      return reply.send({ ...mapProject(row), workflows, files });
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
        const commits = await repo.log({ maxCount: limit });
        return reply.send({ items: commits, total: commits.length });
      } finally {
        await repo.dispose();
      }
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/remote",
    schema: {
      params: ProjectIdParamsSchema,
      body: SetRemoteSchema,
      response: { 200: ProjectSchema, 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/push",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/pull",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });

  typed.route({
    method: "POST",
    url: "/api/projects/:projectId/export",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 404: ErrorSchema },
    },
    handler: async (_request, reply) => {
      return reply.status(404).send({ error: "Not implemented" });
    },
  });
}
