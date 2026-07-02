import type { CatamorphicCore } from "@catamorphic/core";
import type { FastifyPluginAsync } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { HttpIdentityError } from "./http-identity.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerPlaygroundRoutes } from "./routes/playground.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";

export interface CatamorphicPluginOptions {
  /**
   * Wired catamorphic services (build them with `@catamorphic/server-sdk` or
   * `createCatamorphicCore`). Required for any non-trivial route; when
   * omitted, project / run / workflow endpoints respond 503.
   */
  core?: CatamorphicCore;
}

export interface RouteContext {
  core?: CatamorphicCore;
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
 * Identity comes from the host's auth layer via the
 * `X-Catamorphic-Tenant-Id` and `X-External-User-Id` headers, which the host
 * should set from its verified session (never forward them from the browser
 * unchecked).
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
    app.log.error(err);
    return reply.send(err);
  });

  const ctx: RouteContext = { core: opts.core };

  registerProjectRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerTemplateRoutes(app);
  registerPluginRoutes(app, ctx);
  registerPlaygroundRoutes(app, ctx);
};
