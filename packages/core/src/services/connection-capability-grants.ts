import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { hashBearer, randomBearer } from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import { toJson } from "./run-coordinator.js";

export class ConnectionCapabilityGrantsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly allocations: ExecutionAllocationsService,
  ) {}

  async issue(args: {
    identity: Identity;
    allocationId: string;
    agentSessionId?: string;
    alias: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; expiresAt: string }> {
    const allocation = await this.allocations.get({
      identity: args.identity,
      allocationId: args.allocationId,
    });
    const binding = allocation?.policy.connections?.find(
      (candidate) => candidate.alias === args.alias,
    );
    if (allocation?.status !== "active" || !binding) {
      throw new Error("Connection grant cannot be issued");
    }
    const token = randomBearer();
    const expiresAt = new Date(
      Date.now() + Math.min(args.ttlSeconds ?? 900, 3600) * 1000,
    );
    if (args.agentSessionId) {
      await this.db
        .updateTable("connection_capability_grants")
        .set({ revoked_at: new Date() })
        .where("agent_session_id", "=", args.agentSessionId)
        .where("binding_id", "=", binding.bindingId)
        .where("revoked_at", "is", null)
        .execute();
    }
    await this.db
      .insertInto("connection_capability_grants")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: allocation.projectId,
        allocation_id: allocation.id,
        agent_session_id: args.agentSessionId ?? null,
        binding_id: binding.bindingId,
        connection_id: binding.connectionId,
        token_hash: hashBearer(token),
        capabilities: toJson(binding.capabilities),
        expires_at: expiresAt,
      })
      .execute();
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async validate(args: { token: string }): Promise<{
    tenantId: string;
    projectId: string;
    allocationId: string;
    agentSessionId: string | null;
    bindingId: string;
  } | null> {
    const row = await this.db
      .selectFrom("connection_capability_grants")
      .where("token_hash", "=", hashBearer(args.token))
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .selectAll()
      .executeTakeFirst();
    return row
      ? {
          tenantId: row.tenant_id,
          projectId: row.project_id,
          allocationId: row.allocation_id,
          agentSessionId: row.agent_session_id,
          bindingId: row.binding_id,
        }
      : null;
  }

  async revokeAllocation(args: { allocationId: string }): Promise<void> {
    await this.db
      .updateTable("connection_capability_grants")
      .set({ revoked_at: new Date() })
      .where("allocation_id", "=", args.allocationId)
      .where("revoked_at", "is", null)
      .execute();
  }
}
