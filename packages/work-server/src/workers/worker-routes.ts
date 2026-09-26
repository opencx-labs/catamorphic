import { RemoteWorkerLeaseLostError } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  WorkerConnectConflictError,
  WorkerIsolationError,
  WorkerOfferSchema,
  type WorkWorkerRegistry,
} from "./worker-registry.js";

const Session = z.strictObject({ session: z.string().uuid() });
const Completion = z.strictObject({
  session: z.string().uuid(),
  jobId: z.string().uuid(),
  response: z.unknown().optional(),
  error: z.string().max(10_000).optional(),
});

/**
 * The worker protocol (ADR 0164). Every call but enrollment carries the
 * worker's machine credential; a session is the node lease token, so a
 * stale connection is refused as soon as its lease moves on.
 */
export function registerWorkerRoutes(
  app: FastifyInstance,
  registry: WorkWorkerRegistry,
): void {
  const authenticated = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const header = request.headers.authorization;
    const worker = await registry.authenticate(
      Array.isArray(header) ? header[0] : header,
    );
    if (!worker) {
      await reply.status(401).send({ error: "Worker credential required" });
      return undefined;
    }
    return worker;
  };

  app.post("/api/workers/enroll", async (request, reply) => {
    const body = z
      .strictObject({ code: z.string().min(10) })
      .safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Provide an enrollment code" });
    }
    try {
      return await registry.enroll({ code: body.data.code });
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Enrollment failed",
      });
    }
  });

  app.post("/api/workers/connect", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const offer = WorkerOfferSchema.safeParse(request.body);
    if (!offer.success) {
      return reply
        .status(400)
        .send({ error: "Invalid worker offer", issues: offer.error.issues });
    }
    try {
      const session = await registry.connect({ ...worker, offer: offer.data });
      return { session, nodeId: worker.nodeId };
    } catch (error) {
      if (error instanceof WorkerConnectConflictError) {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof WorkerIsolationError) {
        return reply.status(403).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/workers/poll", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const body = Session.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "No session" });
    await registry.touch(worker.nodeId);
    try {
      const job = await registry.jobService.poll({
        nodeId: worker.nodeId,
        leaseToken: body.data.session,
        waitMs: 20_000,
      });
      return job ? { job } : { job: null };
    } catch (error) {
      if (error instanceof RemoteWorkerLeaseLostError) {
        return reply.status(409).send({ error: error.message });
      }
      throw error;
    }
  });

  // Keeps the lease while a long operation runs and no poll is pending.
  app.post("/api/workers/renew", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const body = Session.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "No session" });
    await registry.touch(worker.nodeId);
    const held = await registry.jobService.leaseHeld({
      nodeId: worker.nodeId,
      leaseToken: body.data.session,
    });
    return held
      ? { ok: true }
      : reply.status(409).send({ error: "The worker's lease moved on" });
  });

  app.post(
    "/api/workers/complete",
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      const worker = await authenticated(request, reply);
      if (!worker) return reply;
      const body = Completion.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Invalid completion" });
      }
      await registry.touch(worker.nodeId);
      try {
        await registry.jobService.complete({
          nodeId: worker.nodeId,
          leaseToken: body.data.session,
          jobId: body.data.jobId,
          ...(body.data.response !== undefined
            ? { response: body.data.response }
            : {}),
          ...(body.data.error !== undefined
            ? { error: body.data.error || "Remote operation failed" }
            : {}),
        });
        return { ok: true };
      } catch (error) {
        return reply.status(409).send({
          error: error instanceof Error ? error.message : "Receipt refused",
        });
      }
    },
  );
}
