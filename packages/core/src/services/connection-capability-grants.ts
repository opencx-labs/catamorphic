import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { hashBearer, randomBearer } from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import { toJson } from "./run-coordinator.js";

/**
 * Where a grant is used (ADR 0175). `mcp`: the harness's connection MCP
 * servers, on the control plane. `sandbox`: written into the session's
 * sandbox for the Git gateway and renewed while the session runs.
 */
export type ConnectionGrantChannel = "mcp" | "sandbox";

/** A grant as the gateway sees it once its bearer checks out. */
export interface ValidConnectionGrant {
  tenantId: string;
  projectId: string;
  allocationId: string;
  agentSessionId: string | null;
  alias: string;
  channel: ConnectionGrantChannel;
  capabilities: readonly string[];
}

/** Longest a grant lives; the control plane renews sandbox grants sooner. */
export const MAX_GRANT_TTL_SECONDS = 3600;

export class ConnectionCapabilityGrantsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly allocations: ExecutionAllocationsService,
  ) {}

  /**
   * Issue a bearer bound to one allocation, session, alias, and the
   * binding's capabilities. A session keeps one live grant per alias and
   * channel: issuing again revokes the previous one.
   */
  async issue(args: {
    identity: Identity;
    allocationId: string;
    agentSessionId?: string;
    alias: string;
    ttlSeconds?: number;
    channel?: ConnectionGrantChannel;
  }): Promise<{ token: string; expiresAt: string }> {
    const channel = args.channel ?? "mcp";
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
      Date.now() +
        Math.min(args.ttlSeconds ?? 900, MAX_GRANT_TTL_SECONDS) * 1000,
    );
    if (args.agentSessionId) {
      await this.db
        .updateTable("connection_capability_grants")
        .set({ revoked_at: new Date() })
        .where("agent_session_id", "=", args.agentSessionId)
        .where("alias", "=", binding.alias)
        .where("channel", "=", channel)
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
        alias: binding.alias,
        connection_id: binding.connectionId,
        token_hash: hashBearer(token),
        capabilities: toJson(binding.capabilities),
        expires_at: expiresAt,
        channel,
      })
      .execute();
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async validate(args: {
    token: string;
  }): Promise<ValidConnectionGrant | null> {
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
          alias: row.alias,
          channel: row.channel === "sandbox" ? "sandbox" : "mcp",
          capabilities: Array.isArray(row.capabilities)
            ? row.capabilities.filter(
                (item): item is string => typeof item === "string",
              )
            : [],
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
