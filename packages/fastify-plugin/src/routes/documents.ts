import {
  DocumentConflictError,
  DocumentNotFoundError,
  DocumentPathError,
  DocumentTooLargeError,
  ProjectNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  DocumentContentSchema,
  DocumentEntrySchema,
  DocumentMatchSchema,
  DocumentVersionSchema,
  ErrorSchema,
  ProjectIdParamsSchema,
  ProposalResultSchema,
  ProposeChangeSchema,
  WriteDocumentSchema,
} from "../schemas.js";

/**
 * The documents surface (ADR 0055): one path namespace — the program (git,
 * read-only here) and the project store (`store/…`, versioned, caller-
 * stamped) — filtered by the caller's document refs. JSON for metadata,
 * text and writes (text or base64); `/documents/raw` streams bytes for
 * downloads and binaries.
 */
export function registerDocumentRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const core = () => {
    if (!ctx.core)
      throw Object.assign(new Error("Service not configured"), {
        statusCode: 503,
      });
    return ctx.core;
  };

  const handleErrors = (err: unknown, reply: FastifyReply) => {
    if (err instanceof ProjectNotFoundError) {
      return reply.status(404).send({ error: "Project not found" });
    }
    if (err instanceof DocumentNotFoundError) {
      return reply.status(404).send({ error: err.message });
    }
    if (err instanceof DocumentPathError) {
      return reply.status(400).send({ error: err.message });
    }
    if (err instanceof DocumentTooLargeError) {
      return reply.status(413).send({ error: err.message });
    }
    if (err instanceof DocumentConflictError) {
      return reply
        .status(409)
        .send({ error: err.message, currentVersion: err.currentVersion });
    }
    throw err;
  };

  typed.route({
    method: "GET",
    url: "/projects/:projectId/documents",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        prefix: z.string().optional(),
        source: z.enum(["program", "store"]).optional(),
      }),
      response: { 200: DocumentEntrySchema.array(), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      try {
        return reply.send(
          await core().documents.list({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            ...request.query,
          }),
        );
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/documents/content",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        path: z.string().min(1),
        version: z.coerce.number().int().positive().optional(),
      }),
      response: {
        200: DocumentContentSchema,
        400: ErrorSchema,
        404: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      try {
        const doc = await core().documents.read({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          path: request.query.path,
          ...(request.query.version !== undefined
            ? { version: request.query.version }
            : {}),
        });
        return reply.send(doc);
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  // Raw bytes: downloads, binaries, editors that want the file as-is.
  typed.route({
    method: "GET",
    url: "/projects/:projectId/documents/raw",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        path: z.string().min(1),
        version: z.coerce.number().int().positive().optional(),
      }),
    },
    handler: async (request, reply) => {
      try {
        const doc = await core().documents.readBytes({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          path: request.query.path,
          ...(request.query.version !== undefined
            ? { version: request.query.version }
            : {}),
        });
        reply.header("content-type", doc.contentType);
        reply.header("x-catamorphic-document-source", doc.source);
        if (doc.version !== undefined) {
          reply.header("x-catamorphic-document-version", String(doc.version));
        }
        if (doc.writtenBy) {
          // Header values must be Latin-1 and single-line; ids are host text.
          reply.header(
            "x-catamorphic-written-by",
            encodeURIComponent(doc.writtenBy),
          );
        }
        if (doc.writtenAt)
          reply.header("x-catamorphic-written-at", doc.writtenAt);
        return reply.send(Buffer.from(doc.bytes));
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "PUT",
    url: "/projects/:projectId/documents/content",
    // The body must fit the largest allowed document base64-inflated (4/3)
    // plus the JSON envelope; the handler's storeUploadMaxBytes check owns
    // the accurate 413 for decoded content.
    bodyLimit: Math.ceil((ctx.features.storeUploadMaxBytes * 4) / 3) + 65_536,
    schema: {
      params: ProjectIdParamsSchema,
      body: WriteDocumentSchema,
      response: {
        200: DocumentEntrySchema,
        400: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema.extend({ currentVersion: z.number() }),
        413: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const body = request.body;
      const content =
        body.text !== undefined
          ? body.text
          : new Uint8Array(Buffer.from(body.base64 ?? "", "base64"));
      const size =
        typeof content === "string"
          ? Buffer.byteLength(content)
          : content.byteLength;
      if (size > ctx.features.storeUploadMaxBytes) {
        return reply.status(413).send({
          error: `Document exceeds this server's limit of ${Math.floor(ctx.features.storeUploadMaxBytes / 1024 / 1024)}MB`,
        });
      }
      try {
        return reply.send(
          await core().documents.write({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            path: body.path,
            content,
            ...(body.contentType ? { contentType: body.contentType } : {}),
            ...(body.ifVersion !== undefined
              ? { ifVersion: body.ifVersion }
              : {}),
          }),
        );
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/documents/content",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        path: z.string().min(1),
        ifVersion: z.coerce.number().int().nonnegative().optional(),
      }),
      response: {
        200: z.object({ version: z.number() }),
        400: ErrorSchema,
        404: ErrorSchema,
        409: ErrorSchema.extend({ currentVersion: z.number() }),
      },
    },
    handler: async (request, reply) => {
      try {
        return reply.send(
          await core().documents.delete({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            path: request.query.path,
            ...(request.query.ifVersion !== undefined
              ? { ifVersion: request.query.ifVersion }
              : {}),
          }),
        );
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/documents/history",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({ path: z.string().min(1) }),
      response: {
        200: DocumentVersionSchema.array(),
        400: ErrorSchema,
        404: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      try {
        return reply.send(
          await core().documents.history({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            path: request.query.path,
          }),
        );
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/documents/search",
    schema: {
      params: ProjectIdParamsSchema,
      querystring: z.object({
        q: z.string().min(1),
        mode: z.enum(["grep", "text"]).optional(),
        prefix: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      }),
      response: {
        200: DocumentMatchSchema.array(),
        400: ErrorSchema,
        404: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      try {
        const { q, ...rest } = request.query;
        return reply.send(
          await core().documents.search({
            identity: resolveIdentity(request),
            projectId: request.params.projectId,
            query: q,
            ...rest,
          }),
        );
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  // Propose a change to the program (ADR 0055): files land on a branch from
  // the shared main, authored as the member; a PR opens through the host's
  // bot when a code host is linked.
  typed.route({
    method: "POST",
    url: "/projects/:projectId/proposals",
    schema: {
      params: ProjectIdParamsSchema,
      body: ProposeChangeSchema,
      response: {
        201: ProposalResultSchema,
        400: ErrorSchema,
        403: ErrorSchema,
        404: ErrorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!ctx.features.proposals) {
        return reply
          .status(403)
          .send({ error: "Proposals are turned off on this server" });
      }
      try {
        const result = await core().proposals.propose({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          title: request.body.title,
          ...(request.body.body ? { body: request.body.body } : {}),
          changes: request.body.changes,
        });
        return reply.status(201).send(result);
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });
}
