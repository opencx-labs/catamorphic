import type { ToolPermissionBroker } from "@catamorphic/core";
import type {
  AgentMcpServerConfig,
  AgentPluginConfig,
  McpToolPolicyLayers,
  ToolPermissionDecision,
  ToolPermissionHandler,
  ToolPolicyAnnotations,
  TurnOptions,
} from "@catamorphic/sandbox";
import { narrowingLayer, PROJECT_TOOLS_SERVER_KEY } from "@catamorphic/sandbox";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { AgentConfig } from "../agents-store.js";
import {
  connectionServerKeys,
  toAgentMcpServer,
} from "../connections-store.js";
import { connectorHarnessPath } from "../connector-harness.js";
import type { ConnectorsService } from "../connectors.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { HostSkillsRuntime } from "./host-skills.js";
import { askToolConsent } from "./tool-consent.js";

const WORKFLOWS_SERVER_KEY = PROJECT_TOOLS_SERVER_KEY;
/** An agent's resolved MCP surface: servers for every harness, plugin
 * directories for the harness that can load them natively. */
export interface ResolvedMcp {
  servers: Record<string, AgentMcpServerConfig>;
  plugins: AgentPluginConfig[];
  /**
   * Tool policy layers per server key: the connection's own (the
   * profile's ceiling) then the agent's narrowing, when it has one. Every
   * assigned connection gets an entry — the harness gates the ones it
   * finds here and pre-approves the rest (session-scoped surfaces).
   */
  policies: Record<string, McpToolPolicyLayers>;
  /** Cached tool annotations per server key (for `auto` off the hot path). */
  annotations: Record<string, Record<string, ToolPolicyAnnotations>>;
  /** Server key → connection id, so "Always allow" can land on the right
   * connection's policy. */
  connectionIds: Record<string, string>;
}

interface DesktopAgentMcpDeps {
  profileConfig: ProfileConfigManager;
  connectors?: ConnectorsService;
  hostSkills?: () => HostSkillsRuntime | undefined;
  workspaceBridge?: WorkspaceBridge;
  toolPermissions?: ToolPermissionBroker;
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
      // Layers: the connection's policy (absent = auto), then the agent's
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
        connection.toolPolicy ?? {},
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
    return { servers, plugins, policies, annotations, connectionIds };
  }

  /**
   * The `ask` prompt for an agent's MCP tools: the front window's consent
   * modal, labeled with the agent. "Always allow" is persisted on the
   * connection's policy (the profile ceiling) so the next provider build
   * and every other agent see it; the asking harness remembers it too.
   */
  private readonly sessionQuestions = new Map<
    string,
    NonNullable<TurnOptions["askQuestion"]>
  >();
  questionForSession({ sessionId }: { sessionId: string }) {
    return this.sessionQuestions.get(sessionId);
  }

  bindSessionQuestions({
    sessionId,
    options,
  }: {
    sessionId: string;
    options?: TurnOptions;
  }): () => void {
    if (options?.askQuestion)
      this.sessionQuestions.set(sessionId, options.askQuestion);
    return () => {
      if (this.sessionQuestions.get(sessionId) === options?.askQuestion)
        this.sessionQuestions.delete(sessionId);
    };
  }

  permissionHandler({
    config,
    profileId,
  }: {
    config: AgentConfig;
    profileId: string;
  }): ToolPermissionHandler | undefined {
    const bridge = this.deps.workspaceBridge;
    const broker = this.deps.toolPermissions;
    if (!bridge && !broker) return undefined;
    return async (request, signal) => {
      if (signal?.aborted) return { decision: "deny" };
      // Session consent uses the durable chat question. Sessionless host
      // requests race the desktop bridge and companion broker; the first
      // answer withdraws the other prompt.
      const askQuestion = request.sessionId
        ? this.sessionQuestions.get(request.sessionId)
        : undefined;
      const decision: ToolPermissionDecision = askQuestion
        ? await askToolConsent({ askQuestion, request, signal })
        : await new Promise<ToolPermissionDecision>((resolve) => {
            let settled = false;
            const abortModal = new AbortController();
            const ask = broker?.open(request, config.name);
            const settle = (
              value: ToolPermissionDecision,
              source: "bridge" | "broker",
            ) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener("abort", cancel);
              if (source === "bridge" && ask) broker?.answer(ask.id, value);
              if (source === "broker") abortModal.abort();
              resolve(value);
            };
            const cancel = () => {
              abortModal.abort();
              settle({ decision: "deny" }, "bridge");
            };
            signal?.addEventListener("abort", cancel, { once: true });
            if (signal?.aborted) {
              cancel();
              return;
            }
            void ask?.promise.then((value) => settle(value, "broker"));
            if (bridge) {
              void bridge
                .toolPermission(config.name, request, abortModal.signal)
                .then((value) => {
                  // Null = no window, cancelled, or timed out. With a broker
                  // present its own timeout produces the deny (and a paired
                  // phone may still answer); without one, deny here, because
                  // a tool call must never hang on a missing UI.
                  if (value) settle(value, "bridge");
                  else if (!ask) settle({ decision: "deny" }, "bridge");
                })
                .catch((cause) => {
                  // A throwing bridge must not leave the race unsettled (and
                  // must not surface as an unhandled rejection in main).
                  console.warn(
                    "[desktop] tool-permission prompt failed:",
                    cause,
                  );
                  settle({ decision: "deny" }, "bridge");
                });
            }
          });
      if (signal?.aborted) return { decision: "deny" };
      if (decision.decision === "allow" && decision.remember === "always") {
        const connectionId = this.live({ config, profileId }).connectionIds[
          request.server
        ];
        if (connectionId) {
          this.deps.profileConfig
            .forProfile(profileId)
            .connections.setToolPermission(connectionId, request.tool, "allow");
        }
      }
      return decision;
    };
  }

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
    // policies, which are part of their cache key so an edit rebuilds.
    const latest =
      this.deps.profileConfig.forProfile(profileId).agents.get(config.id) ??
      config;
    return this.resolve({ config: latest, profileId });
  }
}
