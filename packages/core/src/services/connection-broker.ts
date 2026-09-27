import { createHash } from "node:crypto";
import type { Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type AgentMode, modeRefusal } from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";
import { identityMayUseConnection } from "../identity.js";
import {
  type ConnectionActionGuard,
  type ConnectionGuardRecord,
  reviewConnectionAction,
} from "./connection-guards.js";
import {
  type ConnectionModelEndpoint,
  type ConnectionProvider,
  type ConnectionProviderRegistry,
  type GitRemoteCredentials,
  isConnectionAuthorizationExpiredError,
} from "./connection-providers.js";
import {
  MODEL_CAPABILITY,
  type ResolvedConnectionBinding,
} from "./connection-types.js";
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

/**
 * A provider refused a request as asked (too costly, too broad, not a single
 * query). The message tells the caller how to narrow it (ADR 0163).
 */
export class ConnectionActionRefusedError extends Error {
  readonly code = "connection_action_refused";

  constructor(message: string) {
    super(message);
    this.name = "ConnectionActionRefusedError";
  }
}

/** Review policy for every brokered action (ADR 0162). */
export interface ConnectionGateway {
  guards: readonly ConnectionActionGuard[];
  /** Where an escalated agent action asks its person for approval. */
  approvals?: ToolPermissionChannel;
  /** The member who owns an agent session, for review and audit. */
  sessionOwner?: (sessionId: string) => Promise<string | undefined>;
  /** The session agent's mode: read-only agents only read (ADR 0176). */
  sessionMode?: (sessionId: string) => Promise<AgentMode | undefined>;
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
    if (
      args.caller === "agent" &&
      args.agentSessionId &&
      (await this.gateway.sessionMode?.(args.agentSessionId)) === "read-only" &&
      !(await this.readsOnly({
        identity: args.identity,
        connectionId: binding.connectionId,
        capabilities: binding.capabilities,
        provider,
        action: args.action,
      }))
    ) {
      await this.connections.audit({
        identity: args.identity,
        projectId: allocation.projectId,
        connectionId: binding.connectionId,
        allocationId: allocation.id,
        eventType: "connection.invoked",
        outcome: "denied",
        action: args.action,
        argumentsDigest: digest,
        metadata: { mode: "read-only" },
      });
      throw new ConnectionActionDeniedError(
        modeRefusal({
          mode: "read-only",
          action: `call ${args.alias} ${args.action}, which can change ${args.alias}`,
        }),
      );
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
        use: (material, connection) =>
          provider.invoke({
            material,
            action: args.action,
            input: args.input,
            capabilities: binding.capabilities,
            connection: { id: connection.id, revision: connection.revision },
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
   * Upstream Git credentials for one request through the Git gateway
   * (ADR 0175). The binding must be a Git connection holding `git:read`
   * (fetch) or `git:write` (push). With `review`, the action passes the
   * guards like any brokered action (kind = the provider, action `fetch` or
   * `push`, input = repository and refs) and the returned `audit` records
   * how it ended. The credentials serve this one request and never leave
   * the control plane.
   */
  async gitAccess(args: {
    identity: Identity;
    allocationId: string;
    alias: string;
    access: "read" | "write";
    remoteUrl: string;
    review?: {
      action: "fetch" | "push";
      input: Json;
      agentSessionId?: string;
    };
  }): Promise<{
    credentials: GitRemoteCredentials;
    binding: ResolvedConnectionBinding;
    audit: (outcome: "allowed" | "error", metadata?: Json) => Promise<void>;
  }> {
    return withSpan(
      {
        tracer,
        name: "connection.git",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.allocation.id": args.allocationId,
          "catamorphic.connection.alias": args.alias,
          "catamorphic.connection.action":
            args.review?.action ?? `git:${args.access}`,
        },
      },
      async () => {
        const { allocation, binding, provider } =
          await this.resolveInvocation(args);
        const git = provider.git;
        if (!git) {
          throw new ConnectionActionRefusedError(
            `Connection '${args.alias}' does not serve Git`,
          );
        }
        const record = async (
          outcome: "allowed" | "denied" | "error",
          metadata?: Json,
        ) => {
          if (!args.review) return;
          await this.connections.audit({
            identity: args.identity,
            projectId: allocation.projectId,
            connectionId: binding.connectionId,
            allocationId: allocation.id,
            eventType: "connection.git",
            outcome,
            action: args.review.action,
            argumentsDigest: createHash("sha256")
              .update(JSON.stringify(args.review.input))
              .digest("hex"),
            ...(metadata === undefined ? {} : { metadata }),
          });
        };
        const capability = args.access === "write" ? "git:write" : "git:read";
        if (!binding.capabilities.includes(capability)) {
          await record("denied", { reason: `missing ${capability}` });
          throw new ConnectionActionDeniedError(
            args.access === "write"
              ? `this session may not push through '${args.alias}' (it lacks git:write)`
              : `this session may not fetch through '${args.alias}' (it lacks git:read)`,
          );
        }
        const review = args.review
          ? await this.review({
              identity: args.identity,
              projectId: allocation.projectId,
              allocationId: allocation.id,
              connection: {
                id: binding.connectionId,
                kind: binding.providerKind,
                alias: binding.alias,
              },
              action: args.review.action,
              input: args.review.input,
              caller: "agent",
              ...(args.review.agentSessionId
                ? { agentSessionId: args.review.agentSessionId }
                : {}),
            })
          : undefined;
        const reviewMetadata: Json = review?.metadata ?? {};
        if (review?.verdict === "deny") {
          await record("denied", {
            ...jsonObject(review.metadata),
            ...(args.review ? { input: args.review.input } : {}),
          });
          throw new ConnectionActionDeniedError(review.reason);
        }
        try {
          await this.connections.refreshIfNeeded({
            identity: args.identity,
            connectionId: binding.connectionId,
          });
          const credentials = await this.connections.withCredential({
            identity: args.identity,
            connectionId: binding.connectionId,
            use: (material) =>
              git.credentials({
                material,
                remoteUrl: args.remoteUrl,
                access: args.access,
              }),
          });
          return {
            credentials,
            binding,
            audit: (outcome, metadata) =>
              record(outcome, {
                ...jsonObject(reviewMetadata),
                ...(args.review ? { input: args.review.input } : {}),
                ...(metadata === undefined ? {} : jsonObject(metadata)),
              }),
          };
        } catch (cause) {
          await record("error", {
            ...jsonObject(reviewMetadata),
            ...(args.review ? { input: args.review.input } : {}),
          });
          if (
            cause instanceof ConnectionUnavailableError ||
            isConnectionAuthorizationExpiredError(cause)
          ) {
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
      },
    );
  }

  /**
   * Read credentials for the control plane's own fetch of a remote through
   * one of a session's Git-capable bindings (ADR 0178: seeding a workspace
   * at a ref). Undefined when no binding serves the remote with `git:read`.
   * Audited as a `mirror` fetch; the credential never leaves the control
   * plane.
   */
  async mirrorCredentials(args: {
    identity: Identity;
    projectId: string;
    bindings: readonly ResolvedConnectionBinding[];
    remoteUrl: string;
  }): Promise<GitRemoteCredentials | undefined> {
    const match = args.bindings.flatMap((binding) => {
      const git = this.providers.get(binding.providerKind)?.git;
      return git &&
        binding.capabilities.includes("git:read") &&
        git.remoteBaseUrls.some((base) => args.remoteUrl.startsWith(base))
        ? [{ binding, git }]
        : [];
    })[0];
    if (!match) return undefined;
    const { binding, git } = match;
    const audit = (outcome: "allowed" | "error") =>
      this.connections.audit({
        identity: args.identity,
        projectId: args.projectId,
        connectionId: binding.connectionId,
        eventType: "connection.git",
        outcome,
        action: "mirror",
        metadata: { alias: binding.alias, remoteUrl: args.remoteUrl },
      });
    try {
      await this.connections.refreshIfNeeded({
        identity: args.identity,
        connectionId: binding.connectionId,
      });
      const credentials = await this.connections.withCredential({
        identity: args.identity,
        connectionId: binding.connectionId,
        use: (material) =>
          git.credentials({
            material,
            remoteUrl: args.remoteUrl,
            access: "read",
          }),
      });
      await audit("allowed");
      return credentials;
    } catch (error) {
      await audit("error");
      throw error;
    }
  }

  /**
   * The upstream endpoint and key headers for one model call through the
   * gateway (ADR 0180). The binding must hold `model`. The call passes the
   * guards as connection kind `model` (action = the endpoint, input = the
   * provider, model and limits, never the prompt), and the returned
   * `audit` records how it ended. The headers serve this one request and
   * never leave the control plane.
   */
  async modelAccess(args: {
    identity: Identity;
    allocationId: string;
    alias: string;
    action: string;
    input: JsonObject;
    agentSessionId?: string;
  }): Promise<{
    endpoint: ConnectionModelEndpoint;
    headers: Record<string, string>;
    binding: ResolvedConnectionBinding;
    audit: (outcome: "allowed" | "error", metadata?: Json) => Promise<void>;
  }> {
    return withSpan(
      {
        tracer,
        name: "connection.model",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "catamorphic.allocation.id": args.allocationId,
          "catamorphic.connection.alias": args.alias,
          "catamorphic.connection.action": args.action,
        },
      },
      async () => {
        const { allocation, binding, provider } =
          await this.resolveInvocation(args);
        const endpoint = provider.model;
        if (!endpoint) {
          throw new ConnectionActionRefusedError(
            `Connection '${args.alias}' is not a model API`,
          );
        }
        const record = (
          outcome: "allowed" | "denied" | "error",
          metadata?: Json,
        ) =>
          this.connections.audit({
            identity: args.identity,
            projectId: allocation.projectId,
            connectionId: binding.connectionId,
            allocationId: allocation.id,
            eventType: "connection.model",
            outcome,
            action: args.action,
            metadata: {
              ...(args.agentSessionId
                ? { sessionId: args.agentSessionId }
                : {}),
              input: args.input,
              ...(metadata === undefined ? {} : jsonObject(metadata)),
            },
          });
        if (!binding.capabilities.includes(MODEL_CAPABILITY)) {
          await record("denied", { reason: `missing ${MODEL_CAPABILITY}` });
          throw new ConnectionActionDeniedError(
            `this session may not call models through '${args.alias}' (it lacks ${MODEL_CAPABILITY})`,
          );
        }
        const review = await this.review({
          identity: args.identity,
          projectId: allocation.projectId,
          allocationId: allocation.id,
          connection: {
            id: binding.connectionId,
            kind: MODEL_CAPABILITY,
            alias: binding.alias,
          },
          action: args.action,
          input: args.input,
          caller: "agent",
          ...(args.agentSessionId
            ? { agentSessionId: args.agentSessionId }
            : {}),
        });
        if (review.verdict === "deny") {
          await record("denied", review.metadata);
          throw new ConnectionActionDeniedError(review.reason);
        }
        try {
          await this.connections.refreshIfNeeded({
            identity: args.identity,
            connectionId: binding.connectionId,
          });
          const headers = await this.connections.withCredential({
            identity: args.identity,
            connectionId: binding.connectionId,
            use: async (material) => endpoint.headers({ material }),
          });
          return {
            endpoint,
            headers,
            binding,
            audit: (outcome, metadata) =>
              record(outcome, {
                ...jsonObject(review.metadata),
                ...(metadata === undefined ? {} : jsonObject(metadata)),
              }),
          };
        } catch (cause) {
          await record("error", review.metadata);
          if (
            cause instanceof ConnectionUnavailableError ||
            isConnectionAuthorizationExpiredError(cause)
          ) {
            throw new ConnectionUnavailableError(
              args.alias,
              "Connection is unavailable",
              binding.connectionId,
            );
          }
          throw cause;
        }
      },
    );
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

  /** Whether a provider action only reads (ADR 0176). */
  private async readsOnly(args: {
    identity: Identity;
    connectionId: string;
    capabilities: readonly string[];
    provider: ConnectionProvider;
    action: string;
  }): Promise<boolean> {
    if (args.provider.readOnly) return args.provider.readOnly(args.action);
    const listActions = args.provider.listActions;
    if (!listActions) return false;
    const actions = await this.connections.withCredential({
      identity: args.identity,
      connectionId: args.connectionId,
      use: (material) =>
        listActions({ material, capabilities: args.capabilities }),
    });
    const annotations = actions.find(
      (candidate) => candidate.name === args.action,
    )?.annotations;
    return (
      typeof annotations === "object" &&
      annotations !== null &&
      !Array.isArray(annotations) &&
      annotations.readOnlyHint === true
    );
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

function jsonObject(value: Json | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function jsonRecord(value: Json): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : { value };
}
