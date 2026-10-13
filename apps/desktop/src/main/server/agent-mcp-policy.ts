import type { JsonValue } from "@catamorphic/agent-protocol";
import type { CatamorphicCore } from "@catamorphic/core";
import type {
  AgentMcpServerConfig,
  AgentPluginConfig,
  McpToolPolicyLayers,
  ToolGateVerdict,
  ToolPermissionHandler,
  ToolPolicyAnnotations,
} from "@catamorphic/sandbox";
import {
  narrowingLayer,
  PROJECT_TOOLS_SERVER_KEY,
  resolveToolPermissionAcross,
  ToolGate,
} from "@catamorphic/sandbox";
import { DESKTOP_DEFAULT_SANDBOXING } from "../../shared/agent-permissions.js";
import type { AgentConfig } from "../agents-store.js";
import {
  connectionServerKeys,
  toAgentMcpServer,
} from "../connections-store.js";
import { connectorHarnessPath } from "../connector-harness.js";
import type { ConnectorsService } from "../connectors.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { HostSkillsRuntime } from "./host-skills.js";

const WORKFLOWS_SERVER_KEY = PROJECT_TOOLS_SERVER_KEY;
/** An agent's resolved MCP surface: its connectors' servers (reached
 * through the host's pool, ADR 0225), plugin directories for the harness
 * that can load them natively. */
export interface ResolvedMcp {
  servers: Record<string, AgentMcpServerConfig>;
  nativeServers?: Record<string, AgentMcpServerConfig>;
  plugins: AgentPluginConfig[];
  /**
   * Tool policy layers per server key: the connection's own (the
   * profile's ceiling) then the agent's narrowing, when it has one. Every
   * assigned connection gets an entry. The catalog, or a mounted
   * connector's endpoint (ADR 0225), decides connector calls; the harness
   * gates the other servers here and pre-approves the rest.
   */
  policies: Record<string, McpToolPolicyLayers>;
  /** Cached tool annotations per server key (for `auto` off the hot path). */
  annotations: Record<string, Record<string, ToolPolicyAnnotations>>;
  /** Server key → connection id, for the connection's own tools. */
  connectionIds: Record<string, string>;
}

/**
 * Whether an agent may reach a connector's tool at all: no layer denies
 * it, and a contained agent only reads. An ask is decided at each call
 * (ADR 0054), by the catalog or by a mounted connector's endpoint.
 */
export function connectorToolPermitted(input: {
  layers: McpToolPolicyLayers | undefined;
  readOnly: boolean;
  tool: { name: string; annotations?: ToolPolicyAnnotations };
}): boolean {
  return (
    (!input.readOnly || input.tool.annotations?.readOnlyHint === true) &&
    resolveToolPermissionAcross(
      input.layers,
      input.tool.name,
      input.tool.annotations,
    ) !== "deny"
  );
}

/**
 * One call of a tool the host serves, decided against its policy layers
 * (ADR 0054). An `ask` becomes a request on the chat's working turn, which
 * every client of the chat sees and any of them may answer (ADR 0198), and
 * an "Always allow" there lands on the connection's policy.
 */
export async function decideHostToolCall(input: {
  core: CatamorphicCore;
  sessionId: string | undefined;
  server: string;
  tool: string;
  input: Record<string, unknown>;
  layers: McpToolPolicyLayers | undefined;
  annotations?: ToolPolicyAnnotations;
  signal?: AbortSignal;
}): Promise<ToolGateVerdict> {
  const ask: ToolPermissionHandler = async (request, signal) => {
    const sessions = input.core.agentSessions;
    if (!sessions || !request.sessionId) return { decision: "deny" };
    const verdict = await sessions.askApproval({
      sessionId: request.sessionId,
      title: `Allow ${request.tool}?`,
      ...(request.description ? { description: request.description } : {}),
      origin: { kind: "mcp", id: request.server, displayName: request.server },
      approval: {
        action: `${request.server} · ${request.tool}`,
        ...(request.description ? { details: request.description } : {}),
        tool: {
          server: request.server,
          name: request.tool,
          input: jsonValue(request.input),
        },
      },
      ...(signal ? { signal } : {}),
    });
    return { decision: verdict };
  };
  return new ToolGate(ask).decide({
    server: input.server,
    tool: input.tool,
    input: input.input,
    sessionId: input.sessionId,
    layers: input.layers,
    annotations: input.annotations,
    abortSignal: input.signal,
  });
}

/** A tool's input as plain JSON, for the approval the person reads. */
function jsonValue(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

interface DesktopAgentMcpDeps {
  profileConfig: ProfileConfigManager;
  connectors?: Pick<ConnectorsService, "listInstalled">;
  hostSkills?: () => HostSkillsRuntime | undefined;
}

export class DesktopAgentMcp {
  constructor(private readonly deps: DesktopAgentMcpDeps) {}
  /**
   * The agent's effective MCP surface: the profile's enabled connections
   * narrowed by the agent's assignment ("all" = every current and future
   * connection), plus the connector plugins whose connections made the
   * cut (a plugin with no connections follows the "all" assignment only).
   */
  resolve({
    config,
    profileId,
  }: {
    config: AgentConfig;
    profileId: string;
  }): ResolvedMcp {
    const stores = this.deps.profileConfig.forProfile(profileId);
    const assignment = config.connections ?? { mode: "all" };
    const picked =
      assignment.mode === "picked" ? new Set(assignment.connectionIds) : null;

    // Keys are computed over the FULL enabled set, then narrowed — so the
    // same key names the same connection for every agent and for the
    // MCP-apps view resolver, whatever this agent's assignment is.
    const servers: Record<string, AgentMcpServerConfig> = {};
    const policies: ResolvedMcp["policies"] = {};
    const annotations: ResolvedMcp["annotations"] = {};
    const connectionIds: Record<string, string> = {};
    for (const [key, connection] of connectionServerKeys(
      stores.connections.list(),
    )) {
      if (picked && !picked.has(connection.id)) continue;
      const mapped = toAgentMcpServer(connection);
      if (!mapped) continue;
      servers[key] = mapped;
      connectionIds[key] = connection.id;
      // Layers: the connection's policy (absent follows the agent's
      // sandboxing: publish allows, otherwise auto), then the agent's
      // (profile agents key by connection id; committed/remote definitions
      // by connector name or server key).
      const agentPolicy =
        config.toolPolicies?.[connection.id] ??
        config.toolPolicies?.[connection.name] ??
        config.toolPolicies?.[key];
      policies[key] = [
        // Layer zero when present: the provisioner's ceiling (an org's
        // shared credential). Then the user's own, then the agent's.
        ...(connection.ceiling ? [connection.ceiling.policy] : []),
        {
          default:
            (config.sandboxing ?? DESKTOP_DEFAULT_SANDBOXING) === "publish"
              ? "allow"
              : "auto",
          ...connection.toolPolicy,
        },
        ...(agentPolicy ? [narrowingLayer(agentPolicy)] : []),
      ];
      // The FULL cached roster (empty hints when a tool has none): Codex
      // derives its allow/deny lists from what's known here, and a tool
      // that exists but wasn't listed would otherwise escape the policy.
      annotations[key] = Object.fromEntries(
        (connection.tools ?? []).map((tool) => [
          tool.name,
          tool.annotations ?? {},
        ]),
      );
    }

    const plugins: AgentPluginConfig[] = [];
    for (const connector of this.deps.connectors?.listInstalled(profileId) ??
      []) {
      const included =
        !picked ||
        connector.connectionIds.some((connectionId) =>
          picked.has(connectionId),
        );
      if (included && !connector.external) {
        plugins.push({
          name: connector.name,
          path: connectorHarnessPath(connector.path),
        });
      }
    }
    // Host-tier skills ride as a plugin regardless of connection
    // assignment — they are app doctrine, not a connector. A picked-skills
    // agent (ADR 0056) is the exception: the plugin would hand Claude Code
    // the whole app tier natively, so it is withheld and the picked set is
    // offered through the prompt's skills section + read_skill instead.
    const hostSkillsPlugin = this.deps.hostSkills?.()?.plugin;
    if (hostSkillsPlugin && config.skills?.mode !== "picked") {
      plugins.push(hostSkillsPlugin);
    }
    // The project's own workflow-tools server (session-scoped, key
    // "catamorphic") is unrestricted unless the agent says otherwise —
    // an agent's `toolPolicies.catamorphic` is how a host narrows which
    // workflows an agent may run (or must ask before running).
    const workflowPolicy = config.toolPolicies?.[WORKFLOWS_SERVER_KEY];
    if (workflowPolicy) {
      policies[WORKFLOWS_SERVER_KEY] = [narrowingLayer(workflowPolicy)];
    }
    for (const [serverKey, policy] of Object.entries(
      config.toolPolicies ?? {},
    )) {
      if (serverKey.startsWith("connection_")) {
        policies[serverKey] = [narrowingLayer(policy)];
      }
    }
    const nativeConnectionIds = new Set(
      (this.deps.connectors?.listInstalled(profileId) ?? [])
        .filter(
          (connector) =>
            connector.external && connector.name === "codex-computer-use",
        )
        .flatMap((connector) => connector.connectionIds),
    );
    const nativeServers =
      config.harness === "codex"
        ? Object.fromEntries(
            Object.entries(servers)
              .filter(([key]) =>
                nativeConnectionIds.has(connectionIds[key] ?? ""),
              )
              .map(([key, server]) => [
                key,
                { ...server, defaultToolsApprovalMode: "approve" as const },
              ]),
          )
        : {};
    return {
      servers,
      nativeServers,
      plugins,
      policies,
      annotations,
      connectionIds,
    };
  }

  /**
   * The surface as it is now, read at every attempt so a permission or
   * connection edit reaches the next turn without restarting anything.
   */
  live({
    config,
    profileId,
  }: {
    config: AgentConfig;
    profileId: string;
  }): ResolvedMcp {
    // The profile store's copy is the live one for profile agents (a
    // cleared policy is a real edit — no fallback to the build-time copy);
    // project agents are not in that store and carry their definition's
    // policies, read from the committed file on every lookup.
    const latest =
      this.deps.profileConfig.forProfile(profileId).agents.get(config.id) ??
      config;
    return this.resolve({ config: latest, profileId });
  }
}
