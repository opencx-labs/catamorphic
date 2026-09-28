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
    // Issue under a share lock on the Allocation: a release (close, idle
    // release, archive) that commits first leaves nothing to issue against,
    // and one that commits later revokes what this inserted.
    await this.db.transaction().execute(async (trx) => {
      const live = await trx
        .selectFrom("execution_allocations")
        .select("status")
        .where("id", "=", allocation.id)
        .forShare()
        .executeTakeFirst();
      if (live?.status !== "active") {
        throw new Error("Connection grant cannot be issued");
      }
      if (args.agentSessionId) {
        await trx
          .updateTable("connection_capability_grants")
          .set({ revoked_at: new Date() })
          .where("agent_session_id", "=", args.agentSessionId)
          .where("alias", "=", binding.alias)
          .where("channel", "=", channel)
          .where("revoked_at", "is", null)
          .execute();
      }
      await trx
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
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async validate(args: {
    token: string;
  }): Promise<ValidConnectionGrant | null> {
    // A grant is only as live as its Allocation: a released one ends every
    // grant bound to it, even one issued in a race with the release.
    const row = await this.db
      .selectFrom("connection_capability_grants")
      .innerJoin(
        "execution_allocations",
        "execution_allocations.id",
        "connection_capability_grants.allocation_id",
      )
      .where(
        "connection_capability_grants.token_hash",
        "=",
        hashBearer(args.token),
      )
      .where("connection_capability_grants.revoked_at", "is", null)
      .where("connection_capability_grants.expires_at", ">", new Date())
      .where("execution_allocations.status", "=", "active")
      .selectAll("connection_capability_grants")
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

  /**
   * Keep a working session's grants on one channel alive (#122). Harnesses
   * hold MCP grants in static headers, so the control plane extends the
   * same bearer rather than rotating it: at each turn start and on each
   * renewal tick. Only unrevoked grants on an active Allocation extend, so
   * close, idle release and archive still end them; a grant that lapsed
   * while the session was idle comes back when the session works again.
   */
  async extend(args: {
    agentSessionId: string;
    channel: ConnectionGrantChannel;
    ttlSeconds?: number;
  }): Promise<number> {
    const expiresAt = new Date(
      Date.now() +
        Math.min(
          args.ttlSeconds ?? MAX_GRANT_TTL_SECONDS,
          MAX_GRANT_TTL_SECONDS,
        ) *
          1000,
    );
    const rows = await this.db
      .updateTable("connection_capability_grants")
      .set({ expires_at: expiresAt })
      .where("agent_session_id", "=", args.agentSessionId)
      .where("channel", "=", args.channel)
      .where("revoked_at", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("execution_allocations")
            .select("execution_allocations.id")
            .whereRef(
              "execution_allocations.id",
              "=",
              "connection_capability_grants.allocation_id",
            )
            .where("execution_allocations.status", "=", "active"),
        ),
      )
      .returning("id")
      .execute();
    return rows.length;
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
