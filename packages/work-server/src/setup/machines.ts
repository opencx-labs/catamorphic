import type { WorkerNodesService } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { MachineReconciler } from "../workers/machine-rules.js";
import { WorkerPlacementSchema } from "../workers/placement.js";
import type { WorkWorkerRegistry } from "../workers/worker-registry.js";
import { verifyWorkOperatorSecret } from "./operator-access.js";

const MachineParams = z.object({ nodeId: z.string().min(1) });
const MachineUpdate = z.strictObject({ enabled: z.boolean() });

/** Machine inventory is Work server setup authority, never a project-role bypass. */
export function registerMachineSetup(args: {
  app: FastifyInstance;
  nodes: WorkerNodesService;
  workers: WorkWorkerRegistry;
  /** The origin a worker reaches, for the printed start command. */
  publicBase: string;
  tenantId: string;
  authorityId: string;
  operatorSecret: string;
  /** Machine rules, when a provisioner is configured (ADR 0167). */
  machines?: MachineReconciler;
}) {
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
    // Remote workers (ADR 0164): enroll with a one-time code, list, revoke.
    app.post("/_work/operator/workers", async (request, reply) => {
      const body = z
        .strictObject({
          name: z.string().min(1),
          ttlMinutes: z.number().int().positive().max(1440).optional(),
          labels: z.unknown().optional(),
          access: z.unknown().optional(),
          trusted: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: firstIssue(body.error) });
      const { labels, access, trusted, ...rest } = body.data;
      const placement = WorkerPlacementSchema.safeParse({
        ...(labels === undefined ? {} : { labels }),
        ...(access === undefined ? {} : { access }),
        ...(trusted === undefined ? {} : { trusted }),
      });
      if (!placement.success)
        return reply.status(400).send({ error: firstIssue(placement.error) });
      try {
        const enrollment = await args.workers.createEnrollment({
          ...rest,
          placement: placement.data,
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
        return reply.status(400).send({
          error: error instanceof Error ? error.message : "Enrollment failed",
        });
      }
    });
    app.get("/_work/operator/workers", async () => ({
      workers: await args.workers.list(),
    }));
    // Whose work a worker takes and its labels (ADR 0167).
    app.patch("/_work/operator/workers/:name", async (request, reply) => {
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
        return reply.status(400).send({
          error:
            error instanceof z.ZodError
              ? firstIssue(error)
              : error instanceof Error
                ? error.message
                : "Update failed",
        });
      }
    });
    app.delete("/_work/operator/workers/:name", async (request, reply) => {
      const params = z
        .object({ name: z.string().min(1) })
        .safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "Provide a worker name" });
      return (await args.workers.revoke(params.data))
        ? { ok: true }
        : reply.status(404).send({ error: "Worker not found" });
    });
    // Machine rules: dedicated or shared machines per directory group.
    const withRules = async (
      reply: FastifyReply,
      run: (machines: MachineReconciler) => Promise<unknown>,
    ) => {
      if (!args.machines)
        return reply.status(409).send({
          error:
            "Machine rules need a machine provisioner; extend the Work server with the machineProvisioner hook",
        });
      try {
        return await run(args.machines);
      } catch (error) {
        return reply.status(400).send({
          error:
            error instanceof z.ZodError
              ? firstIssue(error)
              : error instanceof Error
                ? error.message
                : "Machine rules failed",
        });
      }
    };
    app.get("/_work/operator/machine-rules", (_request, reply) =>
      withRules(reply, async (machines) => ({ rules: await machines.rules() })),
    );
    app.put("/_work/operator/machine-rules/:name", (request, reply) =>
      withRules(reply, async (machines) => {
        const { name } = z.object({ name: z.string() }).parse(request.params);
        const rule = await machines.setRule({ name, rule: request.body });
        return { rule, reconcile: await machines.reconcile() };
      }),
    );
    app.delete("/_work/operator/machine-rules/:name", (request, reply) =>
      withRules(reply, async (machines) => {
        const { name } = z.object({ name: z.string() }).parse(request.params);
        if (!(await machines.deleteRule(name)))
          return reply.status(404).send({ error: "Rule not found" });
        return { reconcile: await machines.reconcile() };
      }),
    );
    app.post("/_work/operator/machine-rules/reconcile", (_request, reply) =>
      withRules(reply, (machines) => machines.reconcile()),
    );
    app.get("/_work/operator/machines", async () => ({
      authorityId: args.authorityId,
      machines: await args.nodes.list(args),
    }));
    app.get(
      "/_work/operator/machines/:nodeId/workspaces",
      async (request, reply) => {
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
    );
    app.post(
      "/_work/operator/machines/:nodeId/workspaces/:allocationId/confirm-destroyed",
      async (request, reply) => {
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
    );
    app.patch("/_work/operator/machines/:nodeId", async (request, reply) => {
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
    });
  });
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue
    ? `${issue.path.join(".") || "request"}: ${issue.message}`
    : "Invalid request";
}
