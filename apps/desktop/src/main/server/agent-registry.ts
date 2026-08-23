import fs from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent } from "@catamorphic/claude-code";
import { CodexAgent } from "@catamorphic/codex";
import type {
  AgentCoordinationStrategy,
  AgentDefinition,
  CodingAgentRegistry,
  RegisteredCodingAgent,
  ToolPermissionBroker,
} from "@catamorphic/core";
import {
  definitionHash,
  projectAgentId,
  validateAgentDefinition,
} from "@catamorphic/core";
import type {
  AgentMcpServerConfig,
  AgentPluginConfig,
  CodingAgentProvider,
  ExtraTool,
  ExtraToolContext,
  McpToolPolicyLayers,
  SandboxProvider,
  ToolPermissionDecision,
  ToolPermissionHandler,
  ToolPolicyAnnotations,
} from "@catamorphic/sandbox";
import { narrowingLayer, PROJECT_TOOLS_SERVER_KEY } from "@catamorphic/sandbox";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { AgentConfig, AgentConnectionsSetting } from "../agents-store.js";
import {
  connectionServerKeys,
  toAgentMcpServer,
} from "../connections-store.js";
import type { ConnectorsService } from "../connectors.js";
import { bestFreeModelId, fetchOpenRouterModels } from "../openrouter.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { projectDefaultAgentSlug } from "../project-manifest.js";
import { FriendlyAgentErrors } from "./agent-errors.js";
import { buildAiSdkAgent } from "./coding-agent.js";
import { DesktopConfigAgent } from "./desktop-config-agent.js";
import { E2eFakeCodingAgent } from "./e2e-fakes.js";
import { composeSkillsNote, type HostSkillsRuntime } from "./host-skills.js";
import {
  AsyncInitCodingAgent,
  FailFastCodingAgent,
  PersonaCodingAgent,
  parseProjectAgentId,
} from "./project-agents.js";
import type { ProjectSessionContext } from "./workspace-context-agent.js";
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
  /**
   * HTTP answer surface for tool-permission asks (ADR 0054): remote
   * clients list/answer pending asks through the embedded server. Raced
   * against the desktop consent modal — whichever answers first wins.
   */
  toolPermissions?: ToolPermissionBroker;
  /** Installed connector plugins (Claude Code loads them natively). */
  connectors?: ConnectorsService;
  /**
   * The project's workflow-tools MCP endpoint (`/api/projects/:id/mcp`),
   * mounted per chat session so agents can call the project's ai.tool-call
   * workflows. Undefined while the embedded server is still booting.
   */
  projectMcpUrl?: (projectId: string) => string | undefined;
  /** Codex's authenticated loopback access to filtered workspace tools. */
  workspaceMcpServer?: (
    projectId: string,
    sessionId: string,
    agentId: string,
  ) => AgentMcpServerConfig | undefined;
  /**
   * Project folder lookup for PROJECT agents (`project:<id>:<slug>`), whose
   * committed `agents/<slug>.json` definitions are read from disk here —
   * synchronously, because the registry contract is synchronous.
   */
  projectRootPath?: (projectId: string) => string | undefined;
  /**
   * Resolve a project secret's value (ADR 0033) for project agents with
   * `credentials.source: "secret"` — core's SecretsService under the
   * desktop identity, wired in after the server boots.
   */
  projectSecret?: (
    projectId: string,
    name: string,
  ) => Promise<string | undefined>;
  /**
   * Host-tier skills (ADR 0049), late-bound: materialized from core's
   * resolved set after the server boots. The plugin rides the MCP surface
   * (so claude-code loads the skills natively and the provider cache key
   * covers it); the note reaches every harness through the workspace
   * decorator's system prompt.
   */
  hostSkills?: () => HostSkillsRuntime | undefined;
  /**
   * The profile's personal skill tier (ADR 0056), read live — names and
   * descriptions for the per-agent skills section of the system prompt.
   */
  userSkills?: (
    profileId: string,
  ) => Array<{ name: string; description: string }>;
  /** Same-project peer summaries, resolved live on every turn. */
  sessionPeers?: (
    projectId: string,
    sessionId: string,
  ) => Promise<ProjectSessionContext[]>;
  /** One-shot checkout recovery warning for the next turn. */
  checkoutNotice?: (
    projectId: string,
    sessionId: string,
  ) => Promise<string | null>;
  /** E2E: every configured agent resolves to the scripted fake. */
  e2eFake?: boolean;
}

/**
 * Per-harness mapping of the normalized operating mode (ADR 0056).
 * "edit" is each harness's designed unattended default.
 */
const CLAUDE_PERMISSION_MODES = {
  "read-only": "plan",
  edit: "acceptEdits",
  "full-access": "bypassPermissions",
} as const;

const CODEX_SANDBOX_MODES = {
  "read-only": "read-only",
  edit: "workspace-write",
  "full-access": "danger-full-access",
} as const;

/**
 * Workspace tools withheld from a read-only agent: anything that runs
 * commands, mutates the project, or acts on the user's behalf. What's left
 * is observation (overview, read_tab, read_terminal, snapshots) and
 * pointing — a read-only agent can still show, watch, and explain.
 */
const MUTATING_WORKSPACE_TOOLS = new Set([
  "run_terminal",
  "write_terminal",
  "browser_act",
  "build_app",
  "sync_project",
  "create_pull_request",
  "set_session_activity",
  "create_worktree",
  "use_worktree",
  "use_project_checkout",
]);

const HOST_CHECKOUT_TOOLS = new Set([
  "create_worktree",
  "use_worktree",
  "use_project_checkout",
]);

/** Server key of the per-project workflow-tools MCP server (session-scoped). */
export const WORKFLOWS_SERVER_KEY = PROJECT_TOOLS_SERVER_KEY;

/** An agent's resolved MCP surface: servers for every harness, plugin
 * directories for the harness that can load them natively. */
interface ResolvedMcp {
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

  /**
   * Layered default resolution (ADR 0056), most specific first: the user's
   * per-project override, the project's committed `defaultAgent` (the
   * `.catamorphic/project.json` manifest), the owning profile's global
   * default, the first roster agent. A layer naming a missing agent is
   * skipped by the stores' own validation; an unconsented project default
   * resolves into 0050's fail-fast consent pointer — visible, not silent.
   */
  defaultAgentId(projectId?: string): string | undefined {
    if (projectId) {
      const store = this.deps.profileConfig.forProject(projectId).agents;
      const override = store.projectDefault(projectId);
      if (override) return override;
      const rootPath = this.deps.projectRootPath?.(projectId);
      const slug = rootPath ? projectDefaultAgentSlug(rootPath) : undefined;
      if (slug) return projectAgentId(projectId, slug);
      return store.defaultAgentId();
    }
    return this.deps.profileConfig.forDefaultProfile().agents.defaultAgentId();
  }

  get(id: string): RegisteredCodingAgent | undefined {
    const projectRef = parseProjectAgentId(id);
    if (projectRef) {
      return this.getProjectAgent(id, projectRef.projectId, projectRef.slug);
    }
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
    // the new server set — but header VALUES are not part of the key:
    // harnesses read servers live (see liveServers), so a rotated OAuth
    // token or renewed header reaches the next call in place, never
    // rebuilding the provider under a conversation.
    // Policies are deliberately NOT part of the key either: harnesses
    // read them live (see livePolicies), so a permission edit — or an
    // "Always allow" mid-turn — never rebuilds the provider.
    const key = JSON.stringify({
      ...config,
      toolPolicies: undefined,
      model: "",
      effort: "",
      mcp: { servers: serverShapes(mcp.servers), plugins: mcp.plugins },
    });
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
    const built = this.build(config, mcp, profileId);
    if (!built) return undefined;
    // The agent's own instructions lead, exactly like a project agent's
    // persona file — same wrapper, same position (outermost, so the host
    // playbooks appended further in follow it).
    const provider = config.instructions
      ? new PersonaCodingAgent(built.provider, config.instructions)
      : built.provider;
    this.cache.set(id, {
      key,
      provider,
      execution: built.execution,
    });
    return { id, provider, execution: built.execution, defaults };
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
      if (included) {
        plugins.push({ name: connector.name, path: connector.path });
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
    return { servers, plugins, policies, annotations, connectionIds };
  }

  /**
   * The `ask` prompt for an agent's MCP tools: the front window's consent
   * modal, labeled with the agent. "Always allow" is persisted on the
   * connection's policy (the profile ceiling) so the next provider build
   * and every other agent see it; the asking harness remembers it too.
   */
  private toolPermissionHandler(
    config: AgentConfig,
    profileId: string,
  ): ToolPermissionHandler | undefined {
    const bridge = this.deps.workspaceBridge;
    const broker = this.deps.toolPermissions;
    if (!bridge && !broker) return undefined;
    return async (request) => {
      // Race the desktop consent modal against the HTTP broker (remote
      // companion clients): the first REAL answer wins, and the loser is
      // withdrawn — the modal via abort, the broker entry via answer().
      const decision = await new Promise<ToolPermissionDecision>((resolve) => {
        let settled = false;
        const abortModal = new AbortController();
        const ask = broker?.open(request, config.name);
        const settle = (
          value: ToolPermissionDecision,
          source: "bridge" | "broker",
        ) => {
          if (settled) return;
          settled = true;
          if (source === "bridge" && ask) broker?.answer(ask.id, value);
          if (source === "broker") abortModal.abort();
          resolve(value);
        };
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
              console.warn("[desktop] tool-permission prompt failed:", cause);
              settle({ decision: "deny" }, "bridge");
            });
        }
      });
      if (decision.decision === "allow" && decision.remember === "always") {
        const connectionId = this.livePolicies(config, profileId).connectionIds[
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

  /**
   * The current policy layers/annotations for an agent, re-resolved from
   * the stores on every read — what the harness getters call, so edits in
   * the connectors modal apply to the next tool call, not the next
   * provider build. Cheap: a pass over the profile's connections.
   */
  private livePolicies(
    config: AgentConfig,
    profileId: string,
  ): Pick<ResolvedMcp, "policies" | "annotations" | "connectionIds"> {
    return this.liveMcp(config, profileId);
  }

  /**
   * The current server configs for an agent, re-resolved on every read —
   * headers included, so the bearer a token refresh just wrote reaches
   * the harness's next connect/spawn/query. The server SET is still part
   * of the cache key (an added or removed connection rebuilds); only the
   * values move underneath.
   */
  private liveServers(
    config: AgentConfig,
    profileId: string,
  ): Record<string, AgentMcpServerConfig> {
    return this.liveMcp(config, profileId).servers;
  }

  private liveMcp(config: AgentConfig, profileId: string): ResolvedMcp {
    // The profile store's copy is the live one for profile agents (a
    // cleared policy is a real edit — no fallback to the build-time copy);
    // project agents are not in that store and carry their definition's
    // policies, which are part of their cache key so an edit rebuilds.
    const latest =
      this.deps.profileConfig.forProfile(profileId).agents.get(config.id) ??
      config;
    return this.resolveMcp(latest, profileId);
  }

  /**
   * Session-scoped MCP servers: the session's project decides the server
   * set, so this resolves per session start/turn — one "catamorphic"
   * entry pointing at the project's workflow-tools endpoint.
   */
  private sessionMcpServers(
    context: ExtraToolContext,
  ): Record<string, AgentMcpServerConfig> {
    const url = this.deps.projectMcpUrl?.(context.projectId);
    return url ? { [WORKFLOWS_SERVER_KEY]: { transport: "http", url } } : {};
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

  /**
   * Resolve a PROJECT agent (`project:<projectId>:<slug>`, ADR 0050): read
   * the committed definition from the project folder, enforce the owning
   * profile's consent binding, and build the harness through the same
   * construction paths profile agents use. Every blocked state (invalid
   * file, missing/stale consent, unsupported kind, missing secret) comes
   * back as a registered agent whose provider fails fast with an
   * actionable error — a turn on it errors clearly instead of hanging or
   * disappearing into AgentNotConfiguredError.
   */
  private getProjectAgent(
    id: string,
    projectId: string,
    slug: string,
  ): RegisteredCodingAgent | undefined {
    const rootPath = this.deps.projectRootPath?.(projectId);
    if (!rootPath) {
      this.evict(id);
      return undefined;
    }
    const agentsDir = path.join(rootPath, "agents");
    let rawText: string;
    try {
      rawText = fs.readFileSync(path.join(agentsDir, `${slug}.json`), "utf-8");
    } catch {
      // No definition file → the agent does not exist.
      this.evict(id);
      return undefined;
    }
    let persona: string | undefined;
    try {
      persona = fs.readFileSync(path.join(agentsDir, `${slug}.md`), "utf-8");
    } catch {
      persona = undefined;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch {
      return this.failFast(
        id,
        `The project agent file agents/${slug}.json is not valid JSON — fix the file and try again.`,
      );
    }
    const validated = validateAgentDefinition(raw, {
      allowE2eFake: this.deps.e2eFake,
    });
    if ("error" in validated) {
      return this.failFast(
        id,
        `The project agent definition agents/${slug}.json is invalid (${validated.error}) — fix the file and try again.`,
      );
    }
    const def = validated.definition;

    if (def.kind === "acp") {
      return this.failFast(
        id,
        `"${def.name}" is an ACP agent — ACP harness support isn't built yet. Pick another agent for now.`,
      );
    }

    // The security core: a committed definition is collaborator-authored
    // code. Before it runs on THIS user's own credentials, the owning
    // profile must hold a consent binding whose hash matches the
    // definition's current sensitive state (kind, model, credentials,
    // persona). "secret" definitions skip this — the project secret is
    // the authorization and nothing personal is used. The e2e fake kind
    // auto-consents under the e2e flag (it never touches credentials).
    const source = def.credentials?.source ?? "profile";
    const hash = definitionHash(def, persona);
    const stores = this.deps.profileConfig.forProject(projectId);
    let bindingAuth:
      | { mode: "local" }
      | { mode: "api-key"; apiKey: string | null }
      | undefined;
    if (def.kind !== "e2e-fake" && source !== "secret") {
      const binding = stores.agentBindings.get(projectId, slug);
      if (!binding) {
        return this.failFast(
          id,
          `The project agent "${def.name}" needs your approval before it can use your credentials — open the agent picker to review and approve it.`,
        );
      }
      if (binding.consentHash !== hash) {
        return this.failFast(
          id,
          `The definition of the project agent "${def.name}" changed since you approved it — open the agent picker to review and re-approve it.`,
        );
      }
      bindingAuth = binding.auth ?? { mode: "local" };
    }

    const profileId = this.deps.profiles.profileForProject(projectId).id;
    const config: AgentConfig = {
      id,
      name: def.name,
      harness:
        def.kind === "claude-code"
          ? "claude-code"
          : def.kind === "codex"
            ? "codex"
            : "ai-sdk",
      ...(def.kind === "builtin" || def.kind === "e2e-fake"
        ? { provider: "anthropic" as const }
        : {}),
      model: def.model ?? "",
      effort: def.effort ?? "medium",
      ...(def.mode ? { mode: def.mode } : {}),
      ...(def.coordination ? { coordination: def.coordination } : {}),
      ...(def.memory === true ? { memory: true } : {}),
      auth:
        source === "secret" || bindingAuth?.mode === "api-key"
          ? "api-key"
          : "local",
      apiKey: bindingAuth?.mode === "api-key" ? bindingAuth.apiKey : null,
      // Enforced (ADR 0056, closing 0050's informational-v1 cut): named
      // connectors resolve to the owning profile's connections by NAME;
      // absent = the full surface, like a profile agent without a pin.
      ...(def.connections
        ? {
            connections: this.connectionsByName(def.connections, profileId),
          }
        : {}),
      ...(def.skills
        ? { skills: { mode: "picked" as const, names: def.skills } }
        : {}),
      // Keyed by connector NAME in a committed definition; resolveMcp
      // matches by name/server key as well as by id.
      ...(def.toolPolicies ? { toolPolicies: def.toolPolicies } : {}),
    };
    const mcp = this.resolveMcp(config, profileId);

    const defaults = {
      effort: def.effort ?? ("medium" as const),
      ...(def.model ? { model: def.model } : {}),
    };
    const key = JSON.stringify({
      projectAgent: true,
      hash,
      auth: config.auth,
      apiKey: config.apiKey,
      source,
      rootPath,
      // Fields outside the consent hash (they only narrow, or touch
      // nothing personal) that still shape the provider: key on them so
      // an edit reaches the next turn.
      toolPolicies: def.toolPolicies ?? null,
      memory: def.memory ?? false,
      coordination: def.coordination ?? "shared-first",
      skills: def.skills ?? null,
      connections: def.connections ?? null,
      mcp: { servers: serverShapes(mcp.servers), plugins: mcp.plugins },
    });
    const cached = this.cache.get(id);
    if (cached && cached.key === key) {
      return {
        id,
        provider: cached.provider,
        execution: cached.execution,
        defaults,
      };
    }

    this.evict(id);
    const registered =
      source === "secret" && !this.deps.e2eFake
        ? this.buildSecretProjectAgent(
            id,
            def,
            config,
            mcp,
            projectId,
            profileId,
          )
        : this.build(config, mcp, profileId);
    if (!registered) {
      return this.failFast(
        id,
        `The project agent "${def.name}" has no usable credentials or model — approve it again from the agent picker, or check its definition.`,
      );
    }
    const provider = persona
      ? new PersonaCodingAgent(registered.provider, persona)
      : registered.provider;
    this.cache.set(id, { key, provider, execution: registered.execution });
    return { id, provider, execution: registered.execution, defaults };
  }

  /**
   * A secret-credentialed project agent: the harness is constructed
   * lazily, once core's SecretsService has produced the key — the
   * registry contract is synchronous, secrets are not. A missing secret
   * fails the turn with an error naming it, and is re-checked next turn.
   */
  private buildSecretProjectAgent(
    id: string,
    def: AgentDefinition,
    config: AgentConfig,
    mcp: ResolvedMcp,
    projectId: string,
    profileId: string,
  ): RegisteredCodingAgent | undefined {
    const secretName = def.credentials?.secret;
    if (!secretName) return undefined;
    const factory = async (): Promise<CodingAgentProvider> => {
      const value = await this.deps.projectSecret?.(projectId, secretName);
      if (!value) {
        return new FailFastCodingAgent(
          `The project agent "${def.name}" authenticates with the project secret "${secretName}", which has no value — add it under the project's secrets and send your message again.`,
        );
      }
      const built = this.build({ ...config, apiKey: value }, mcp, profileId);
      if (!built) {
        return new FailFastCodingAgent(
          `The project agent "${def.name}" could not be constructed — check its model configuration in agents/ and try again.`,
        );
      }
      return built.provider;
    };
    // Optional methods come from the harness KIND, statically known —
    // feature-detection must not see methods the harness lacks.
    const provider = new AsyncInitCodingAgent(
      config.harness,
      factory,
      def.kind === "builtin"
        ? { interrupt: true, hasSession: true, retryTurn: true }
        : def.kind === "claude-code"
          ? { interrupt: true }
          : {},
    );
    return {
      id,
      provider,
      execution: def.kind === "builtin" ? "sandbox" : "host",
    };
  }

  /** A registered-but-blocked agent: errors actionably, never hangs. */
  private failFast(id: string, message: string): RegisteredCodingAgent {
    this.evict(id);
    return {
      id,
      provider: new FailFastCodingAgent(message),
      execution: "host",
      defaults: {},
    };
  }

  /**
   * A committed definition's connector names → the owning profile's
   * matching connections, as a picked assignment. A name with no matching
   * connection simply isn't there — the consent dialog already lists what
   * the definition expects, so the gap is visible before the first turn.
   */
  private connectionsByName(
    names: string[],
    profileId: string,
  ): AgentConnectionsSetting {
    const wanted = new Set(names);
    const connectionIds = this.deps.profileConfig
      .forProfile(profileId)
      .connections.list()
      .filter((connection) => wanted.has(connection.name))
      .map((connection) => connection.id);
    return { mode: "picked", connectionIds };
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
    profileId: string,
  ): RegisteredCodingAgent | undefined {
    // E2E: same registry mechanics, scripted provider — renderer flows
    // (agent lists, switching, effort) exercise the real plumbing. The
    // error decorator stays on so tests cover the auth-failure surfacing.
    if (this.deps.e2eFake) {
      const execution = config.harness === "ai-sdk" ? "sandbox" : "host";
      const fake = new E2eFakeCodingAgent(
        this.deps.sandboxProvider,
        this.workspaceTools(config, execution),
        this.toolPermissionHandler(config, profileId),
      );
      return {
        id: config.id,
        provider: this.wrapErrors(
          execution === "sandbox" ? this.wrapSandboxAgent(fake) : fake,
          config,
        ),
        execution,
        defaults: { effort: config.effort },
      };
    }

    switch (config.harness) {
      case "ai-sdk": {
        const bridge = this.deps.workspaceBridge;
        const provider = buildAiSdkAgent({
          config,
          sandboxProvider: this.deps.sandboxProvider,
          modelId: this.resolvedModel(config) ?? "",
          // Mode does not apply to the sandboxed built-in agent (its edits
          // land as a reviewable draft), so its toolset is never filtered.
          extraTools: this.workspaceTools(config, "sandbox"),
          mcpServers: () => this.liveServers(config, profileId),
          // Elicitation from this agent's connectors → the front window,
          // labeled with the agent so the user knows who's asking.
          onElicit: bridge
            ? (request) => bridge.elicit(config.name, request)
            : undefined,
          mcpServersForSession: (context) => this.sessionMcpServers(context),
          mcpPolicies: () => this.livePolicies(config, profileId).policies,
          onToolPermission: this.toolPermissionHandler(config, profileId),
        });
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
              config,
              profileId,
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
                // The normalized mode (ADR 0056) on the CLI's own knob;
                // read-only agents also lose the mutating workspace tools.
                permissionMode: CLAUDE_PERMISSION_MODES[config.mode ?? "edit"],
                // Memory is opt-in (ADR 0056): the harness mirrors the
                // CLI (on when omitted), the product's doctrine is off —
                // so the flag is always passed explicitly.
                memory: config.memory === true,
                ...(Object.keys(env).length > 0 ? { env } : {}),
                extraTools: this.workspaceTools(config, "host"),
                // Claude Code's own Bash runs inside the CLI where we
                // can't see or manage it. With workspace terminals
                // available, every command goes through tabs the user
                // can watch and take over — full interception. Per-turn:
                // the harness restores Bash on turns where the workspace
                // server isn't mounted (resurrected sessions), so the
                // agent is never left without a shell.
                disableBash: this.workspaceToolkit !== undefined,
                // The agent's assigned connections, plus native loading
                // of connector plugins (skills/agents/commands).
                mcpServers: () => this.liveServers(config, profileId),
                mcpServersForSession: (context) =>
                  this.sessionMcpServers(context),
                plugins: mcp.plugins,
                mcpPolicies: () =>
                  this.livePolicies(config, profileId).policies,
                mcpToolAnnotations: () =>
                  this.livePolicies(config, profileId).annotations,
                onToolPermission: this.toolPermissionHandler(config, profileId),
              }),
              { hasTools: true, config, profileId },
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
          provider: this.wrapErrors(
            this.withWorkspace(
              new CodexAgent({
                model: config.model || undefined,
                effort: config.effort,
                // The normalized mode (ADR 0056) on Codex's own sandbox.
                sandboxMode: CODEX_SANDBOX_MODES[config.mode ?? "edit"],
                ...(config.auth === "api-key" && config.apiKey
                  ? { apiKey: config.apiKey }
                  : {}),
                ...(config.auth === "account"
                  ? { env: { CODEX_HOME: this.agentHome(config.id) } }
                  : {}),
                // Assigned connections ride as mcp_servers.* config
                // overrides; the CLI owns the client connections. Policy
                // is coarse here (disabled_tools) — Codex can't ask.
                mcpServers: () => this.liveServers(config, profileId),
                mcpServersForSession: (context) => {
                  const workspaceServer = context.sessionId
                    ? this.deps.workspaceMcpServer?.(
                        context.projectId,
                        context.sessionId,
                        config.id,
                      )
                    : undefined;
                  return {
                    ...this.sessionMcpServers(context),
                    ...(workspaceServer ? { workspace: workspaceServer } : {}),
                  };
                },
                mcpPolicies: () =>
                  this.livePolicies(config, profileId).policies,
                mcpToolAnnotations: () =>
                  this.livePolicies(config, profileId).annotations,
              }),
              { hasTools: true, config, profileId },
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
    opts: { hasTools: boolean; config: AgentConfig; profileId: string },
  ): CodingAgentProvider {
    const bridge = this.deps.workspaceBridge;
    if (!bridge) return provider;
    const hasTools = opts.hasTools && this.workspaceToolkit !== undefined;
    return new WorkspaceContextAgent(
      provider,
      bridge,
      hasTools,
      () => this.skillsNote(opts.config, opts.profileId, hasTools),
      {
        strategy: opts.config.coordination ?? "shared-first",
        peers: (projectId, sessionId) =>
          this.deps.sessionPeers?.(projectId, sessionId) ?? Promise.resolve([]),
        checkoutNotice: (projectId, sessionId) =>
          this.deps.checkoutNotice?.(projectId, sessionId) ??
          Promise.resolve(null),
      },
    );
  }

  /**
   * The per-agent Skills section (ADR 0056): app tier + the profile's
   * personal tier, narrowed to the agent's picked set when it has one.
   */
  private skillsNote(
    config: AgentConfig,
    profileId: string,
    hasTools: boolean,
  ): string | undefined {
    const host = this.deps.hostSkills?.();
    const setting = config.skills ?? { mode: "all" };
    return composeSkillsNote({
      appSkills: host?.skills ?? [],
      ...(host ? { appSkillsDir: host.skillsDir } : {}),
      userSkills: this.deps.userSkills?.(profileId) ?? [],
      ...(setting.mode === "picked" ? { picked: setting.names } : {}),
      hasTools,
    });
  }

  /**
   * The workspace toolset for one agent: a read-only agent (ADR 0056)
   * loses the tools that run commands, mutate the project, or act on the
   * user's behalf — its harness-side mode alone can't govern host tools.
   */
  private workspaceTools(
    config: Pick<AgentConfig, "mode">,
    execution: "host" | "sandbox",
  ): ExtraTool[] | undefined {
    const tools = this.workspaceToolkit?.tools;
    if (!tools) return undefined;
    return tools.filter((tool) => {
      if (execution === "sandbox" && HOST_CHECKOUT_TOOLS.has(tool.name)) {
        return false;
      }
      return !(
        (config.mode ?? "edit") === "read-only" &&
        MUTATING_WORKSPACE_TOOLS.has(tool.name)
      );
    });
  }

  /** Filtered host workspace tools for a loopback, session-scoped harness. */
  workspaceToolsForAgent(id: string): ExtraTool[] | undefined {
    const profile = this.findConfig(id);
    if (profile) return this.workspaceTools(profile.config, "host");
    const project = parseProjectAgentId(id);
    const root = project
      ? this.deps.projectRootPath?.(project.projectId)
      : undefined;
    if (!project || !root) return undefined;
    try {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(root, "agents", `${project.slug}.json`),
          "utf8",
        ),
      );
      const validated = validateAgentDefinition(raw, {
        allowE2eFake: this.deps.e2eFake,
      });
      if ("error" in validated) return undefined;
      return this.workspaceTools({ mode: validated.definition.mode }, "host");
    } catch {
      return undefined;
    }
  }

  /** Effective concurrent-checkout doctrine for a profile or project agent. */
  coordinationForAgent(id: string): AgentCoordinationStrategy {
    const profile = this.findConfig(id);
    if (profile) return profile.config.coordination ?? "shared-first";
    const project = parseProjectAgentId(id);
    const root = project
      ? this.deps.projectRootPath?.(project.projectId)
      : undefined;
    if (!project || !root) return "shared-first";
    try {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(root, "agents", `${project.slug}.json`),
          "utf8",
        ),
      );
      const validated = validateAgentDefinition(raw, {
        allowE2eFake: this.deps.e2eFake,
      });
      return "error" in validated
        ? "shared-first"
        : (validated.definition.coordination ?? "shared-first");
    } catch {
      return "shared-first";
    }
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
      (projectId) => this.deps.profileConfig.projectSidebarStore(projectId),
    );
  }
}

/**
 * The cache-key view of a server set: everything but header values.
 * Which servers exist and where they point decides the provider; what
 * they authenticate with is read live (a refreshed OAuth bearer must not
 * rebuild the provider and drop its sessions).
 */
function serverShapes(
  servers: Record<string, AgentMcpServerConfig>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.transport === "stdio"
        ? server
        : {
            transport: server.transport,
            url: server.url,
            headerNames: Object.keys(server.headers ?? {}).sort(),
          },
    ]),
  );
}
