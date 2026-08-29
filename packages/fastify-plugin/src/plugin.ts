import type { CatamorphicCore } from "@catamorphic/core";
import { AccessDeniedError } from "@catamorphic/core";
import type { FastifyPluginAsync } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  attachIdentity,
  HttpIdentityError,
  type IdentityResolver,
} from "./http-identity.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAppRoutes } from "./routes/apps.js";
import { registerAppsMcpRoutes } from "./routes/apps-mcp.js";
import { registerConnectionMcpRoutes } from "./routes/connection-mcp.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerMembershipRoutes } from "./routes/memberships.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerPlaygroundRoutes } from "./routes/playground.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerProjectMcpRoutes } from "./routes/project-mcp.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerPublicationRoutes } from "./routes/publications.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSessionMailboxRoutes } from "./routes/session-mailboxes.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import { registerWatcherRoutes } from "./routes/watchers.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";

export interface CatamorphicPluginOptions {
  /**
   * Wired catamorphic services (build them with `@catamorphic/server-sdk` or
   * `createCatamorphicCore`). Required for any non-trivial route; when
   * omitted, project / run / workflow endpoints respond 503.
   */
  core?: CatamorphicCore;
  /**
   * Who is calling. Runs on every request before any route; returns a full
   * identity for a builder, a scoped identity for a viewer (an app user, a
   * customer), or `null` for 401. Typically a few lines that read the host's
   * own session and its entitlement table:
   *
   * ```ts
   * identity: async (req) => {
   *   const session = await verifySession(req);
   *   if (!session) return null;
   *   const base = { tenantId: session.orgId, externalUserId: session.userId };
   *   if (session.isEmployee) return base;
   *   return { ...base, scope: await entitlementsFor(session.userId) };
   * }
   * ```
   *
   * Hosts whose auth terminates in front of the plugin pass
   * `identityFromHeaders()`.
   */
  identity: IdentityResolver;
  /**
   * Coarse host feature switches (ADR 0055). Enforced server-side by the
   * routes concerned AND advertised on `GET /me`, so a client (the desktop,
   * a member's own agent) can show what is possible instead of discovering
   * it by 403. Scope stays the mechanism for "may not"; these are the few
   * things a host decides for everyone.
   */
  features?: Partial<HostFeatures>;
}

/** What a host enables for all callers; defaults are the most permissive. */
export interface HostFeatures {
  /** Which publication audiences may be created: both, members only, or none. */
  publications: "public" | "members" | false;
  /** Whether members may propose program changes. */
  proposals: boolean;
  /** Whether the project MCP endpoint is served. */
  mcp: boolean;
  /** Largest store document accepted (bytes). */
  storeUploadMaxBytes: number;
}

export const DEFAULT_HOST_FEATURES: HostFeatures = {
  publications: "public",
  proposals: true,
  mcp: true,
  storeUploadMaxBytes: 64 * 1024 * 1024,
};

export interface RouteContext {
  core?: CatamorphicCore;
  features: HostFeatures;
}

/**
 * Mountable Fastify plugin exposing the catamorphic HTTP API. Hosts register
 * it on their own Fastify instance:
 *
 * ```ts
 * app.register(catamorphicPlugin, { core, prefix: "/api" });
 * ```
 *
 * The generated api-client (`@catamorphic/api-client`) expects the routes
 * under `/api`, so mount with that prefix unless you also change the client's
 * `baseUrl`. The plugin is fully encapsulated: it sets Zod validator /
 * serializer compilers and an error handler for its own scope only, and it
 * registers no CORS — the host owns cross-origin policy.
 *
 * Identity comes from the host's `identity` resolver — the only identity
 * mechanism; there is no header fallback unless the host opts into
 * `identityFromHeaders()` explicitly.
 */
export const catamorphicPlugin: FastifyPluginAsync<
  CatamorphicPluginOptions
> = async (app, opts) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpIdentityError) {
      return reply.status(400).send({ error: err.message });
    }
    if (err instanceof AccessDeniedError) {
      return reply.status(403).send({ error: err.message });
    }
    app.log.error(err);
    return reply.send(err);
  });

  // Identity is resolved once per request, before any route runs, and
  // stashed on the request for `resolveIdentity`. A `null` is the host
  // saying "not signed in".
  app.addHook("onRequest", async (request, reply) => {
    // Public publications (ADR 0055) are the one anonymous surface: the
    // route mints its own document-scoped identity. A missing/invalid
    // session is still resolved (a signed-in member reading a public link
    // is fine) but never required.
    const isPublic =
      (request.routeOptions.config as { public?: boolean } | undefined)
        ?.public === true;
    let identity: Awaited<ReturnType<typeof opts.identity>> = null;
    try {
      identity = await opts.identity(request);
    } catch (error) {
      if (!isPublic) throw error;
    }
    if (!identity) {
      if (isPublic) return;
      return reply.status(401).send({ error: "Unauthorized" });
    }
    attachIdentity(request, identity);
  });

  const ctx: RouteContext = {
    core: opts.core,
    // Explicit `undefined` from a host (a field computed from env) must not
    // erase the default.
    features: {
      ...DEFAULT_HOST_FEATURES,
      ...Object.fromEntries(
        Object.entries(opts.features ?? {}).filter(([, v]) => v !== undefined),
      ),
    },
  };

  registerMeRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerEnvironmentRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerConnectionMcpRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerTriggerRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerSessionMailboxRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerWatcherRoutes(app, ctx);
  registerMembershipRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerPublicationRoutes(app, ctx);
  registerAppRoutes(app, ctx);
  registerAppsMcpRoutes(app, ctx);
  registerProjectMcpRoutes(app, ctx);
  registerGithubRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
  registerPlaygroundRoutes(app, ctx);
};
