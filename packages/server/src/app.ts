import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerPlaygroundRoutes } from "./routes/playground.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import type { AgentContextService } from "./services/agent-context-service.js";
import type { PluginsService } from "./services/plugins-service.js";
import type { RunPluginsLoader } from "./services/run-plugins-loader.js";
import type { SecretsService } from "./services/secrets-service.js";

export interface AppConfig {
  db?: Kysely<DB>;
  projectManager?: ProjectManager;
  sandboxProvider?: SandboxProvider;
  pluginsService?: PluginsService;
  secretsService?: SecretsService;
  runPluginsLoader?: RunPluginsLoader;
  agentContextService?: AgentContextService;
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

  app.decorate("db", config.db);
  app.decorate("projectManager", config.projectManager);

  app.after(() => {
    registerProjectRoutes(app, config.db, config.projectManager);
    registerWorkflowRoutes(app, config.db, config.projectManager);
    registerRunRoutes(app, config.db);
    registerAgentRoutes(app);
    registerTemplateRoutes(app);
    registerPluginRoutes(
      app,
      config.pluginsService,
      config.secretsService,
      config.agentContextService,
    );
    registerPlaygroundRoutes(
      app,
      config.db,
      config.sandboxProvider,
      config.projectManager,
      config.runPluginsLoader,
    );
  });

  return app;
}
