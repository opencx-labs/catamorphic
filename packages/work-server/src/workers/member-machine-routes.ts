import { ExecutorNotConnectedError, type Identity } from "@catamorphic/core";
import { type SignInHarness, signInHarness } from "@catamorphic/sandbox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  HarnessSignInRefusedError,
  SIGN_IN_INPUT_MAX,
} from "./harness-sign-ins.js";
import { type MemberMachines, NotYourMachineError } from "./member-machines.js";

/**
 * A member's own machines and their Claude Code and Codex sign-ins, for
 * the Work app (ADRs 0213, 0340). Every route acts as the caller, on a
 * machine of the caller's own; the sign-in itself happens in the member's
 * browser and on the machine. The code a member pastes for a login that
 * waits for one passes through to the machine: no route logs or repeats it.
 */
export function registerMemberMachineRoutes(
  app: FastifyInstance,
  options: {
    caller(request: FastifyRequest): Promise<Identity | null>;
    machines: MemberMachines;
  },
): void {
  const harnessParams = z.object({
    id: z.string().min(1).max(200),
    harness: z.string().min(1).max(40),
  });
  const attemptParams = harnessParams.extend({ attempt: z.string().uuid() });
  const inputBody = z.strictObject({
    text: z.string().min(1).max(SIGN_IN_INPUT_MAX),
  });

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

  /** The harness a route names, or a 404 already sent. */
  const harnessOf = async (
    reply: FastifyReply,
    name: string,
  ): Promise<SignInHarness | undefined> => {
    const harness = signInHarness(name);
    if (!harness)
      await reply
        .status(404)
        .send({ error: `'${name}' is not a harness members sign in to` });
    return harness;
  };

  /** What stopped a request, as the app shows it. */
  const refusal = (reply: FastifyReply, error: unknown) => {
    if (error instanceof NotYourMachineError)
      return reply.status(403).send({ error: error.message });
    if (error instanceof HarnessSignInRefusedError)
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
    "/api/work/me/machines/:id/:harness/sign-in",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const params = harnessParams.parse(request.params);
      const harness = await harnessOf(reply, params.harness);
      if (!harness) return reply;
      try {
        const started = await options.machines.begin({
          identity,
          machineId: params.id,
          harness,
        });
        return reply.status(201).send(started);
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.get(
    "/api/work/me/machines/:id/:harness/sign-in/:attempt",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const params = attemptParams.parse(request.params);
      const harness = await harnessOf(reply, params.harness);
      if (!harness) return reply;
      try {
        return await options.machines.status({
          identity,
          machineId: params.id,
          harness,
          attempt: params.attempt,
        });
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.post(
    "/api/work/me/machines/:id/:harness/sign-in/:attempt/input",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const params = attemptParams.parse(request.params);
      const harness = await harnessOf(reply, params.harness);
      if (!harness) return reply;
      // What was sent is never repeated, in an answer or a log.
      const body = inputBody.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({
          error: "Send the code the sign-in page gave you as { text }",
        });
      try {
        return await options.machines.input({
          identity,
          machineId: params.id,
          harness,
          attempt: params.attempt,
          text: body.data.text,
        });
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.delete(
    "/api/work/me/machines/:id/:harness/sign-in/:attempt",
    async (request, reply) => {
      const identity = await member(request, reply);
      if (!identity) return reply;
      const params = attemptParams.parse(request.params);
      const harness = await harnessOf(reply, params.harness);
      if (!harness) return reply;
      try {
        await options.machines.cancel({
          identity,
          machineId: params.id,
          harness,
          attempt: params.attempt,
        });
        return { ok: true };
      } catch (error) {
        return refusal(reply, error);
      }
    },
  );

  app.delete("/api/work/me/machines/:id/:harness", async (request, reply) => {
    const identity = await member(request, reply);
    if (!identity) return reply;
    const params = harnessParams.parse(request.params);
    const harness = await harnessOf(reply, params.harness);
    if (!harness) return reply;
    try {
      return await options.machines.signOut({
        identity,
        machineId: params.id,
        harness,
      });
    } catch (error) {
      return refusal(reply, error);
    }
  });
}
