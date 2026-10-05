import {
  RemoteExecutorLeaseLostError,
  RemoteReceiptRefusedError,
} from "@catamorphic/core";
import { ExecutorPublicKeySchema } from "@catamorphic/sandbox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  WORKER_PROTOCOL_HEADER,
  workerProtocolRefusal,
} from "./worker-protocol.js";
import {
  type AuthenticatedWorker,
  WorkerConnectSchema,
  WorkerDisabledError,
  WorkerIsolationError,
  WorkerKeyMismatchError,
  WorkerSupersededError,
  type WorkWorkerRegistry,
} from "./worker-registry.js";

const Session = z.strictObject({ session: z.string().uuid() });
/** A retried poll repeats its id and receives what that poll took. */
const Poll = Session.extend({
  pollId: z.string().uuid(),
  /** The worker's free slots: it takes up to this many at once. */
  max: z.number().int().min(1).max(64).default(1),
});
const Completion = z.strictObject({
  session: z.string().uuid(),
  jobId: z.string().uuid(),
  response: z.unknown().optional(),
  error: z.string().max(10_000).optional(),
});

/**
 * The worker protocol (ADRs 0164, 0187, 0192, 0206). Every call but
 * enrollment carries the worker's machine credential; a session is the epoch
 * the worker process chose at start, and it is the node's lease token. Any
 * replica answers any call, and each call renews the lease: operations and
 * leases live in Postgres. Operations reach the worker sealed to the public
 * key it enrolled or last rotated with. A 409 from poll or renew ends the
 * session, with `superseded: true` once a newer process of the worker took
 * over; a 409 from complete refuses only that receipt. Connect, poll and
 * renew answer `rotate: true` while the worker should rotate its credential
 * and key, which it does with `rotate`. Every call states the worker's
 * protocol (`work-protocol`); one this control plane cannot drive is
 * answered 426 naming which side to update (ADR 0198).
 */
export function registerWorkerRoutes(
  app: FastifyInstance,
  registry: WorkWorkerRegistry,
): void {
  const authenticated = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (await refusedProtocol(request, reply)) return undefined;
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
    if (await refusedProtocol(request, reply)) return reply;
    const body = z
      .strictObject({
        code: z.string().min(10),
        publicKey: ExecutorPublicKeySchema,
      })
      .safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: "Provide an enrollment code and the worker's public key",
      });
    }
    try {
      return await registry.enroll(body.data);
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Enrollment failed",
      });
    }
  });

  app.post("/api/workers/connect", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const body = WorkerConnectSchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ error: "Invalid worker offer", issues: body.error.issues });
    }
    try {
      await registry.connect({ ...worker, ...body.data });
      return {
        session: body.data.session,
        nodeId: worker.nodeId,
        ...rotation(worker),
      };
    } catch (error) {
      if (error instanceof WorkerDisabledError) {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof WorkerSupersededError)
        return sessionEnded(reply, error);
      if (
        error instanceof WorkerIsolationError ||
        error instanceof WorkerKeyMismatchError
      ) {
        return reply.status(403).send({ error: error.message });
      }
      throw error;
    }
  });

  // A new credential for a new key (ADR 0206). The credential this call
  // carries keeps working until the worker first uses the new one.
  app.post("/api/workers/rotate", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const body = z
      .strictObject({ publicKey: ExecutorPublicKeySchema })
      .safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: "Provide the new public key" });
    return registry.rotate({ nodeId: worker.nodeId, ...body.data });
  });

  app.post("/api/workers/poll", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const body = Poll.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "No session" });
    try {
      const jobs = await registry.poll({
        nodeId: worker.nodeId,
        ...body.data,
        signal: hungUp(reply),
      });
      return { jobs, ...rotation(worker) };
    } catch (error) {
      if (error instanceof RemoteExecutorLeaseLostError)
        return sessionEnded(reply, error);
      throw error;
    }
  });

  // Keeps the lease while a long operation runs and no poll is pending.
  app.post("/api/workers/renew", async (request, reply) => {
    const worker = await authenticated(request, reply);
    if (!worker) return reply;
    const body = Session.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "No session" });
    try {
      await registry.renew({ nodeId: worker.nodeId, ...body.data });
      return { ok: true, ...rotation(worker) };
    } catch (error) {
      if (error instanceof RemoteExecutorLeaseLostError)
        return sessionEnded(reply, error);
      throw error;
    }
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
      try {
        await registry.complete({
          nodeId: worker.nodeId,
          session: body.data.session,
          operationId: body.data.jobId,
          ...(body.data.response !== undefined
            ? { response: body.data.response }
            : {}),
          ...(body.data.error !== undefined
            ? { error: body.data.error || "Remote operation failed" }
            : {}),
        });
        return { ok: true };
      } catch (error) {
        if (error instanceof RemoteReceiptRefusedError) {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}

/** Tells a worker to rotate its credential; never refuses it work. */
function rotation(worker: AuthenticatedWorker): { rotate?: true } {
  return worker.rotate ? { rotate: true } : {};
}

/** Answers 426 when the worker's protocol is not one this plane drives. */
async function refusedProtocol(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const refusal = workerProtocolRefusal(
    request.headers[WORKER_PROTOCOL_HEADER],
  );
  if (!refusal) return false;
  await reply.status(426).send(refusal);
  return true;
}

/** The worker's session ended: 409, marked when a newer process took over. */
function sessionEnded(
  reply: FastifyReply,
  error: RemoteExecutorLeaseLostError,
) {
  return reply.status(409).send({
    error: error.message,
    ...(error instanceof WorkerSupersededError ? { superseded: true } : {}),
  });
}

/**
 * Aborts when the caller hangs up before the answer is sent, so a long poll
 * nobody waits for any more takes nothing.
 */
function hungUp(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
