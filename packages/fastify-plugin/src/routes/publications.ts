import {
  DocumentNotFoundError,
  DocumentPathError,
  ProjectNotFoundError,
  type Publication,
  PublicationNotFoundError,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { optionalIdentity, resolveIdentity } from "../http-identity.js";
import {
  ErrorSchema,
  ProjectIdParamsSchema,
  PublicationParamsSchema,
  PublicationSchema,
  PublishSchema,
} from "../schemas.js";

/**
 * Publications (ADR 0055): publish / list / revoke for the project's
 * members, and two serving routes —
 *   GET /projects/:id/publications/:slug   members (host auth), or public
 *   GET /public/:id/:slug                  public only, no auth (route
 *                                          config `public: true` skips the
 *                                          identity requirement)
 * both stream the document as the audience's identity: an anonymous
 * document-scoped one for public, the member narrowed to the document
 * otherwise. Nothing else on the plugin is reachable anonymously.
 */
export function registerPublicationRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const core = () => {
    if (!ctx.core) {
      throw Object.assign(new Error("Service not configured"), {
        statusCode: 503,
      });
    }
    return ctx.core;
  };
  const withUrl = (
    publication: Publication,
  ): Publication & { url: string } => ({
    ...publication,
    url:
      publication.audience === "public"
        ? `/public/${publication.projectId}/${publication.slug}`
        : `/projects/${publication.projectId}/publications/${publication.slug}`,
  });
  const handleErrors = (err: unknown, reply: FastifyReply) => {
    if (err instanceof ProjectNotFoundError) {
      return reply.status(404).send({ error: "Project not found" });
    }
    if (err instanceof PublicationNotFoundError) {
      return reply.status(404).send({ error: err.message });
    }
    if (err instanceof DocumentPathError) {
      return reply.status(400).send({ error: err.message });
    }
    throw err;
  };

  typed.route({
    method: "POST",
    url: "/projects/:projectId/publications",
    schema: {
      params: ProjectIdParamsSchema,
      body: PublishSchema,
      response: { 201: PublicationSchema, 400: ErrorSchema, 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      try {
        const publication = await core().publications.publish({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          path: request.body.path,
          audience: request.body.audience,
          ...(request.body.slug ? { slug: request.body.slug } : {}),
        });
        return reply.status(201).send(withUrl(publication));
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "GET",
    url: "/projects/:projectId/publications",
    schema: {
      params: ProjectIdParamsSchema,
      response: { 200: PublicationSchema.array(), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      try {
        const list = await core().publications.list({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
        });
        return reply.send(list.map(withUrl));
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  typed.route({
    method: "DELETE",
    url: "/projects/:projectId/publications/:slug",
    schema: {
      params: PublicationParamsSchema,
      response: { 204: z.null(), 404: ErrorSchema },
    },
    handler: async (request, reply) => {
      try {
        await core().publications.revoke({
          identity: resolveIdentity(request),
          projectId: request.params.projectId,
          slug: request.params.slug,
        });
        return reply.status(204).send(null);
      } catch (err) {
        return handleErrors(err, reply);
      }
    },
  });

  const serve = async (
    reply: FastifyReply,
    args: {
      projectId: string;
      slug: string;
      caller: Parameters<typeof optionalIdentity>[0];
    },
  ) => {
    const resolved = await core().publications.resolve({
      projectId: args.projectId,
      slug: args.slug,
      caller: optionalIdentity(args.caller),
    });
    // One uniform answer for unknown, revoked, or not-for-you: no oracle.
    if (!resolved) return reply.status(404).send({ error: "Not found" });
    try {
      const doc = await core().documents.readBytes({
        identity: resolved.identity,
        projectId: args.projectId,
        path: resolved.path,
      });
      reply.header("content-type", doc.contentType);
      reply.header("cache-control", "no-store");
      if (doc.version !== undefined) {
        reply.header("x-catamorphic-document-version", String(doc.version));
      }
      return reply.send(Buffer.from(doc.bytes));
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        return reply.status(404).send({ error: "Not found" });
      }
      throw err;
    }
  };

  // Members (or anyone signed in, for public publications).
  typed.route({
    method: "GET",
    url: "/projects/:projectId/publications/:slug",
    schema: { params: PublicationParamsSchema },
    handler: (request, reply) =>
      serve(reply, {
        projectId: request.params.projectId,
        slug: request.params.slug,
        caller: request,
      }),
  });

  // Public: no identity required (the hook honours `config.public`).
  typed.route({
    method: "GET",
    url: "/public/:projectId/:slug",
    config: { public: true },
    schema: { params: PublicationParamsSchema },
    handler: (request, reply) =>
      serve(reply, {
        projectId: request.params.projectId,
        slug: request.params.slug,
        caller: request,
      }),
  });
}
