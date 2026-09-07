import type { WorkerNodesService } from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyStockOperatorSecret } from "./operator-access.js";

const MachineParams = z.object({ nodeId: z.string().min(1) });
const MachineUpdate = z.strictObject({ enabled: z.boolean() });

/** Machine inventory is stock-host setup authority, never a project-role bypass. */
export function registerMachineSetup(args: {
  app: FastifyInstance;
  nodes: WorkerNodesService;
  tenantId: string;
  authorityId: string;
  operatorSecret: string;
}) {
  args.app.register(async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      const value = request.headers.authorization;
      if (
        !verifyStockOperatorSecret(
          Array.isArray(value) ? value[0] : value,
          args.operatorSecret,
        )
      )
        return reply
          .status(401)
          .send({ error: "Operator credential required" });
    });
    app.get("/_catamorphic/operator/machines", async () => ({
      authorityId: args.authorityId,
      machines: await args.nodes.list(args),
    }));
    app.get(
      "/_catamorphic/operator/machines/:nodeId/workspaces",
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
      "/_catamorphic/operator/machines/:nodeId/workspaces/:allocationId/confirm-destroyed",
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
    app.patch(
      "/_catamorphic/operator/machines/:nodeId",
      async (request, reply) => {
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
    );
  });
}
