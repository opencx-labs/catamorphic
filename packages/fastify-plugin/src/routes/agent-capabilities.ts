import { AccessDeniedError } from "@catamorphic/core";
import {
  CapabilityPageSchema,
  DiscoverCapabilitiesSchema,
  InvokeCapabilitySchema,
} from "@catamorphic/sandbox";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { ErrorSchema } from "../schemas.js";

export function registerAgentCapabilityRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const base = "/projects/:projectId/agent/sessions/:sessionId/capabilities";
  const params = z.object({
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
  });
  const headers = z.object({
    "x-catamorphic-allocation-id": z.string().uuid().optional(),
  });
  const failures = { 403: ErrorSchema, 409: ErrorSchema, 503: ErrorSchema };
  const gateway = (
    identity: ReturnType<typeof resolveIdentity>,
    input: z.output<typeof params>,
    allocation: unknown,
  ) => {
    if (!ctx.core)
      throw Object.assign(new Error("Capabilities are not configured"), {
        statusCode: 503,
      });
    return ctx.core.agentCapabilities.forSession({
      identity,
      ...input,
      allocationId: z.string().uuid().optional().parse(allocation),
    });
  };
  typed.post(
    `${base}/discover`,
    {
      schema: {
        params,
        headers,
        body: DiscoverCapabilitiesSchema,
        response: { 200: CapabilityPageSchema, ...failures },
      },
    },
    (request) =>
      run(() =>
        gateway(
          resolveIdentity(request),
          request.params,
          request.headers["x-catamorphic-allocation-id"],
        ).discover(request.body),
      ),
  );
  typed.post(
    `${base}/invoke`,
    {
      bodyLimit: 6 * 1024 * 1024,
      schema: {
        params,
        headers,
        body: InvokeCapabilitySchema,
        response: { 200: z.object({ value: z.unknown() }), ...failures },
      },
    },
    (request, reply) =>
      run(async () => {
        const abort = new AbortController();
        const cancel = () => abort.abort();
        reply.raw.once("close", cancel);
        try {
          return {
            value: z.json().parse(
              await gateway(
                resolveIdentity(request),
                request.params,
                request.headers["x-catamorphic-allocation-id"],
              ).invoke({
                ...request.body,
                signal: abort.signal,
              }),
            ),
          };
        } finally {
          reply.raw.removeListener("close", cancel);
        }
      }),
  );
}
async function run<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AccessDeniedError)
      throw Object.assign(error, { statusCode: 403 });
    if (error instanceof Error && "statusCode" in error) throw error;
    throw Object.assign(
      error instanceof Error ? error : new Error("Capability failed"),
      { statusCode: 409 },
    );
  }
}
