import type { WorkerNodesService } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type AdministratorAccess,
  administratorCaller,
} from "../identity/administrator-routes.js";
import type { InstallTarget } from "../workers/install-script.js";
import type { MachineClass } from "../workers/machine-classes.js";
import type { MachineReconciler } from "../workers/machine-rules.js";
import { WorkerPlacementSchema } from "../workers/placement.js";
import type { WorkWorkerRegistry } from "../workers/worker-registry.js";
import { verifyWorkOperatorSecret } from "./operator-access.js";

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
  /** Machine classes (ADR 0204), to check pooled enrollments. */
  classes: Readonly<Record<string, MachineClass>>;
  /** What machines install, for the printed install command. */
  install: { target: InstallTarget } | { unavailable: string };
  /** Machine rules, when classes or a provisioner are configured. */
  machines?: MachineReconciler;
}

type Handler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

/**
 * One machine action and where it lives: the loopback operator listener,
 * and for what administrators may also do, the public API (ADR 0204).
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
 * Organization administrators manage workers and machine rules through the
 * public API as the operator does on the loopback listener (ADR 0204), with
 * the same handlers.
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

function machineRoutes(args: MachineManagement): MachineRoute[] {
  // Machine rules: dedicated or shared machines per directory group.
  const withRules = async (
    reply: FastifyReply,
    run: (machines: MachineReconciler) => Promise<unknown>,
  ) => {
    if (!args.machines)
      return reply.status(409).send({
        error:
          "Machine rules need machine classes: set WORK_MACHINES_CONFIG, or extend the Work server with the machineProvisioner hook",
      });
    try {
      return await run(args.machines);
    } catch (error) {
      return reply
        .status(400)
        .send({ error: errorMessage(error, "Machine rules failed") });
    }
  };
  return [
    // Remote workers (ADR 0164): enroll with a one-time code, list, revoke.
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
            access: z.unknown().optional(),
            trusted: z.boolean().optional(),
            /** A pooled machine rules assign (ADR 0204). */
            pool: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!body.success)
          return reply.status(400).send({ error: firstIssue(body.error) });
        const { labels, access, trusted, pool, ...rest } = body.data;
        if (pool && (access !== undefined || trusted !== undefined))
          return reply.status(400).send({
            error:
              "A pooled machine takes no work until a machine rule assigns it; leave out access and trusted",
          });
        const placement = WorkerPlacementSchema.safeParse({
          ...(labels === undefined ? {} : { labels }),
          ...(access === undefined ? {} : { access }),
          ...(trusted === undefined ? {} : { trusted }),
        });
        if (!placement.success)
          return reply.status(400).send({ error: firstIssue(placement.error) });
        if (pool) {
          const poolClass = placement.data.labels.class;
          const pools = Object.entries(args.classes)
            .filter(([, machineClass]) => machineClass.platform === "pool")
            .map(([name]) => name);
          if (!poolClass || !pools.includes(poolClass))
            return reply.status(400).send({
              error: `A pooled machine needs labels.class naming a pool class (${
                pools.join(", ") || "none configured in WORK_MACHINES_CONFIG"
              })`,
            });
        }
        try {
          const enrollment = await args.workers.createEnrollment({
            ...rest,
            placement: placement.data,
            ...(pool ? { pool } : {}),
          });
          return reply.status(201).send({
            ...enrollment,
            controlPlaneUrl: args.publicBase,
            // The code is single-use; hand it to the new machine's service
            // configuration, never to a chat or a repository.
            start:
              "WORK_CONTROL_PLANE_URL=<url> WORK_WORKER_ENROLLMENT=<code> bun apps/server/src/worker.ts",
            ...("target" in args.install
              ? {
                  install: `curl -fsSL ${args.install.target.controlPlaneUrl}/api/workers/install.sh | sudo sh -s -- --code ${enrollment.code}`,
                }
              : {}),
          });
        } catch (error) {
          return reply
            .status(400)
            .send({ error: errorMessage(error, "Enrollment failed") });
        }
      },
    },
    {
      method: "GET",
      operator: "/_work/operator/workers",
      admin: "/api/work/machines/workers",
      handler: async () => ({ workers: await args.workers.list() }),
    },
    // Whose work a worker takes and its labels (ADR 0167).
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
            access: z.unknown().optional(),
            trusted: z.boolean().optional(),
          })
          .safeParse(request.body);
        if (!params.success || !body.success)
          return reply
            .status(400)
            .send({ error: "Provide labels, access, or trusted" });
        try {
          return {
            placement: await args.workers.setPlacement({
              name: params.data.name,
              placement: Object.fromEntries(
                Object.entries(body.data).filter(([, v]) => v !== undefined),
              ),
            }),
          };
        } catch (error) {
          return reply
            .status(400)
            .send({ error: errorMessage(error, "Update failed") });
        }
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
        return (await args.workers.revoke(params.data))
          ? { ok: true }
          : reply.status(404).send({ error: "Worker not found" });
      },
    },
    {
      method: "GET",
      operator: "/_work/operator/machine-rules",
      admin: "/api/work/machines/rules",
      handler: (_request, reply) =>
        withRules(reply, async (machines) => ({
          rules: await machines.rules(),
          status: await machines.status(),
        })),
    },
    {
      method: "PUT",
      operator: "/_work/operator/machine-rules/:name",
      admin: "/api/work/machines/rules/:name",
      handler: (request, reply) =>
        withRules(reply, async (machines) => {
          const { name } = z.object({ name: z.string() }).parse(request.params);
          const rule = await machines.setRule({ name, rule: request.body });
          return { rule, reconcile: await machines.reconcile() };
        }),
    },
    {
      method: "DELETE",
      operator: "/_work/operator/machine-rules/:name",
      admin: "/api/work/machines/rules/:name",
      handler: (request, reply) =>
        withRules(reply, async (machines) => {
          const { name } = z.object({ name: z.string() }).parse(request.params);
          if (!(await machines.deleteRule(name)))
            return reply.status(404).send({ error: "Rule not found" });
          return { reconcile: await machines.reconcile() };
        }),
    },
    {
      method: "POST",
      operator: "/_work/operator/machine-rules/reconcile",
      admin: "/api/work/machines/rules/reconcile",
      handler: (_request, reply) =>
        withRules(reply, (machines) => machines.reconcile()),
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
        const changed = await args.nodes.setEnabled({
          ...args,
          nodeId: params.data.nodeId,
          enabled: body.data.enabled,
        });
        if (!changed)
          return reply.status(404).send({ error: "Machine not found" });
        return { ok: true };
      },
    },
  ];
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
