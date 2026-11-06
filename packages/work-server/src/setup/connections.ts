import {
  CONNECTION_NAME_PATTERN,
  ConnectionNameTakenError,
  ConnectionNotFoundError,
  ConnectionPermissionDeniedError,
  type ConnectionsService,
  ConnectionUnavailableError,
  type Identity,
} from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  LastAdministratorError,
  type WorkAdministrators,
} from "../identity/administrators.js";
import { verifyWorkOperatorSecret } from "./operator-access.js";

const ServiceConnectionInput = z.strictObject({
  name: z.string().regex(CONNECTION_NAME_PATTERN),
  providerKind: z.string().min(1),
  /** Defaults to the whole organization. */
  principalKind: z
    .enum(["tenant_service", "project_service"])
    .default("tenant_service"),
  projectId: z.string().uuid().optional(),
  label: z.string().min(1).max(200).optional(),
});

const CompletionInput = z.strictObject({
  authorizationId: z.string().min(1),
  /** The fields a `form` challenge asked for. */
  fields: z.record(z.string(), z.string()).default({}),
});

const Params = z.object({ connectionId: z.string().uuid() });

/**
 * Organization setup on the loopback operator listener (ADR 0172): who
 * administers, and the named service connections Environments bind. The
 * operator acts as the host's root identity; a form challenge completes
 * here, a URL challenge through the server's public authorization callback.
 */
export function registerConnectionSetup(args: {
  app: FastifyInstance;
  operatorSecret: string;
  operatorIdentity: Identity;
  connections: () => ConnectionsService | undefined;
  administrators: WorkAdministrators;
  /** The public origin, for the authorization callback. */
  publicBase: string;
}): void {
  args.app.register(async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      const value = request.headers.authorization;
      if (
        !verifyWorkOperatorSecret(
          Array.isArray(value) ? value[0] : value,
          args.operatorSecret,
        )
      )
        return reply
          .status(401)
          .send({ error: "Operator credential required" });
    });
    const identity = args.operatorIdentity;
    const service = (reply: FastifyReply) => {
      const connections = args.connections();
      if (!connections) {
        void reply.status(503).send({
          error:
            "No connection providers are configured. Declare them in WORK_GATEWAY_CONFIG.",
        });
      }
      return connections;
    };

    app.get("/_work/operator/connection-providers", async (_request, reply) => {
      const connections = service(reply);
      if (!connections) return reply;
      return { providers: connections.providerCatalog() };
    });

    app.get("/_work/operator/service-connections", async (_request, reply) => {
      const connections = service(reply);
      if (!connections) return reply;
      return {
        connections: await connections.listServices({ identity }),
      };
    });

    app.post("/_work/operator/service-connections", async (request, reply) => {
      const connections = service(reply);
      if (!connections) return reply;
      const body = ServiceConnectionInput.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: firstIssue(body.error) });
      if (
        !connections
          .providerCatalog()
          .some((provider) => provider.kind === body.data.providerKind)
      ) {
        return reply.status(400).send({
          error: `Unknown connection provider '${body.data.providerKind}'`,
        });
      }
      if (body.data.principalKind === "project_service" && !body.data.projectId)
        return reply
          .status(400)
          .send({ error: "A project service connection names its project" });
      return handle(reply, async () =>
        reply.status(201).send(
          await connections.createService({
            identity,
            name: body.data.name,
            providerKind: body.data.providerKind,
            principalKind: body.data.principalKind,
            ...(body.data.projectId ? { projectId: body.data.projectId } : {}),
            ...(body.data.label ? { label: body.data.label } : {}),
          }),
        ),
      );
    });

    // Starts (or, on a ready connection, rotates) authorization.
    app.post(
      "/_work/operator/service-connections/:connectionId/authorize",
      async (request, reply) => {
        const connections = service(reply);
        if (!connections) return reply;
        const params = Params.safeParse(request.params);
        if (!params.success)
          return reply.status(400).send({ error: "Invalid connection id" });
        return handle(reply, () =>
          connections.beginServiceAuthorization({
            identity,
            connectionId: params.data.connectionId,
            redirectUri: `${args.publicBase}/api/connection-authorizations/callback`,
          }),
        );
      },
    );

    app.post(
      "/_work/operator/service-connections/:connectionId/authorize/complete",
      async (request, reply) => {
        const connections = service(reply);
        if (!connections) return reply;
        const body = CompletionInput.safeParse(request.body);
        if (!body.success)
          return reply.status(400).send({ error: firstIssue(body.error) });
        return handle(reply, () =>
          connections.completeAuthorization({
            identity,
            state: body.data.authorizationId,
            callback: body.data.fields,
          }),
        );
      },
    );

    app.delete(
      "/_work/operator/service-connections/:connectionId",
      async (request, reply) => {
        const connections = service(reply);
        if (!connections) return reply;
        const params = Params.safeParse(request.params);
        if (!params.success)
          return reply.status(400).send({ error: "Invalid connection id" });
        return handle(reply, async () => {
          await connections.revoke({
            identity,
            connectionId: params.data.connectionId,
          });
          return reply.status(204).send();
        });
      },
    );

    app.get("/_work/operator/administrators", async () => ({
      administrators: await args.administrators.list(),
    }));

    app.post("/_work/operator/administrators", async (request, reply) => {
      const body = z.strictObject({ email: z.email() }).safeParse(request.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ error: "An email address is required" });
      try {
        const user = await args.administrators.promote(body.data);
        return reply.status(201).send({
          administrator: {
            userId: user.id,
            email: user.email,
            name: user.name,
          },
        });
      } catch (error) {
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Promotion failed",
        });
      }
    });

    app.delete(
      "/_work/operator/administrators/:userId",
      async (request, reply) => {
        const { userId } = z
          .object({ userId: z.string().min(1) })
          .parse(request.params);
        // The operator may remove the last administrator; the machine
        // credential remains the way back in.
        await args.administrators.set({
          userId,
          administrator: false,
          allowNone: true,
        });
        return reply.status(204).send();
      },
    );
  });
}

async function handle(
  reply: FastifyReply,
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectionNotFoundError)
      return reply.status(404).send({ error: error.message });
    if (
      error instanceof ConnectionNameTakenError ||
      error instanceof ConnectionUnavailableError ||
      error instanceof LastAdministratorError
    )
      return reply.status(409).send({ error: error.message });
    if (error instanceof ConnectionPermissionDeniedError)
      return reply.status(403).send({ error: error.message });
    return reply.status(400).send({
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue
    ? `${issue.path.join(".") || "input"}: ${issue.message}`
    : "Invalid input";
}
