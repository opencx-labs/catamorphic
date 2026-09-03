import { createHash } from "node:crypto";
import type { Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Identity } from "../identity.js";
import { identityMayUseConnection } from "../identity.js";
import {
  type ConnectionProviderRegistry,
  isConnectionAuthorizationExpiredError,
} from "./connection-providers.js";
import {
  type ConnectionsService,
  ConnectionUnavailableError,
} from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import type { WorkflowEnablementsService } from "./workflow-enablements-service.js";

const tracer = getTracer("@catamorphic/core");

export class ConnectionBroker {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly providers: ConnectionProviderRegistry,
    private readonly allocations: ExecutionAllocationsService,
    private readonly workflowEnablements?: () => WorkflowEnablementsService,
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
  }): Promise<Json> {
    return withSpan(
      {
        tracer,
        name: "connection.invoke",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
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
