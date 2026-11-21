import type { WorkerNodesService } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type AdministratorAccess,
  administratorCaller,
} from "../identity/administrator-routes.js";
import type { WorkMachines } from "../machines/work-machines.js";
import { WorkerPlacementSchema } from "../workers/placement.js";
import {
  isWorkerNode,
  WORKER_NODE_PREFIX,
  type WorkWorkerRegistry,
} from "../workers/worker-registry.js";
import { verifyWorkOperatorSecret } from "./operator-access.js";

/** A placement's fields as written: each is optional in a request. */
const PlacementInput = WorkerPlacementSchema.partial();

const MachineParams = z.object({ nodeId: z.string().min(1) });
const MachineUpdate = z.strictObject({ enabled: z.boolean() });

/** What machine management works with, on either listener. */
export interface MachineManagement {
  nodes: WorkerNodesService;
  workers: WorkWorkerRegistry;
  /** The origin a worker reaches, for the printed start command. */
  publicBase: string;
  tenantId: string;
  authorityId: string;
  /** The sequencer, when the host passed a machines hook (ADR 0347). */
  machines?: WorkMachines;
  /** The account a verified email names, for `for: [{ email }]`. */
  userIdForEmail(email: string): Promise<string | undefined>;
}

type Handler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

/**
 * One machine action and where it lives: the loopback operator listener,
 * and for what administrators may also do, the public API (ADR 0205).
 */
interface MachineRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  operator: string;
  admin?: string;
  handler: Handler;
}

/** Machine inventory is Work server setup authority, never a project-role bypass. */
export function registerMachineSetup(
  args: MachineManagement & { app: FastifyInstance; operatorSecret: string },
) {
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
    for (const route of machineRoutes(args))
      app.route({
        method: route.method,
        url: route.operator,
        handler: route.handler,
      });
  });
}

/**
 * Organization administrators manage machines through the public API as
 * the operator does on the loopback listener (ADR 0205), with the same
 * handlers.
 */
export function registerMachineAdministration(
  args: MachineManagement & AdministratorAccess & { app: FastifyInstance },
) {
  const administrator = administratorCaller(args);
  args.app.register(async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      const caller = await administrator(request);
      if (caller.status === 401)
        return reply.status(401).send({ error: "Unauthorized" });
      if (caller.status === 403)
        return reply.status(403).send({
          error: "Only organization administrators manage machines",
        });
    });
    for (const route of machineRoutes(args))
      if (route.admin)
        app.route({
          method: route.method,
          url: route.admin,
          handler: route.handler,
        });
  });
}

/**
 * Whom a machine is for, as an operator writes it: principals, where a
 * person may be named by the email they sign in with.
 */
const PrincipalsInput = z
  .array(
    z.union([z.strictObject({ email: z.email().toLowerCase() }), z.unknown()]),
  )
  .max(500);

function machineRoutes(args: MachineManagement): MachineRoute[] {
  /** `{ email }` entries become `{ user }`; an unknown email is refused. */
  const principals = async (value: unknown): Promise<unknown> => {
    const list = PrincipalsInput.parse(value);
    const resolved: unknown[] = [];
    for (const entry of list) {
      const named = z
        .strictObject({ email: z.email().toLowerCase() })
        .safeParse(entry);
      if (!named.success) {
        resolved.push(entry);
        continue;
      }
      const user = await args.userIdForEmail(named.data.email);
      if (!user)
        throw new Error(
          `No account with the verified email ${named.data.email} has signed in to this server`,
        );
      resolved.push({ user });
    }
    return resolved;
  };
  return [
    // Machines enrolled by hand (ADRs 0164, 0347): enroll with a one-time
    // code, list, revoke. The machines hook's own machines enroll themselves.
    {
      method: "POST",
      operator: "/_work/operator/workers",
      admin: "/api/work/machines/workers",
      handler: async (request, reply) => {
        const body = z
          .strictObject({
            name: z.string().min(1),
            ttlMinutes: z.number().int().positive().max(1440).optional(),
            labels: z.unknown().optional(),
            for: z.unknown().optional(),
            trusted: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!body.success)
          return reply.status(400).send({ error: firstIssue(body.error) });
        const { labels, trusted, ...rest } = body.data;
        try {
          const enrollment = await args.workers.createEnrollment({
            name: rest.name,
            ...(rest.ttlMinutes === undefined
              ? {}
              : { ttlMinutes: rest.ttlMinutes }),
            placement: placementInput({
              labels,
              trusted,
              ...(rest.for === undefined
                ? {}
                : { for: await principals(rest.for) }),
            }),
          });
          return reply.status(201).send({
            ...enrollment,
            controlPlaneUrl: args.publicBase,
            // The code is single-use; hand it to the new machine's service
            // configuration, never to a chat or a repository.
            start:
              "WORK_CONTROL_PLANE_URL=<url> WORK_WORKER_ENROLLMENT=<code> bun apps/server/src/worker.ts",
          });
        } catch (error) {
          return reply
            .status(400)
            .send({ error: errorMessage(error, "Enrollment failed") });
        }
      },
    },
    // Every machine Work knows, made by the machines hook or enrolled by
    // hand, with what the latest plan said.
    {
      method: "GET",
      operator: "/_work/operator/workers",
      admin: "/api/work/machines/workers",
      handler: async () => ({
        workers: await args.workers.list(),
        plan: {
          configured: Boolean(args.machines),
          ...(await args.workers.machines.plan()),
        },
      }),
    },
    // Whom a machine enrolled by hand is for, and its labels (ADR 0347).
    {
      method: "PATCH",
      operator: "/_work/operator/workers/:name",
      admin: "/api/work/machines/workers/:name",
      handler: async (request, reply) => {
        const params = z
          .object({ name: z.string().min(1) })
          .safeParse(request.params);
        const body = z
          .strictObject({
            labels: z.unknown().optional(),
            for: z.unknown().optional(),
            trusted: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!params.success || !body.success)
          return reply
            .status(400)
            .send({ error: "Provide labels, for, or trusted" });
        try {
          return {
            placement: await args.workers.setPlacement({
              name: params.data.name,
              placement: placementInput({
                labels: body.data.labels,
                trusted: body.data.trusted,
                ...(body.data.for === undefined
                  ? {}
                  : { for: await principals(body.data.for) }),
              }),
            }),
          };
        } catch (error) {
          return reply
            .status(400)
            .send({ error: errorMessage(error, "Update failed") });
        }
      },
    },
    // The worker rotates its credential and key at its next call (ADR 0207);
    // it also does so on its own every 30 days.
    {
      method: "POST",
      operator: "/_work/operator/workers/:name/rotate",
      admin: "/api/work/machines/workers/:name/rotate",
      handler: async (request, reply) => {
        const params = z
          .object({ name: z.string().min(1) })
          .safeParse(request.params);
        if (!params.success)
          return reply.status(400).send({ error: "Provide a worker name" });
        return (await args.workers.requestRotation(params.data))
          ? { ok: true }
          : reply.status(404).send({ error: "Worker not found" });
      },
    },
    {
      method: "DELETE",
      operator: "/_work/operator/workers/:name",
      admin: "/api/work/machines/workers/:name",
      handler: async (request, reply) => {
        const params = z
          .object({ name: z.string().min(1) })
          .safeParse(request.params);
        if (!params.success)
          return reply.status(400).send({ error: "Provide a worker name" });
        const revoked = await args.workers.revoke(params.data);
        // The plan replaces a machine it still names.
        if (revoked) args.machines?.passSoon();
        return revoked
          ? { ok: true }
          : reply.status(404).send({ error: "Worker not found" });
      },
    },
    // Plan now (ADR 0347): ask the machines hook and act on its answer,
    // answered with what the pass did.
    {
      method: "POST",
      operator: "/_work/operator/machines/plan",
      admin: "/api/work/machines/plan",
      handler: async (_request, reply) => {
        if (!args.machines)
          return reply.status(409).send({
            error:
              "This server makes no machines: pass a machines hook to createWorkServer (hooks.machines), or enroll machines by hand",
          });
        try {
          return await args.machines.pass();
        } catch (error) {
          return reply
            .status(500)
            .send({ error: errorMessage(error, "The machine pass failed") });
        }
      },
    },
    {
      method: "GET",
      operator: "/_work/operator/machines",
      admin: "/api/work/machines",
      handler: async () => ({
        authorityId: args.authorityId,
        machines: await args.nodes.list(args),
      }),
    },
    {
      method: "GET",
      operator: "/_work/operator/machines/:nodeId/workspaces",
      handler: async (request, reply) => {
        const params = MachineParams.safeParse(request.params);
        if (!params.success)
          return reply.status(400).send({ error: "Provide a machine id" });
        return {
          workspaces: await args.nodes.workspaces({
            ...args,
            nodeId: params.data.nodeId,
          }),
        };
      },
    },
    {
      method: "POST",
      operator:
        "/_work/operator/machines/:nodeId/workspaces/:allocationId/confirm-destroyed",
      handler: async (request, reply) => {
        const params = z
          .object({
            nodeId: z.string().min(1),
            allocationId: z.string().uuid(),
          })
          .safeParse(request.params);
        const body = z
          .strictObject({ confirmedDestroyed: z.literal(true) })
          .safeParse(request.body);
        if (!params.success || !body.success)
          return reply.status(400).send({
            error:
              "Inspect the physical backend and confirm this retired workspace was destroyed",
          });
        const confirmed = await args.nodes.confirmWorkspaceDestroyed({
          ...args,
          ...params.data,
        });
        return confirmed
          ? { ok: true }
          : reply.status(409).send({
              error:
                "Only a retired workspace with retained capacity can be confirmed destroyed",
            });
      },
    },
    {
      method: "PATCH",
      operator: "/_work/operator/machines/:nodeId",
      handler: async (request, reply) => {
        const params = MachineParams.safeParse(request.params);
        const body = MachineUpdate.safeParse(request.body);
        if (!params.success || !body.success)
          return reply
            .status(400)
            .send({ error: "Provide a machine id and enabled state" });
        // A worker's machine remembers that an operator disabled it, so
        // it is never called lost and stays off when resumed (ADR 0347).
        const { nodeId } = params.data;
        const changed = isWorkerNode(nodeId)
          ? await args.workers.setDisabled({
              name: nodeId.slice(WORKER_NODE_PREFIX.length),
              disabled: !body.data.enabled,
            })
          : await args.nodes.setEnabled({
              ...args,
              nodeId,
              enabled: body.data.enabled,
            });
        if (changed) args.machines?.passSoon();
        if (!changed)
          return reply.status(404).send({ error: "Machine not found" });
        return { ok: true };
      },
    },
  ];
}

/** A placement as the registry parses it, with only what was given. */
function placementInput(input: {
  labels?: unknown;
  for?: unknown;
  trusted?: boolean | undefined;
}): z.input<typeof PlacementInput> {
  return PlacementInput.parse(
    Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ),
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof z.ZodError
    ? firstIssue(error)
    : error instanceof Error
      ? error.message
      : fallback;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue
    ? `${issue.path.join(".") || "request"}: ${issue.message}`
    : "Invalid request";
}
