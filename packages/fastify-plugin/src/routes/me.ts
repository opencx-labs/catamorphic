import { effectiveProjectPermissions } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { MeSchema } from "../schemas.js";

/**
 * Introspection (ADR 0055): what THIS caller may do, and what THIS host
 * enables — so a client shows the possible instead of discovering it by
 * 403. Two halves: the identity as resolved (root or scope), summarised
 * per project (which permissions? which agents? which store subtrees?), and
 * the host's feature switches. Versioned so an older host degrades to
 * "assume everything" on a newer client.
 */
export function registerMeRoutes(app: FastifyInstance, ctx: RouteContext) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "GET",
    url: "/me",
    schema: { response: { 200: MeSchema } },
    handler: async (request, reply) => {
      const identity = resolveIdentity(request);
      const projectIds = [
        ...new Set([
          ...(identity.scope ?? []).map((ref) => ref.projectId),
          ...(identity.projectPermissions ?? []).map((ref) => ref.projectId),
        ]),
      ];
      const projects = await Promise.all(
        projectIds.map(async (projectId) => {
          const refs = (identity.scope ?? []).filter(
            (ref) => ref.projectId === projectId,
          );
          const permissions = effectiveProjectPermissions(identity, projectId);
          const project =
            permissions.includes("program:read") && ctx.core?.projects
              ? await ctx.core.projects.get(identity, projectId)
              : null;
          const roles =
            (await ctx.core?.memberships?.describeMember({
              projectId,
              tenantId: identity.tenantId,
              externalUserId: identity.externalUserId,
            })) ?? [];
          return {
            projectId,
            source: project?.remoteUrl
              ? {
                  remoteUrl: project.remoteUrl,
                  defaultBranch: project.defaultBranch,
                }
              : null,
            permissions,
            agents: refs
              .filter((ref) => ref.kind === "agent")
              .map((ref) => (ref as { name: string }).name),
            workflows: refs
              .filter((ref) => ref.kind === "workflow")
              .map((ref) => (ref as { name: string }).name),
            apps: refs
              .filter((ref) => ref.kind === "app")
              .map((ref) => (ref as { name: string }).name),
            documents: refs
              .filter((ref) => ref.kind === "document")
              .map((ref) => {
                const doc = ref as { path: string; access?: "read" | "write" };
                return { path: doc.path, access: doc.access ?? "read" };
              }),
            roles,
          };
        }),
      );
      const features = ctx.features;
      return reply.send({
        version: 1,
        identity: {
          externalUserId: identity.externalUserId,
          root: identity.scope === undefined,
        },
        projects,
        features: {
          publications: features.publications,
          proposals: features.proposals && Boolean(ctx.core?.proposals),
          proposalsOpenPullRequests:
            features.proposals && Boolean(ctx.core?.proposalsOpenPullRequests),
          mcp: features.mcp,
          agentSessions: Boolean(ctx.core?.agentSessions),
          storeUploadMaxBytes: features.storeUploadMaxBytes,
        },
      });
    },
  });
}
