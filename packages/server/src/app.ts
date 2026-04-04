import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { registerRunRoutes } from "./routes/runs.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";

export interface AppConfig {
  db?: Kysely<Record<string, unknown>>;
}

export function createApp(config: AppConfig = {}) {
  const app = Fastify({
    logger: true,
    forceCloseConnections: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(fastifyCors, { origin: true });

  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Catamorphic API",
        version: "0.0.1",
        description: "Code-first workflow builder API",
      },
      servers: [{ url: "http://localhost:3001" }],
    },
    transform: jsonSchemaTransform,
  });

  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.decorate("db", config.db);

  app.after(() => {
    const typedApp = app.withTypeProvider<ZodTypeProvider>();
    registerWorkflowRoutes(typedApp);
    registerRunRoutes(typedApp);
  });

  return app;
}
