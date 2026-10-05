import {
  AccessDeniedError,
  RemoteExecutorLeaseLostError,
  RemoteOperationResultSchema,
  RemoteReceiptRefusedError,
  SealedRemoteOperationSchema,
} from "@catamorphic/core";
import { ExecutorPublicKeySchema } from "@catamorphic/sandbox";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { ErrorSchema, ProjectIdParamsSchema } from "../schemas.js";

const Lease = z.object({ id: z.string().uuid(), token: z.string().uuid() });

/**
 * A member's This machine runner (ADRs 0098, 0187). It registers the public
 * key its operations are sealed to, and poll hands them out sealed (ADR
 * 0206). Poll long-polls; a 409 from poll or renew means the lease moved on
 * and the runner registers again, a 409 from complete refuses only that
 * receipt, and a 403 means the member may no longer serve this Environment.
 */
export function registerClientRunnerRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/projects/:projectId/client-runners",
    {
      schema: {
        params: ProjectIdParamsSchema,
        body: z.object({
          id: z.string().uuid(),
          environment: z.string().min(1),
          label: z.string().min(1).max(100),
          workspaceRoot: z.string().min(1).max(4096),
          resourceLimits: z
            .array(z.enum(["cpuMillis", "memoryMb", "storageMb", "gpu"]))
            .optional(),
          isolation: z.enum(["none", "process", "sandbox"]).optional(),
          /** The runner's provider runs background processes (ADR 0174). */
          processes: z.boolean().optional(),
          /** What its sandboxes can be given (ADR 0176). */
          capabilities: z
            .array(
              z.enum([
                "images",
                "images.build",
                "containers",
                "network.policy",
              ]),
            )
            .optional(),
          /**
           * The runner's X25519 public key, raw and base64: its operations
           * are sealed to it (ADR 0206). A runner without one receives
           * nothing.
           */
          publicKey: ExecutorPublicKeySchema.optional(),
        }),
        response: {
          200: Lease,
          400: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      const { publicKey, ...body } = request.body;
      if (!publicKey)
        return reply.status(400).send({
          error:
            "This version of Work cannot receive operations from this server. Update Work on this computer.",
        });
      try {
        return reply.send(
          await ctx.core.clientRunners.register({
            ...body,
            publicKey,
            projectId: request.params.projectId,
            identity: resolveIdentity(request),
          }),
        );
      } catch (error) {
        if (error instanceof AccessDeniedError)
          return reply.status(403).send({ error: error.message });
        return reply.status(409).send({
          error:
            error instanceof Error
              ? error.message
              : "Client registration failed",
        });
      }
    },
  );
  typed.post(
    "/client-runners/poll",
    {
      schema: {
        // A retried poll repeats its id and receives what that poll took;
        // `max` is the runner's free slots.
        body: Lease.extend({
          pollId: z.string().uuid(),
          max: z.number().int().min(1).max(64).optional(),
        }),
        response: {
          // Each operation sealed to the runner's key (ADR 0206).
          200: z.array(
            z.object({
              id: z.string().uuid(),
              operation: SealedRemoteOperationSchema,
            }),
          ),
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      try {
        return reply.send(
          await ctx.core.clientRunners.poll({
            ...request.body,
            identity: resolveIdentity(request),
            signal: hungUp(reply),
          }),
        );
      } catch (error) {
        if (error instanceof RemoteExecutorLeaseLostError)
          return reply.status(409).send({ error: error.message });
        throw error;
      }
    },
  );
  typed.post(
    "/client-runners/renew",
    {
      schema: {
        body: Lease,
        response: {
          200: z.object({ ok: z.boolean() }),
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      try {
        await ctx.core.clientRunners.renew({
          ...request.body,
          identity: resolveIdentity(request),
        });
      } catch (error) {
        if (error instanceof RemoteExecutorLeaseLostError)
          return reply.status(409).send({ error: error.message });
        throw error;
      }
      return { ok: true };
    },
  );
  typed.post(
    "/client-runners/complete",
    {
      // A receipt carries a whole result: a 1 MiB process read or a
      // downloaded file, escaped as JSON. Same bound as worker receipts.
      bodyLimit: 64 * 1024 * 1024,
      schema: {
        body: Lease.extend({
          jobId: z.string().uuid(),
          response: RemoteOperationResultSchema.optional(),
          error: z.string().max(4000).optional(),
        }),
        response: {
          200: z.object({ ok: z.boolean() }),
          403: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      try {
        return reply.send(
          await ctx.core.clientRunners.complete({
            ...request.body,
            identity: resolveIdentity(request),
          }),
        );
      } catch (error) {
        // The operation settled or was abandoned, or the lease moved on:
        // the runner drops this receipt.
        if (
          error instanceof RemoteReceiptRefusedError ||
          error instanceof RemoteExecutorLeaseLostError
        )
          return reply.status(409).send({ error: error.message });
        throw error;
      }
    },
  );
  typed.post(
    "/client-runners/disconnect",
    {
      schema: {
        body: Lease,
        response: {
          200: z.object({ ok: z.boolean() }),
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!ctx.core?.clientRunners)
        return reply
          .status(503)
          .send({ error: "Client execution is not enabled by this host" });
      await ctx.core.clientRunners.disconnect({
        ...request.body,
        identity: resolveIdentity(request),
      });
      return { ok: true };
    },
  );
}

/**
 * Aborts when the runner hangs up before the answer is sent, so a long poll
 * nobody waits for any more takes nothing.
 */
function hungUp(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
