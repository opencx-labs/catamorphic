import fs from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent } from "@catamorphic/claude-code";
import { CodexAgent } from "@catamorphic/codex";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
} from "@catamorphic/core";
import type {
  AgentMcpServerConfig,
  AgentPluginConfig,
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { AgentConfig } from "../agents-store.js";
import {
  connectionServerKeys,
  toAgentMcpServer,
} from "../connections-store.js";
import type { ConnectorsService } from "../connectors.js";
import { bestFreeModelId, fetchOpenRouterModels } from "../openrouter.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { FriendlyAgentErrors } from "./agent-errors.js";
import { buildAiSdkAgent } from "./coding-agent.js";
import { DesktopConfigAgent } from "./desktop-config-agent.js";
import { E2eFakeCodingAgent } from "./e2e-fakes.js";
import { WorkspaceContextAgent } from "./workspace-context-agent.js";
import {
  buildWorkspaceToolkit,
  type WorkspaceToolkit,
} from "./workspace-tools.js";

export interface DesktopAgentRegistryDeps {
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  sandboxProvider: SandboxProvider;
  /** `agent-homes/` root; each account-auth agent gets a private home. */
  agentHomesDir: string;
  /** Agents' window into the user's workspace (tabs, browser, terminals). */
  workspaceBridge?: WorkspaceBridge;
  /** Installed connector plugins (Claude Code loads them natively). */
  connectors?: ConnectorsService;
  /** E2E: every configured agent resolves to the scripted fake. */
  e2eFake?: boolean;
}

/** An agent's resolved MCP surface: servers for every harness, plugin
 * directories for the harness that can load them natively. */
interface ResolvedMcp {
  servers: Record<string, AgentMcpServerConfig>;
  plugins: AgentPluginConfig[];
}

/**
 * The desktop's dynamic {@link CodingAgentRegistry}: agents come from the
 * per-profile agents.json files, resolved live on every lookup — adding an
 * agent in Settings makes it usable without a server restart. Provider
 * instances are cached per config snapshot; editing an agent (model, key,
 * effort) drops the stale instance so the next turn runs the new config.
 */
export class DesktopAgentRegistry implements CodingAgentRegistry {
  private readonly cache = new Map<
    string,
    {
      key: string;
      provider: RegisteredCodingAgent["provider"];
      execution: RegisteredCodingAgent["execution"];
    }
  >();
  /** Per-agent resource closers (ai-sdk MCP clients), run on eviction. */
  private readonly closeables = new Map<string, () => Promise<void>>();
  /**
   * OpenRouter's current best free model, warmed from the live catalog —
   * the default for openrouter agents with no model pinned. Nothing is
   * hardcoded: until the catalog answers, such agents stay unresolved.
   */
  private openrouterDefault: string | undefined;

  /** Workspace tools shared by every harness that can mount them. */
  readonly workspaceToolkit: WorkspaceToolkit | undefined;

  constructor(private readonly deps: DesktopAgentRegistryDeps) {
    this.workspaceToolkit = deps.workspaceBridge
      ? buildWorkspaceToolkit(deps.workspaceBridge)
      : undefined;
    void this.refreshOpenRouterDefault();
  }

  async refreshOpenRouterDefault(): Promise<void> {
    try {
      this.openrouterDefault = bestFreeModelId(await fetchOpenRouterModels());
    } catch (cause) {
      console.warn("[desktop] OpenRouter catalog fetch failed:", cause);
    }
  }

  defaultAgentId(): string | undefined {
    return this.deps.profileConfig.forDefaultProfile().agents.defaultAgentId();
  }

  get(id: string): RegisteredCodingAgent | undefined {
    const found = this.findConfig(id);
    if (!found) {
      this.evict(id);
      return undefined;
    }
    const { config, profileId } = found;
    const mcp = this.resolveMcp(config, profileId);
    // Providers are cached by credential identity plus their MCP surface:
    // model and effort travel per turn (TurnOptions via fresh defaults
    // below), so switching them must NOT rebuild the provider — a rebuild
    // would drop the built-in agent's in-memory sessions mid-conversation.
    // Connection/connector edits DO rebuild, so the next turn runs with
    // the new server set.
    const key = JSON.stringify({ ...config, model: "", effort: "", mcp });
    const defaults = this.freshDefaults(config);
    const cached = this.cache.get(id);
    if (cached && cached.key === key) {
      return {
        id,
        provider: cached.provider,
        execution: cached.execution,
        defaults,
      };
    }

    // Evict BEFORE building: build() registers the fresh provider's
    // resource closer under this id, which an eviction after it would
    // immediately tear down.
    this.evict(id);
    const built = this.build(config, mcp);
    if (!built) return undefined;
    this.cache.set(id, {
      key,
      provider: built.provider,
      execution: built.execution,
    });
    return { ...built, defaults };
  }

  /** Drop a cached provider, closing resources it holds (MCP clients). */
  private evict(id: string): void {
    if (!this.cache.has(id)) return;
    this.cache.delete(id);
    const close = this.closeables.get(id);
    this.closeables.delete(id);
    if (close) {
      void close().catch(() => {});
    }
  }

  /**
   * The agent's effective MCP surface: the profile's enabled connections
   * narrowed by the agent's assignment ("all" = every current and future
   * connection), plus the connector plugins whose connections made the
   * cut (a plugin with no connections follows the "all" assignment only).
   */
  private resolveMcp(config: AgentConfig, profileId: string): ResolvedMcp {
    const stores = this.deps.profileConfig.forProfile(profileId);
    const assignment = config.connections ?? { mode: "all" };
    const picked =
      assignment.mode === "picked" ? new Set(assignment.connectionIds) : null;

    // Keys are computed over the FULL enabled set, then narrowed — so the
    // same key names the same connection for every agent and for the
    // MCP-apps view resolver, whatever this agent's assignment is.
    const servers: Record<string, AgentMcpServerConfig> = {};
    for (const [key, connection] of connectionServerKeys(
      stores.connections.list(),
    )) {
      if (picked && !picked.has(connection.id)) continue;
      const mapped = toAgentMcpServer(connection);
      if (mapped) servers[key] = mapped;
    }

    const plugins: AgentPluginConfig[] = [];
    for (const connector of this.deps.connectors?.listInstalled(profileId) ??
      []) {
      const included =
        !picked ||
        connector.connectionIds.some((connectionId) =>
          picked.has(connectionId),
        );
      if (included) {
        plugins.push({ name: connector.name, path: connector.path });
      }
    }
    return { servers, plugins };
  }

  private freshDefaults(config: AgentConfig) {
    const model = this.resolvedModel(config);
    return { effort: config.effort, ...(model ? { model } : {}) };
  }

  list(): RegisteredCodingAgent[] {
    const agents: RegisteredCodingAgent[] = [];
    for (const profile of this.deps.profiles.list().profiles) {
      const store = this.deps.profileConfig.forProfile(profile.id).agents;
      for (const config of store.list()) {
        const agent = this.get(config.id);
        if (agent) agents.push(agent);
      }
    }
    return agents;
  }

  /** Whether any profile has a usable agent (drives chat affordances). */
  hasAgents(): boolean {
    return this.list().length > 0;
  }

  /** Credential home for an account-auth agent (created on demand). */
  agentHome(agentId: string): string {
    const dir = path.join(this.deps.agentHomesDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * The model an ai-sdk config runs on: its pinned id, or — for OpenRouter
   * with none pinned — the catalog's best free model. Anthropic/OpenAI
   * configs need an explicit model (nothing is hardcoded here).
   */
  private resolvedModel(config: AgentConfig): string | undefined {
    if (config.harness !== "ai-sdk") return config.model || undefined;
    if (config.model) return config.model;
    return config.provider === "openrouter"
      ? this.openrouterDefault
      : undefined;
  }

  private findConfig(
    id: string,
  ): { config: AgentConfig; profileId: string } | undefined {
    for (const profile of this.deps.profiles.list().profiles) {
      const config = this.deps.profileConfig
        .forProfile(profile.id)
        .agents.get(id);
      if (config) return { config, profileId: profile.id };
    }
    return undefined;
  }

  private build(
    config: AgentConfig,
    mcp: ResolvedMcp,
  ): RegisteredCodingAgent | undefined {
    // E2E: same registry mechanics, scripted provider — renderer flows
    // (agent lists, switching, effort) exercise the real plumbing. The
    // error decorator stays on so tests cover the auth-failure surfacing.
    if (this.deps.e2eFake) {
      return {
        id: config.id,
        provider: this.wrapErrors(
          this.wrapSandboxAgent(
            new E2eFakeCodingAgent(
              this.deps.sandboxProvider,
              this.workspaceToolkit?.tools,
            ),
          ),
          config,
        ),
        execution: "sandbox",
        defaults: { effort: config.effort },
      };
    }

    switch (config.harness) {
      case "ai-sdk": {
        const provider = buildAiSdkAgent(
          config,
          this.deps.sandboxProvider,
          this.resolvedModel(config) ?? "",
          this.workspaceToolkit?.tools,
          mcp.servers,
        );
        if (provider) {
          // This harness owns real MCP client connections (stdio child
          // processes); eviction must close them, not leak them.
          this.closeables.set(config.id, () => provider.closeMcp());
        }
        if (!provider) {
          // An unresolved OpenRouter default may just not have warmed yet.
          if (config.provider === "openrouter" && !this.openrouterDefault) {
            void this.refreshOpenRouterDefault();
          }
          return undefined;
        }
        return {
          id: config.id,
          provider: this.wrapErrors(
            this.withWorkspace(this.wrapSandboxAgent(provider), {
              hasTools: true,
            }),
            config,
          ),
          execution: "sandbox",
          defaults: { effort: config.effort },
        };
      }
      case "claude-code": {
        // `local` inherits the machine's existing Claude Code login: the
        // SDK is spawned with no credential overrides at all.
        const env = {
          ...(config.auth === "account"
            ? { CLAUDE_CONFIG_DIR: this.agentHome(config.id) }
            : {}),
          ...(config.auth === "api-key" && config.apiKey
            ? { ANTHROPIC_API_KEY: config.apiKey }
            : {}),
        };
        return {
          id: config.id,
          provider: this.wrapErrors(
            this.withWorkspace(
              new ClaudeCodeAgent({
                model: config.model || undefined,
                effort: config.effort,
                ...(Object.keys(env).length > 0 ? { env } : {}),
                extraTools: this.workspaceToolkit?.tools,
                // Claude Code's own Bash runs inside the CLI where we
                // can't see or manage it. With workspace terminals
                // available, every command goes through tabs the user
                // can watch and take over — full interception.
                disableBash: this.workspaceToolkit !== undefined,
                // The agent's assigned connections, plus native loading
                // of connector plugins (skills/agents/commands).
                mcpServers: mcp.servers,
                plugins: mcp.plugins,
              }),
              { hasTools: true },
            ),
            config,
          ),
          execution: "host",
          defaults: {
            effort: config.effort,
            ...(config.model ? { model: config.model } : {}),
          },
        };
      }
      case "codex": {
        // `local` inherits ~/.codex — the user's existing `codex login`
        // (or the ChatGPT sign-in the wizard runs) just works.
        return {
          id: config.id,
          // Codex has no extra-tool hook yet, so it gets workspace
          // awareness (the per-turn context block) without the tools.
          provider: this.wrapErrors(
            this.withWorkspace(
              new CodexAgent({
                model: config.model || undefined,
                effort: config.effort,
                ...(config.auth === "api-key" && config.apiKey
                  ? { apiKey: config.apiKey }
                  : {}),
                ...(config.auth === "account"
                  ? { env: { CODEX_HOME: this.agentHome(config.id) } }
                  : {}),
                // Assigned connections ride as mcp_servers.* config
                // overrides; the CLI owns the client connections.
                mcpServers: mcp.servers,
              }),
              { hasTools: false },
            ),
            config,
          ),
          execution: "host",
          defaults: {
            effort: config.effort,
            ...(config.model ? { model: config.model } : {}),
          },
        };
      }
    }
  }

  /**
   * Auth failures arrive as raw provider bodies (OpenRouter's 401 is
   * literally "User not found."); rewrite them into something the user
   * can act on. Outermost wrapper so it sees every inner error.
   */
  private wrapErrors(
    provider: CodingAgentProvider,
    config: AgentConfig,
  ): CodingAgentProvider {
    const labels: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      openrouter: "OpenRouter",
    };
    const label =
      config.harness === "claude-code"
        ? "Claude Code"
        : config.harness === "codex"
          ? "Codex"
          : (labels[config.provider ?? "anthropic"] ?? "The model provider");
    return new FriendlyAgentErrors(provider, config.name, label);
  }

  /** Workspace awareness (context snapshots + playbook), when bridged. */
  private withWorkspace(
    provider: CodingAgentProvider,
    opts: { hasTools: boolean },
  ): CodingAgentProvider {
    const bridge = this.deps.workspaceBridge;
    if (!bridge) return provider;
    return new WorkspaceContextAgent(
      provider,
      bridge,
      opts.hasTools && this.workspaceToolkit !== undefined,
    );
  }

  /**
   * Sandbox agents get the desktop-config decorator: the chat can edit the
   * owning profile's keybindings/sidebar/theme through sandbox mirrors.
   * Host agents run outside the sandbox, so they skip it.
   */
  private wrapSandboxAgent(inner: CodingAgentProvider): CodingAgentProvider {
    return new DesktopConfigAgent(
      inner,
      this.deps.sandboxProvider,
      (projectId) =>
        projectId
          ? this.deps.profileConfig.forProject(projectId)
          : this.deps.profileConfig.forDefaultProfile(),
    );
  }
}
