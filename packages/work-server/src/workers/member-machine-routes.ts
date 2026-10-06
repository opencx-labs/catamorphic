import { ExecutorNotConnectedError, type Identity } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CodexSignInRefusedError } from "./codex-sign-ins.js";
import { type MemberMachines, NotYourMachineError } from "./member-machines.js";

/**
 * A member's own machines and their Codex sign-ins, for the Work app (ADR
 * 0213). Every route acts as the caller, on a machine of the caller's own;
 * the sign-in itself happens in the member's browser and on the machine.
 */
export function registerMemberMachineRoutes(
  app: FastifyInstance,
  options: {
    caller(request: FastifyRequest): Promise<Identity | null>;
    machines: MemberMachines;
  },
): void {
  const machineParams = z.object({ id: z.string().min(1).max(200) });
  const attemptParams = machineParams.extend({ attempt: z.string().uuid() });

  /** The caller, or a 401 already sent. */
  const member = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Identity | undefined> => {
    const identity = await options.caller(request);
    if (!identity) {
      await reply.status(401).send({ error: "Unauthorized" });
      return undefined;
    }
    return identity;
  };

  /** What stopped a request, as the app shows it. */
  const refusal = (reply: FastifyReply, error: unknown) => {
    if (error instanceof NotYourMachineError)
      return reply.status(403).send({ error: error.message });
    if (error instanceof CodexSignInRefusedError)
      return reply
        .status(409)
        .send({ error: error.message, code: "sign_in_refused" });
    if (error instanceof ExecutorNotConnectedError)
      return reply.status(409).send({
        error:
          "The machine is not connected right now. Try again once it is online",
        code: "machine_offline",
      });
    return reply.status(502).send({
      error:
        error instanceof Error ? error.message : "The machine did not answer",
    });
  };

  app.get("/api/work/me/machines", async (request, reply) => {
    const identity = await member(request, reply);
    if (!identity) return reply;
    return { machines: await options.machines.list(identity) };
  });

  app.post(
    "/api/work/me/machines/:id/codex/sign-in",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const { id } = machineParams.parse(request.params);
      try {
        const started = await options.machines.begin({
          identity,
          machineId: id,
        });
        return reply.status(201).send(started);
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.get(
    "/api/work/me/machines/:id/codex/sign-in/:attempt",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const { id, attempt } = attemptParams.parse(request.params);
      try {
        return await options.machines.status({
          identity,
          machineId: id,
          attempt,
        });
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.delete(
    "/api/work/me/machines/:id/codex/sign-in/:attempt",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const { id, attempt } = attemptParams.parse(request.params);
      try {
        await options.machines.cancel({ identity, machineId: id, attempt });
        return { ok: true };
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.delete("/api/work/me/machines/:id/codex", async (request, reply) => {
    const identity = await member(request, reply);
    if (!identity) return reply;
    const { id } = machineParams.parse(request.params);
    try {
      return await options.machines.signOut({ identity, machineId: id });
    } catch (error) {
      return refusal(reply, error);
    }
  });
}
