import type { Json } from "@catamorphic/db";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";

export function registerConnectionMcpRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  app.post(
    "/connection-mcp",
    { config: { public: true } },
    async (request, reply) => {
      const grants = ctx.core?.connectionGrants;
      const broker = ctx.core?.connectionBroker;
      if (!grants || !broker || !ctx.core) {
        return reply
          .status(503)
          .send({ error: "Connection broker not configured" });
      }
      const token = bearer(request.headers.authorization);
      const grant = token ? await grants.validate({ token }) : null;
      if (!grant)
        return reply.status(401).send({ error: "Invalid connection grant" });
      const identity = {
        tenantId: grant.tenantId,
        externalUserId: `connection-grant:${grant.agentSessionId ?? grant.allocationId}`,
      };
      const allocation = await ctx.core.executionAllocations.get({
        identity,
        allocationId: grant.allocationId,
      });
      const binding = allocation?.policy.connections?.find(
        (candidate) => candidate.bindingId === grant.bindingId,
      );
      if (allocation?.status !== "active" || !binding) {
        return reply
          .status(401)
          .send({ error: "Connection grant is no longer active" });
      }
      const rawBody = record(request.body);
      const method =
        rawBody.jsonrpc === "2.0" && typeof rawBody.method === "string"
          ? rawBody.method
          : undefined;
      const id = rpcId(rawBody.id);
      if (!method) {
        return reply.send(rpcError(id, -32600, "Invalid Request"));
      }
      const respond = (result: unknown) => ({
        jsonrpc: "2.0" as const,
        id,
        result,
      });
      if (method === "initialize") {
        return reply.send(
          respond({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "catamorphic-connection-broker", version: "1" },
          }),
        );
      }
      if (method === "notifications/initialized")
        return reply.status(202).send();
      if (method === "tools/list") {
        try {
          const tools = await broker.listActions({
            identity,
            allocationId: allocation.id,
            alias: binding.alias,
          });
          return reply.send(respond({ tools }));
        } catch {
          return reply.send(rpcError(id, -32_000, "Connection action failed"));
        }
      }
      if (method === "tools/call") {
        const params = record(rawBody.params);
        const name = typeof params.name === "string" ? params.name : "";
        if (!binding.capabilities.includes(name)) {
          return reply.send(
            rpcError(id, -32602, "Tool is outside the connection grant"),
          );
        }
        try {
          const output = await broker.invoke({
            identity,
            allocationId: allocation.id,
            alias: binding.alias,
            action: name,
            input: toJson(params.arguments),
          });
          return reply.send(
            respond({
              content: [{ type: "text", text: JSON.stringify(output) }],
              structuredContent: output,
            }),
          );
        } catch {
          return reply.send(rpcError(id, -32_000, "Connection action failed"));
        }
      }
      return reply.send(rpcError(id, -32601, "Method not found"));
    },
  );
}

function rpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function bearer(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
