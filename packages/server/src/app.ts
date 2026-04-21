import type { CatamorphicCore } from "@catamorphic/core";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
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

export interface AppConfig {
  /**
   * Wired catamorphic services. Required for any non-trivial route. When
   * omitted (e.g. unit tests that only hit stub routes), project / run /
   * workflow endpoints respond 503.
   */
  core?: CatamorphicCore;
  /**
   * When true, missing `X-Catamorphic-Tenant-Id` and `X-External-User-Id`
   * headers fall back to the hard-coded defaults. Used by the local
   * playground; embedding hosts should leave this false and pass the headers
   * on every request.
   */
  standalone?: boolean;
}

export interface RouteContext {
  core?: CatamorphicCore;
  standalone: boolean;
}

export function createApp(config: AppConfig = {}) {
  const app = Fastify({
    logger: true,
    forceCloseConnections: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Catamorphic API",
        version: "0.0.1",
        description: "Code-first workflow builder API",
      },
      servers: [{ url: `http://localhost:${process.env.PORT ?? 3001}` }],
    },
    transform: jsonSchemaTransform,
  });

  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpIdentityError) {
      return reply.status(400).send({ error: err.message });
    }
    app.log.error(err);
    return reply.send(err);
  });

  const ctx: RouteContext = {
    core: config.core,
    standalone: config.standalone ?? false,
  };

  app.after(() => {
    registerProjectRoutes(app, ctx);
    registerWorkflowRoutes(app, ctx);
    registerRunRoutes(app, ctx);
    registerAgentRoutes(app);
    registerTemplateRoutes(app);
    registerPluginRoutes(app, ctx);
    registerPlaygroundRoutes(app, ctx);
  });

  return app;
}
