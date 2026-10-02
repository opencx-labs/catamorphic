import type { CatamorphicCore } from "@catamorphic/core";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
} from "fastify-type-provider-zod";
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
  /** See `CatamorphicPluginOptions.publicApiBase`. */
  publicApiBase?: string;
  /** See `CatamorphicPluginOptions.projectMcp`. */
  projectMcp?: CatamorphicPluginOptions["projectMcp"];
}

/**
 * Standalone app factory: a full Fastify instance with CORS, Swagger UI at
 * `/docs`, and the catamorphic plugin mounted at `/api`. Use this to run the
 * API as a sidecar process (or in tests / spec generation). Hosts embedding
 * catamorphic into an existing Fastify app should register
 * `catamorphicPlugin` directly instead.
 */
/** A recursive JSON value as an OpenAPI 3.0 component named `id`. */
function jsonValueComponent(id: string) {
  const self = { $ref: `#/components/schemas/${id}` };
  return {
    anyOf: [
      { type: "string" as const },
      { type: "number" as const },
      { type: "boolean" as const },
      { type: "string" as const, nullable: true, enum: [null] },
      { type: "array" as const, items: self },
      { type: "object" as const, additionalProperties: self },
    ],
  };
}

export function createApp(config: AppConfig) {
  const app = Fastify({
    logger: true,
    forceCloseConnections: true,
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
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
    transformObject: (document) => {
      const object = jsonSchemaTransformObject(document);
      // Zod writes its recursive JSON value as a `__shared` definition that
      // OpenAPI cannot reference; name the JSON value by hand instead.
      const schemas =
        "components" in object ? object.components?.schemas : undefined;
      if (schemas) {
        Reflect.deleteProperty(schemas, "__shared");
        schemas.JsonValue = jsonValueComponent("JsonValue");
        schemas.JsonValueInput = jsonValueComponent("JsonValueInput");
      }
      return object;
    },
  });

  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.register(catamorphicPlugin, {
    core: config.core,
    identity: config.identity,
    ...(config.features ? { features: config.features } : {}),
    ...(config.projectMcp ? { projectMcp: config.projectMcp } : {}),
    ...(config.publicApiBase ? { publicApiBase: config.publicApiBase } : {}),
    prefix: "/api",
  });

  return app;
}
