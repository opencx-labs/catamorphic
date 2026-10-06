import type { Identity } from "@catamorphic/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  LastAdministratorError,
  type WorkAdministrators,
} from "./administrators.js";

/** Who may use an administrators' route (ADR 0172). */
export interface AdministratorAccess {
  administrators: WorkAdministrators;
  caller(request: FastifyRequest): Promise<Identity | null>;
}

/**
 * Whether the request's caller is an organization administrator: 401 for
 * nobody signed in, 403 for a member who is not one.
 */
export function administratorCaller(
  access: AdministratorAccess,
): (
  request: FastifyRequest,
) => Promise<{ status: 200; identity: Identity } | { status: 401 | 403 }> {
  return async (request) => {
    const identity = await access.caller(request);
    if (!identity) return { status: 401 };
    return (await access.administrators.isAdministrator(
      identity.externalUserId,
    ))
      ? { status: 200, identity }
      : { status: 403 };
  };
}

/**
 * Organization administrators manage each other from the app (ADR 0172).
 * Service connections themselves are the ordinary `/api/service-connections`
 * routes, which an administrator's `connections:write` opens.
 */
export function registerAdministratorRoutes(
  app: FastifyInstance,
  options: AdministratorAccess,
): void {
  const administrator = administratorCaller(options);
  const refusal = (status: 401 | 403) =>
    status === 401
      ? { error: "Unauthorized" }
      : { error: "Only organization administrators manage administrators" };

  app.get("/api/work/administrators", async (request, reply) => {
    const caller = await administrator(request);
    if (caller.status !== 200)
      return reply.status(caller.status).send(refusal(caller.status));
    return { administrators: await options.administrators.list() };
  });

  app.post("/api/work/administrators", async (request, reply) => {
    const caller = await administrator(request);
    if (caller.status !== 200)
      return reply.status(caller.status).send(refusal(caller.status));
    const body = z.strictObject({ email: z.email() }).safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: "An email address is required" });
    try {
      const user = await options.administrators.promote(body.data);
      return reply.status(201).send({
        administrator: { userId: user.id, email: user.email, name: user.name },
      });
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Promotion failed",
      });
    }
  });

  app.delete("/api/work/administrators/:userId", async (request, reply) => {
    const caller = await administrator(request);
    if (caller.status !== 200)
      return reply.status(caller.status).send(refusal(caller.status));
    const { userId } = z
      .object({ userId: z.string().min(1) })
      .parse(request.params);
    try {
      await options.administrators.set({ userId, administrator: false });
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof LastAdministratorError) {
        return reply.status(409).send({ error: error.message });
      }
      throw error;
    }
  });
}
