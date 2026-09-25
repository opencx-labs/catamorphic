import { createHash } from "node:crypto";
import type { Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Identity } from "../identity.js";
import { identityMayUseConnection } from "../identity.js";
import {
  type ConnectionActionGuard,
  type ConnectionGuardRecord,
  reviewConnectionAction,
} from "./connection-guards.js";
import {
  type ConnectionProviderRegistry,
  isConnectionAuthorizationExpiredError,
} from "./connection-providers.js";
import {
  type ConnectionsService,
  ConnectionUnavailableError,
} from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import type { ToolPermissionChannel } from "./tool-permission-broker.js";
import type { WorkflowEnablementsService } from "./workflow-enablements-service.js";

const tracer = getTracer("@catamorphic/core");

/** A guard refused a brokered action, or the person asked declined it. */
export class ConnectionActionDeniedError extends Error {
  readonly code = "connection_action_denied";

  constructor(readonly reason: string) {
    super(`Connection action denied: ${reason}`);
    this.name = "ConnectionActionDeniedError";
  }
}

/** Review policy for every brokered action (ADR 0162). */
export interface ConnectionGateway {
  guards: readonly ConnectionActionGuard[];
  /** Where an escalated agent action asks its person for approval. */
  approvals?: ToolPermissionChannel;
  /** The member who owns an agent session, for review and audit. */
  sessionOwner?: (sessionId: string) => Promise<string | undefined>;
}

export class ConnectionBroker {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly providers: ConnectionProviderRegistry,
    private readonly allocations: ExecutionAllocationsService,
    private readonly workflowEnablements?: () => WorkflowEnablementsService,
    private readonly gateway: ConnectionGateway = { guards: [] },
  ) {}

  async listActions(args: {
    identity: Identity;
    allocationId: string;
    alias: string;
  }) {
    const { binding, provider } = await this.resolveInvocation({
      ...args,
    });
    await this.connections.refreshIfNeeded({
      identity: args.identity,
      connectionId: binding.connectionId,
    });
    const listActions = provider.listActions;
    if (!listActions) {
      return binding.capabilities.map((name) => ({
        name,
        description: `${binding.alias} ${name}`,
        inputSchema: { type: "object", additionalProperties: true } as Json,
      }));
    }
    return this.connections.withCredential({
      identity: args.identity,
      connectionId: binding.connectionId,
      use: (material) =>
        listActions({
          material,
          capabilities: binding.capabilities,
        }),
    });
  }

  async invoke(args: {
    identity: Identity;
    allocationId: string;
    alias: string;
    action: string;
    input: Json;
    caller?: "agent" | "workflow";
    agentSessionId?: string;
  }): Promise<Json> {
    return withSpan(
      {
        tracer,
        name: "connection.invoke",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.allocation.id": args.allocationId,
          "catamorphic.connection.alias": args.alias,
          "catamorphic.connection.action": args.action,
        },
      },
      () => this.invokeUninstrumented(args),
    );
  }

  private async invokeUninstrumented(args: {
    identity: Identity;
    allocationId: string;
    alias: string;
    action: string;
    input: Json;
    caller?: "agent" | "workflow";
    agentSessionId?: string;
  }): Promise<Json> {
    const { allocation, binding, provider } =
      await this.resolveInvocation(args);
    const digest = createHash("sha256")
      .update(JSON.stringify(args.input))
      .digest("hex");
    if (!binding.capabilities.includes(args.action)) {
      await this.connections.audit({
        identity: args.identity,
        projectId: allocation.projectId,
        connectionId: binding.connectionId,
        allocationId: allocation.id,
        eventType: "connection.invoked",
        outcome: "denied",
        action: args.action,
        argumentsDigest: digest,
      });
      throw new Error(`Connection action '${args.action}' is not permitted`);
    }
    const review = await this.review({
      ...args,
      projectId: allocation.projectId,
      connection: {
        id: binding.connectionId,
        kind: binding.providerKind,
        alias: binding.alias,
      },
    });
    if (review.verdict === "deny") {
      await this.connections.audit({
        identity: args.identity,
        projectId: allocation.projectId,
        connectionId: binding.connectionId,
        allocationId: allocation.id,
        eventType: "connection.invoked",
        outcome: "denied",
        action: args.action,
        argumentsDigest: digest,
        metadata: review.metadata,
      });
      throw new ConnectionActionDeniedError(review.reason);
    }
    try {
      await this.connections.refreshIfNeeded({
        identity: args.identity,
        connectionId: binding.connectionId,
      });
      const result = await this.connections.withCredential({
        identity: args.identity,
        connectionId: binding.connectionId,
        use: (material) =>
          provider.invoke({
            material,
            action: args.action,
            input: args.input,
            capabilities: binding.capabilities,
          }),
      });
      await this.connections.audit({
        identity: args.identity,
        projectId: allocation.projectId,
        connectionId: binding.connectionId,
        allocationId: allocation.id,
        eventType: "connection.invoked",
        outcome: "allowed",
        action: args.action,
        argumentsDigest: digest,
        metadata: review.metadata,
      });
      return result;
    } catch (cause) {
      await this.connections.audit({
        identity: args.identity,
        projectId: allocation.projectId,
        connectionId: binding.connectionId,
        allocationId: allocation.id,
        eventType: "connection.invoked",
        outcome: "error",
        action: args.action,
        argumentsDigest: digest,
        metadata: review.metadata,
      });
      if (
        cause instanceof ConnectionUnavailableError ||
        isConnectionAuthorizationExpiredError(cause)
      ) {
        if (allocation.policy.workflowEnablementId) {
          await this.workflowEnablements?.().suspendForConnection({
            identity: args.identity,
            connectionId: binding.connectionId,
          });
        }
        throw new ConnectionUnavailableError(
          args.alias,
          isConnectionAuthorizationExpiredError(cause)
            ? "Connection authorization has expired"
            : "Connection is unavailable",
          binding.connectionId,
        );
      }
      throw cause;
    }
  }

  /**
   * Run the gateway's guards. Escalations ask the agent session's person;
   * a workflow cannot wait on a person mid-step, so it is refused.
   */
  private async review(args: {
    identity: Identity;
    projectId: string;
    allocationId: string;
    connection: { id: string; kind: string; alias: string };
    action: string;
    input: Json;
    caller?: "agent" | "workflow";
    agentSessionId?: string;
  }): Promise<
    | { verdict: "allow"; metadata: Json }
    | { verdict: "deny"; reason: string; metadata: Json }
  > {
    if (this.gateway.guards.length === 0) {
      return { verdict: "allow", metadata: {} };
    }
    const caller = args.caller ?? "workflow";
    const actor =
      (args.agentSessionId &&
        (await this.gateway.sessionOwner?.(args.agentSessionId))) ||
      args.identity.externalUserId;
    const outcome = await reviewConnectionAction({
      guards: this.gateway.guards,
      context: {
        tenantId: args.identity.tenantId,
        projectId: args.projectId,
        actor,
        caller,
        ...(args.agentSessionId ? { agentSessionId: args.agentSessionId } : {}),
        allocationId: args.allocationId,
        connection: args.connection,
        action: args.action,
        input: args.input,
      },
    });
    const metadata = (
      records: ConnectionGuardRecord[],
      approval?: "approved" | "denied" | "unavailable",
    ): Json => ({
      actor,
      caller,
      guards: records.map((record) => ({ ...record })),
      ...(approval ? { approval } : {}),
    });
    if (outcome.verdict === "allow") {
      return { verdict: "allow", metadata: metadata(outcome.records) };
    }
    if (outcome.verdict === "deny") {
      return {
        verdict: "deny",
        reason: outcome.reason,
        metadata: metadata(outcome.records),
      };
    }
    if (caller !== "agent" || !args.agentSessionId || !this.gateway.approvals) {
      return {
        verdict: "deny",
        reason: `requires human approval (${outcome.reason})`,
        metadata: metadata(outcome.records, "unavailable"),
      };
    }
    const decision = await this.gateway.approvals.handlerFor(
      "Connection gateway",
    )({
      sessionId: args.agentSessionId,
      server: `connection_${args.connection.alias}`,
      tool: args.action,
      description: `Needs your approval: ${outcome.reason}`,
      input: jsonRecord(args.input),
    });
    return decision.decision === "allow"
      ? { verdict: "allow", metadata: metadata(outcome.records, "approved") }
      : {
          verdict: "deny",
          reason: `not approved (${outcome.reason})`,
          metadata: metadata(outcome.records, "denied"),
        };
  }

  private async resolveInvocation(args: {
    identity: Identity;
    allocationId: string;
    alias: string;
  }) {
    const allocation = await this.allocations.get({
      identity: args.identity,
      allocationId: args.allocationId,
    });
    if (allocation?.status !== "active") {
      throw new Error("Allocation is unavailable");
    }
    const binding = allocation.policy.connections?.find(
      (candidate) => candidate.alias === args.alias,
    );
    if (!binding) {
      throw new Error(`Connection alias '${args.alias}' is unavailable`);
    }
    if (allocation.policy.workflowEnablementId) {
      try {
        await this.workflowEnablements?.().revalidate({
          identity: args.identity,
          enablementId: allocation.policy.workflowEnablementId,
        });
      } catch {
        throw new ConnectionUnavailableError(
          args.alias,
          "Workflow enablement authority is unavailable",
          binding.connectionId,
        );
      }
    }
    if (
      !identityMayUseConnection(
        args.identity,
        allocation.projectId,
        allocation.environmentName,
        args.alias,
      )
    ) {
      throw new Error("Connection permission denied");
    }
    const provider = this.providers.get(binding.providerKind);
    if (!provider) throw new Error("Connection provider is unavailable");
    return { allocation, binding, provider };
  }
}

function jsonRecord(value: Json): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : { value };
}
