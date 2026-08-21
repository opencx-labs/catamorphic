import type { CatamorphicCore } from "@catamorphic/core";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import type { IdentityResolver } from "./http-identity.js";
import { type CatamorphicPluginOptions, catamorphicPlugin } from "./plugin.js";

export type { RouteContext } from "./plugin.js";

export interface AppConfig {
  /**
   * Wired catamorphic services. Required for any non-trivial route. When
   * omitted (e.g. unit tests that only hit stub routes), project / run /
   * workflow endpoints respond 503.
   */
  core?: CatamorphicCore;
  /**
   * Who is calling — see `CatamorphicPluginOptions.identity`. A sidecar that
   * sits behind the host's own auth typically passes `identityFromHeaders()`.
   */
  identity: IdentityResolver;
  /** Host feature switches; see `CatamorphicPluginOptions.features`. */
  features?: CatamorphicPluginOptions["features"];
}

/**
 * Standalone app factory: a full Fastify instance with CORS, Swagger UI at
 * `/docs`, and the catamorphic plugin mounted at `/api`. Use this to run the
 * API as a sidecar process (or in tests / spec generation). Hosts embedding
 * catamorphic into an existing Fastify app should register
 * `catamorphicPlugin` directly instead.
 */
export function createApp(config: AppConfig) {
  const app = Fastify({
    logger: true,
    forceCloseConnections: true,
    // Media attachments are ~10MB each (base64 4/3); Fastify's default
    // 1MB cap rejects a single pasted screenshot.
    bodyLimit: 96 * 1024 * 1024,
  });

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
      components: {
        schemas: {
          JsonValueInput: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "string", nullable: true, enum: [null] },
              {
                type: "array",
                items: { $ref: "#/components/schemas/JsonValueInput" },
              },
              {
                type: "object",
                additionalProperties: {
                  $ref: "#/components/schemas/JsonValueInput",
                },
              },
            ],
          },
        },
      },
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
  });

  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.register(catamorphicPlugin, {
    core: config.core,
    identity: config.identity,
    ...(config.features ? { features: config.features } : {}),
    prefix: "/api",
  });

  return app;
}
