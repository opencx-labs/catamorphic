import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  HarnessAdapter,
} from "@catamorphic/agent-protocol/runner";
import { AI_SDK_HARNESS, type ShellState } from "@catamorphic/ai-sdk";
import {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeAdapter,
} from "@catamorphic/claude-code";
import { CODEX_CAPABILITIES, createCodexAdapter } from "@catamorphic/codex";
import type {
  AgentCoordinationStrategy,
  AgentDefinition,
  AgentDelegationPolicy,
  AgentHarness as RegisteredHarness,
  AgentTurnContext,
  CodingAgentRegistry,
  RegisteredCodingAgent,
} from "@catamorphic/core";
import {
  connectionMcpServerName,
  definitionHash,
  projectAgentId,
  validateAgentDefinition,
} from "@catamorphic/core";
import { PROJECT_TOOLS_SERVER_KEY } from "@catamorphic/sandbox";
import { PROJECT_AGENTS_DIR } from "@catamorphic/workflow/project-layout";
import type { AgentCommandsResult } from "../../shared/agent-commands.js";
import type { AgentDefaultModelResult } from "../../shared/agent-default-model.js";
import {
  DESKTOP_DEFAULT_SANDBOXING,
  effectiveHarnessPermissions,
} from "../../shared/agent-permissions.js";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { AgentConfig } from "../agents-store.js";
import { readableAttachments } from "../composer-files.js";
import type { ConnectorsService } from "../connectors.js";
import {
  type DownloadableHarness,
  HarnessComponentStore,
  type HarnessDownloadProgress,
  type HarnessExecutable,
  harnessPathEnvironment,
} from "../harness-components.js";
import { bestFreeModelId, fetchOpenRouterModels } from "../openrouter.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { projectDefaultAgentSlug } from "../project-manifest.js";
import { shellBinShimDir } from "../shell-integration.js";
import { DesktopAgentMcp } from "./agent-mcp-policy.js";
import { buildAiSdkAdapter } from "./coding-agent.js";
import { desktopSettingsContext } from "./desktop-settings-context.js";
import { E2eFakeAdapter } from "./e2e-fakes.js";
import {
  type AgentErrorLabels,
  desktopAdapter,
  unavailableAdapter,
} from "./harness-adapters.js";
import { composeSkillsNote, type HostSkillsRuntime } from "./host-skills.js";
import { localAgentWorkspace } from "./local-agent-workspace.js";
import { parseProjectAgentId } from "./project-agents.js";
import {
  type ProjectSessionContext,
  workspaceInstructions,
  workspaceTurnContext,
} from "./workspace-context-agent.js";
import {
  buildWorkspaceToolkit,
  type WorkspaceTool,
  type WorkspaceToolkit,
} from "./workspace-tools.js";

/** A host-placed harness: what every desktop agent runs on. */
type HostHarness = Extract<RegisteredHarness, { placement: "host" }>;

/** What one agent config builds: its harness and per-attempt settings. */
type BuiltAgent = Pick<RegisteredCodingAgent, "options" | "defaults"> & {
  harness: HostHarness;
};

export interface DesktopAgentRegistryDeps {
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  /** `agent-homes/` root; each account-auth agent gets a private home. */
  agentHomesDir: string;
  /** App-owned cache for integrity-pinned native harness components. */
  harnessComponentsDir: string;
  /**
   * Files pasted into chats (`<attachmentsDir>/<projectId>/`), which the
   * built-in agent may read though they sit outside the project.
   */
  attachmentsDir?: string;
  /** Agents' window into the user's workspace (tabs, browser, terminals). */
  workspaceBridge?: WorkspaceBridge;
  /** Installed connector plugins (Claude Code loads them natively). */
  connectors?: ConnectorsService;
  /**
   * Project folder lookup for PROJECT agents (`project:<id>:<slug>`), whose
   * committed `.work/agents/<slug>.json` definitions are read from disk here —
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
   * (so claude-code loads the skills natively); the note reaches every
   * harness through the agent's instructions.
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

function resolveProjectDelegation(
  policy: AgentDelegationPolicy | undefined,
  projectId: string,
): AgentDelegationPolicy | undefined {
  if (!policy) return undefined;
  return {
    ...policy,
    routes: policy.routes.map((route) => {
      const relative = route.target.match(/^project:([^:]+)$/);
      return relative
        ? {
            ...route,
            target: projectAgentId(projectId, relative[1] ?? ""),
          }
        : route;
    }),
  };
}

/**
 * How long a harness's default-model answer stays fresh. Settings edits
 * (~/.claude/settings.json, ~/.codex/config.toml) show up within this.
 */
const DEFAULT_MODEL_TTL_MS = 60_000;

/** Server key of the per-project workflow-tools MCP server (session-scoped). */
export const WORKFLOWS_SERVER_KEY = PROJECT_TOOLS_SERVER_KEY;

/** The harness adapters themselves hold no agent settings: one each. */
const claudeCode = createClaudeCodeAdapter();
const codex = createCodexAdapter();

/**
 * The desktop's dynamic {@link CodingAgentRegistry}: agents come from the
 * per-profile agents.json files and committed project agents, resolved
 * live on every lookup, so adding or editing an agent in Settings applies
 * to the next turn without a restart. Every agent runs its harness on this
 * machine, in the chat's checkout (`topology: "native"`, ADR 0196); its
 * conversation lives in the session log, so nothing here holds a chat.
 */
export class DesktopAgentRegistry implements CodingAgentRegistry {
  /**
   * OpenRouter's current best free model, warmed from the live catalog —
   * the default for openrouter agents with no model pinned. Nothing is
   * hardcoded: until the catalog answers, such agents stay unresolved.
   */
  private openrouterDefault: string | undefined;
  /** Harness default-model answers per agent and folder (see defaultModel). */
  private readonly defaultModels = new Map<
    string,
    { signature: string; at: number; result: Promise<AgentDefaultModelResult> }
  >();
  /**
   * Each chat's shell for the built-in agent: where its next command
   * starts. Kept across turns, like a terminal the chat keeps open.
   */
  private readonly shells = new Map<string, ShellState>();

  /** Workspace tools shared by every harness that can mount them. */
  readonly workspaceToolkit: WorkspaceToolkit | undefined;
  private readonly harnessComponents: HarnessComponentStore;
  private readonly mcp: DesktopAgentMcp;

  constructor(private readonly deps: DesktopAgentRegistryDeps) {
    this.mcp = new DesktopAgentMcp(deps);
    this.harnessComponents = new HarnessComponentStore({
      rootDir: deps.harnessComponentsDir,
    });
    this.workspaceToolkit = deps.workspaceBridge
      ? buildWorkspaceToolkit(deps.workspaceBridge, {
          desktopSettings: (projectId) => this.settingsContext(projectId),
        })
      : undefined;
    const needsOpenRouterDefault = deps.profiles
      .list()
      .profiles.some((profile) =>
        deps.profileConfig
          .forProfile(profile.id)
          .agents.list()
          .some(
            (agent) =>
              agent.harness === "ai-sdk" &&
              agent.provider === "openrouter" &&
              !agent.model,
          ),
      );
    if (needsOpenRouterDefault) void this.refreshOpenRouterDefault();
  }

  /** Resolve a packaged or one-time-downloaded native harness executable. */
  ensureHarnessExecutable(
    harness: DownloadableHarness,
  ): Promise<HarnessExecutable> {
    return this.harnessComponents.ensure(harness);
  }

  /** First-use harness downloads, so sign-in UI can show real progress. */
  onHarnessDownloadProgress(
    listener: (progress: HarnessDownloadProgress) => void,
  ): () => void {
    return this.harnessComponents.onProgress(listener);
  }

  /** Every agent-owned terminal needs Bun, including controller agents. */
  async nativeToolchainEnvironment(): Promise<Record<string, string>> {
    if (this.deps.e2eFake) return {};
    const bun = await this.harnessComponents.ensure("bun");
    return {
      ...harnessPathEnvironment(bun),
      CATAMORPHIC_BUN: bun.executablePath,
      ...(bun.pathEntries[0]
        ? { CATAMORPHIC_TOOLCHAIN_BIN: bun.pathEntries[0] }
        : {}),
    };
  }

  private async ensureNativeComponents(harness: DownloadableHarness): Promise<{
    component: HarnessExecutable;
    environment: Record<string, string>;
  }> {
    const [component, bun, shimBin] = await Promise.all([
      this.harnessComponents.ensure(harness),
      this.harnessComponents.ensure("bun"),
      shellBinShimDir(),
    ]);
    const environment = harnessPathEnvironment({
      pathEntries: [
        ...(shimBin ? [shimBin] : []),
        ...bun.pathEntries,
        ...component.pathEntries,
      ],
    });
    return {
      component,
      environment: { ...environment, CATAMORPHIC_BUN: bun.executablePath },
    };
  }

  /** Resolve the same configuration and consent as execution, without starting a session. */
  async listCommands({
    projectId,
    agentId,
    workingDirectory,
  }: {
    projectId: string;
    agentId: string;
    workingDirectory: string;
  }): Promise<AgentCommandsResult> {
    const ref = parseProjectAgentId(agentId);
    if (ref && ref.projectId !== projectId)
      return { commands: [], error: "This agent belongs to another project." };
    const resolved = ref
      ? this.resolveProjectConfig(agentId, ref.projectId, ref.slug)
      : this.findConfig(agentId);
    if (!resolved)
      return {
        commands: [],
        error: "Select an available agent to load commands.",
      };
    if ("error" in resolved) return { commands: [], error: resolved.error };
    const { config, profileId } = resolved;
    if (profileId !== this.deps.profiles.profileForProject(projectId).id)
      return { commands: [], error: "This agent belongs to another profile." };
    if (config.harness === "ai-sdk") return { commands: [] };
    if (this.deps.e2eFake) {
      return {
        commands:
          config.harness === "claude-code"
            ? [
                {
                  name: "compact",
                  description: "Summarize conversation history",
                  argumentHint: "[instructions]",
                },
                {
                  name: "review",
                  description: "Review a pull request",
                  argumentHint: "<pr-number>",
                },
              ]
            : [
                {
                  name: "native-notes",
                  description: "Write notes with Codex",
                  argumentHint: "[instructions]",
                  skillPath: path.join(
                    workingDirectory,
                    ".codex/skills/native-notes/SKILL.md",
                  ),
                },
              ],
      };
    }
    const { component, environment } = await this.ensureNativeComponents(
      config.harness,
    );
    if (config.harness === "codex") {
      const { listCodexSkills } = await import("@catamorphic/codex");
      const skills = await listCodexSkills({
        executable: component.executablePath,
        workingDirectory,
        env: {
          ...environment,
          ...(config.auth === "account"
            ? { CODEX_HOME: this.agentHome(agentId) }
            : {}),
        },
      });
      return {
        commands: skills
          .filter(
            (skill) =>
              config.skills?.mode !== "picked" ||
              config.skills.names.includes(skill.name),
          )
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            argumentHint: "[instructions]",
            skillPath: skill.path,
          })),
      };
    }
    const { listClaudeSlashCommands } = await import(
      "@catamorphic/claude-code"
    );
    const hostSkills = this.deps.hostSkills?.();
    const generatedAliases = new Set(
      hostSkills?.skills.map(
        (skill) => `${hostSkills.plugin.name}:${skill.name}`,
      ),
    );
    return {
      commands: (
        await listClaudeSlashCommands({
          workingDirectory,
          pathToClaudeCodeExecutable: component.executablePath,
          env: {
            ...environment,
            ...(config.auth === "account"
              ? { CLAUDE_CONFIG_DIR: this.agentHome(agentId) }
              : {}),
          },
          plugins: this.mcp
            .resolve({ config, profileId })
            .plugins.map((plugin) => ({
              type: "local",
              path: plugin.path,
            })),
        })
      ).filter((command) => !generatedAliases.has(command.name)),
    };
  }

  /**
   * The model a chat with this agent runs in `workingDirectory` when neither
   * the chat nor the agent pins one — asked of the harness itself, with the
   * same configuration, consent, and credentials as execution: Claude
   * Code's effective settings, Codex's config layers and catalog default,
   * the built-in agent's resolved OpenRouter model. Answers are cached
   * briefly per agent and folder; each probe spawns the harness CLI.
   */
  async defaultModel({
    projectId,
    agentId,
    workingDirectory,
  }: {
    projectId: string;
    agentId: string;
    workingDirectory: string;
  }): Promise<AgentDefaultModelResult> {
    const ref = parseProjectAgentId(agentId);
    if (ref && ref.projectId !== projectId)
      return { model: null, error: "This agent belongs to another project." };
    const resolved = ref
      ? this.resolveProjectConfig(agentId, ref.projectId, ref.slug)
      : this.findConfig(agentId);
    if (!resolved) return { model: null, error: "Select an available agent." };
    if ("error" in resolved) return { model: null, error: resolved.error };
    const { config, profileId } = resolved;
    if (profileId !== this.deps.profiles.profileForProject(projectId).id)
      return { model: null, error: "This agent belongs to another profile." };
    // E2E: every harness is the fake agent, whose catalog lists this model.
    if (this.deps.e2eFake)
      return { model: { id: "fake-model-a-2.1", name: "Fake Model A" } };
    if (config.harness === "ai-sdk") {
      const id = this.resolvedModel(config);
      return { model: id ? { id } : null };
    }
    const key = `${agentId}\n${workingDirectory}`;
    const signature = JSON.stringify(config);
    const cached = this.defaultModels.get(key);
    if (
      cached?.signature === signature &&
      Date.now() - cached.at < DEFAULT_MODEL_TTL_MS
    )
      return cached.result;
    // Folders come and go (worktrees, session checkouts): drop stale answers.
    for (const [entryKey, entry] of this.defaultModels)
      if (Date.now() - entry.at >= DEFAULT_MODEL_TTL_MS)
        this.defaultModels.delete(entryKey);
    const result = this.probeDefaultModel(config, workingDirectory);
    this.defaultModels.set(key, { signature, at: Date.now(), result });
    // A failed probe is not an answer worth keeping.
    void result.then((value) => {
      if (value.error && this.defaultModels.get(key)?.result === result)
        this.defaultModels.delete(key);
    });
    return result;
  }

  private async probeDefaultModel(
    config: AgentConfig,
    workingDirectory: string,
  ): Promise<AgentDefaultModelResult> {
    if (config.harness === "ai-sdk") return { model: null };
    try {
      const { component, environment } = await this.ensureNativeComponents(
        config.harness,
      );
      if (config.harness === "codex") {
        const { resolveCodexModel } = await import("@catamorphic/codex");
        return {
          model: await resolveCodexModel({
            executable: component.executablePath,
            workingDirectory,
            env: {
              ...environment,
              ...(config.auth === "account"
                ? { CODEX_HOME: this.agentHome(config.id) }
                : {}),
              ...(config.auth === "api-key" && config.apiKey
                ? {
                    CODEX_API_KEY: config.apiKey,
                    OPENAI_API_KEY: config.apiKey,
                  }
                : {}),
            },
          }),
        };
      }
      const { resolveClaudeCodeModel } = await import(
        "@catamorphic/claude-code"
      );
      return {
        model: await resolveClaudeCodeModel({
          workingDirectory,
          pathToClaudeCodeExecutable: component.executablePath,
          env: {
            ...environment,
            ...(config.auth === "account"
              ? { CLAUDE_CONFIG_DIR: this.agentHome(config.id) }
              : {}),
            ...(config.auth === "api-key" && config.apiKey
              ? { ANTHROPIC_API_KEY: config.apiKey }
              : {}),
          },
        }),
      };
    } catch (cause) {
      console.warn("[desktop] default model discovery failed:", cause);
      return {
        model: null,
        error: "Could not ask the agent which model it uses by default.",
      };
    }
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
   * `.work/project.json` manifest), the owning profile's global
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
    if (projectRef)
      return this.getProjectAgent(id, projectRef.projectId, projectRef.slug);
    const found = this.findConfig(id);
    if (!found) return undefined;
    const { config, profileId } = found;
    const built = this.build({ config, profileId });
    if (!built) return undefined;
    return {
      id,
      ...built,
      topology: "native",
      sandboxing: config.sandboxing ?? DESKTOP_DEFAULT_SANDBOXING,
      ...(config.environment ? { environment: config.environment } : {}),
      // The agent's own instructions lead, exactly like a project agent's
      // persona file; the host's playbook follows them.
      ...(config.instructions ? { systemPrompt: config.instructions } : {}),
      ...(config.delegation ? { delegation: config.delegation } : {}),
    };
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
  private resolveProjectConfig(
    id: string,
    projectId: string,
    slug: string,
  ):
    | {
        config: AgentConfig;
        profileId: string;
        def: AgentDefinition;
        persona: string | undefined;
        source: string;
        hash: string;
        rootPath: string;
      }
    | { error: string; missing?: boolean } {
    const rootPath = this.deps.projectRootPath?.(projectId);
    if (!rootPath) {
      return {
        error: "The project agent is no longer available.",
        missing: true,
      };
    }
    const agentsDir = path.join(rootPath, PROJECT_AGENTS_DIR);
    let rawText: string;
    try {
      rawText = fs.readFileSync(path.join(agentsDir, `${slug}.json`), "utf-8");
    } catch {
      // No definition file → the agent does not exist.
      return {
        error: "The project agent is no longer available.",
        missing: true,
      };
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
      return {
        error: `The project agent file agents/${slug}.json is not valid JSON. Fix the file and try again.`,
      };
    }
    const validated = validateAgentDefinition(raw, {
      allowE2eFake: this.deps.e2eFake,
    });
    if ("error" in validated) {
      return {
        error: `The project agent definition agents/${slug}.json is invalid (${validated.error}). Fix the file and try again.`,
      };
    }
    const def = validated.definition;

    if (def.kind === "acp") {
      return {
        error: `"${def.name}" is an ACP agent. ACP harness support isn't built yet. Pick another agent for now.`,
      };
    }

    // The security core: a committed definition is collaborator-authored
    // code. Before it runs on THIS user's own credentials, the owning
    // profile must hold a consent binding whose hash matches the
    // definition's current sensitive state (kind, model, credentials,
    // persona). "secret" definitions skip this — the project secret is
    // the authorization and nothing personal is used. The e2e fake kind
    // auto-consents under the e2e flag (it never touches credentials).
    const source = def.credentials?.source ?? "profile";
    if (source === "connection") {
      // ADR 0180: the harness runs in a server sandbox and reaches its
      // model through that server's gateway; nothing here can serve it.
      return {
        error: `"${def.name}" uses the model connection '${def.credentials?.connection ?? ""}' of a Work server. Ask it from the project's server, or pick another agent here.`,
      };
    }
    const hash = definitionHash(def, persona);
    const stores = this.deps.profileConfig.forProject(projectId);
    let bindingAuth:
      | { mode: "local" }
      | { mode: "api-key"; apiKey: string | null }
      | undefined;
    if (def.kind !== "e2e-fake" && source !== "secret") {
      const binding = stores.agentBindings.get(projectId, slug);
      if (!binding) {
        return {
          error: `The project agent "${def.name}" needs your approval before it can use your credentials. Open the agent picker to review and approve it.`,
        };
      }
      if (binding.consentHash !== hash) {
        return {
          error: `The definition of the project agent "${def.name}" changed since you approved it. Open the agent picker to review and re-approve it.`,
        };
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
      ...(def.sandboxing ? { sandboxing: def.sandboxing } : {}),
      ...(def.harnessPermissions
        ? { harnessPermissions: def.harnessPermissions }
        : {}),
      ...(def.coordination ? { coordination: def.coordination } : {}),
      ...(def.memory === true ? { memory: true } : {}),
      auth:
        source === "secret" || bindingAuth?.mode === "api-key"
          ? "api-key"
          : "local",
      apiKey: bindingAuth?.mode === "api-key" ? bindingAuth.apiKey : null,
      // Project agents never inherit profile connectors. Their declared
      // connections are admitted and mounted through the Environment broker.
      connections: { mode: "picked", connectionIds: [] },
      ...(def.skills
        ? { skills: { mode: "picked" as const, names: def.skills } }
        : {}),
      // Keyed by connector NAME in a committed definition; resolveMcp
      // matches by name/server key as well as by id.
      ...(def.toolPolicies
        ? {
            toolPolicies: Object.fromEntries(
              Object.entries(def.toolPolicies).map(([alias, policy]) => [
                alias === WORKFLOWS_SERVER_KEY
                  ? alias
                  : connectionMcpServerName(alias),
                policy,
              ]),
            ),
          }
        : {}),
      ...(def.delegation ? { delegation: def.delegation } : {}),
    };
    return { config, profileId, def, persona, source, hash, rootPath };
  }

  private getProjectAgent(
    id: string,
    projectId: string,
    slug: string,
  ): RegisteredCodingAgent | undefined {
    const resolved = this.resolveProjectConfig(id, projectId, slug);
    if ("error" in resolved)
      return resolved.missing ? undefined : this.failFast(id, resolved.error);
    const { config, profileId, def, persona, source } = resolved;
    // A secret-credentialed agent reads its key from the project's secrets
    // at each attempt: the registry is synchronous, secrets are not, and a
    // secret set after a failed turn is picked up by the next one.
    const secretName = def.credentials?.secret;
    const apiKey =
      source === "secret" && !this.deps.e2eFake
        ? async () => {
            const value = secretName
              ? await this.deps.projectSecret?.(projectId, secretName)
              : undefined;
            if (!value)
              throw new Error(
                `The project agent "${def.name}" authenticates with the project secret "${secretName ?? ""}", which has no value. Add it under the project's secrets and send your message again.`,
              );
            return value;
          }
        : undefined;
    if (source === "secret" && !this.deps.e2eFake && !secretName)
      return this.failFast(
        id,
        `The project agent "${def.name}" names no project secret for its credentials. Fix its definition in agents/ and try again.`,
      );
    const built = this.build({ config, profileId, ...(apiKey ? { apiKey } : {}) });
    if (!built)
      return this.failFast(
        id,
        `The project agent "${def.name}" has no usable credentials or model. Approve it again from the agent picker, or check its definition.`,
      );
    return {
      id,
      ...built,
      topology: "native",
      sandboxing: def.sandboxing ?? DESKTOP_DEFAULT_SANDBOXING,
      ...(def.environment ? { environment: def.environment } : {}),
      ...(def.connections ? { connectionRequirements: def.connections } : {}),
      defaults: {
        ...built.defaults,
        effort: def.effort ?? "medium",
        ...(def.model ? { model: def.model } : {}),
      },
      ...(persona ? { systemPrompt: persona } : {}),
      delegation: resolveProjectDelegation(def.delegation, projectId),
    };
  }

  /** A registered-but-blocked agent: errors actionably, never hangs. */
  private failFast(id: string, message: string): RegisteredCodingAgent {
    return {
      id,
      harness: { placement: "host", adapter: unavailableAdapter(message) },
      topology: "native",
      defaults: {},
    };
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


  /**
   * The harness one agent config runs on, with everything the host serves
   * it read live at each attempt: workspace tools, tool policies, the
   * workspace context and instructions. Undefined while the config cannot
   * run yet (the built-in agent without a key or model).
   */
  private build({
    config,
    profileId,
    apiKey,
  }: {
    config: AgentConfig;
    profileId: string;
    /** The model key, resolved at each attempt (a project secret). */
    apiKey?: () => Promise<string>;
  }): BuiltAgent | undefined {
    const errors = this.errorLabels(config);
    const live = () => this.mcp.live({ config, profileId });
    const served = {
      hostTools: this.workspaceTools(config, "native") ?? [],
      toolPolicies: () => live().policies,
      toolAnnotations: () => live().annotations,
      ...this.workspaceHooks({ config, profileId }),
    } satisfies Partial<HostHarness>;

    // E2E: same registry mechanics, scripted harness, so renderer flows
    // (agent lists, switching, effort) exercise the real plumbing. Friendly
    // errors stay on so tests cover the auth-failure surfacing.
    if (this.deps.e2eFake) {
      const fake = new E2eFakeAdapter({
        settingsContext: (projectId) => this.settingsContext(projectId, config),
      });
      return {
        harness: {
          placement: "host",
          adapter: desktopAdapter({
            id: fake.id,
            capabilities: () => fake.capabilities(),
            prepare: async (attempt) => ({ adapter: fake, attempt }),
            errors,
          }),
          ...served,
        },
        defaults: { effort: config.effort },
      };
    }

    switch (config.harness) {
      case "ai-sdk": {
        const modelId = this.resolvedModel(config);
        if (!modelId || (!config.apiKey && !apiKey)) {
          // Only profiles that actually selected model-less OpenRouter need
          // its live catalog. Avoid a network request on every app launch.
          if (config.provider === "openrouter" && !this.openrouterDefault)
            void this.refreshOpenRouterDefault();
          return undefined;
        }
        // Without a key yet (a project secret), the adapter is built per
        // attempt; its capabilities never depend on the key.
        const adapter = buildAiSdkAdapter({
          config: { ...config, apiKey: config.apiKey ?? "unresolved" },
          modelId,
        });
        if (!adapter) return undefined;
        const readable = this.deps.attachmentsDir
          ? readableAttachments({ attachmentsDir: this.deps.attachmentsDir })
          : undefined;
        return {
          harness: {
            placement: "host",
            adapter: desktopAdapter({
              id: AI_SDK_HARNESS,
              capabilities: () => adapter.capabilities(),
              prepare: async (attempt) => {
                const key = apiKey ? await apiKey() : undefined;
                const keyed = key
                  ? buildAiSdkAdapter({
                      config: { ...config, apiKey: key },
                      modelId,
                    })
                  : adapter;
                if (!keyed)
                  throw new Error(
                    `The agent "${config.name}" could not be constructed. Check its model and API key, then try again.`,
                  );
                return { adapter: keyed, attempt };
              },
              errors,
            }),
            ...served,
            // Trusted local IO in the chat's own checkout, no copied sandbox.
            local: (turn) => ({
              ...(turn.workingDirectory
                ? {
                    sandbox: {
                      provider: localAgentWorkspace,
                      sandboxId: "local",
                      workingDirectory: turn.workingDirectory,
                    },
                  }
                : {}),
              ...(readable
                ? { readableRoots: readable({ projectId: turn.projectId }) }
                : {}),
              ...(turn.sessionId ? { shell: this.shell(turn.sessionId) } : {}),
            }),
          },
          defaults: { model: modelId, effort: config.effort },
        };
      }
      case "claude-code": {
        const permissions = effectiveHarnessPermissions({
          harness: "claude-code",
          permissions: config.harnessPermissions,
        });
        return {
          harness: {
            placement: "host",
            adapter: desktopAdapter({
              id: claudeCode.id,
              capabilities: () => CLAUDE_CODE_CAPABILITIES,
              prepare: (attempt) =>
                this.nativeAttempt({
                  harness: "claude-code",
                  adapter: claudeCode,
                  attempt,
                  keyEnv: apiKey
                    ? async () => ({ ANTHROPIC_API_KEY: await apiKey() })
                    : undefined,
                }),
              errors,
            }),
            ...served,
            // `local` inherits the machine's existing Claude Code login: the
            // CLI runs with no credential overrides at all.
            env: {
              ...(config.auth === "account"
                ? { CLAUDE_CONFIG_DIR: this.agentHome(config.id) }
                : {}),
              ...(config.auth === "api-key" && config.apiKey
                ? { ANTHROPIC_API_KEY: config.apiKey }
                : {}),
            },
            // Connector plugins and the host skills load natively.
            plugins: this.mcp.resolve({ config, profileId }).plugins,
          },
          options: {
            memory: config.memory === true,
            // Host watches, todos and subsessions replace Claude Code's own.
            disableNativeMonitors: true,
            hostOwnsTodos: true,
            hostOwnsSubagents: true,
          },
          defaults: {
            effort: config.effort,
            ...(config.model ? { model: config.model } : {}),
            harnessPermissions: permissions,
          },
        };
      }
      case "codex": {
        const permissions = effectiveHarnessPermissions({
          harness: "codex",
          permissions: config.harnessPermissions,
        });
        return {
          harness: {
            placement: "host",
            adapter: desktopAdapter({
              id: codex.id,
              capabilities: () => CODEX_CAPABILITIES,
              prepare: (attempt) =>
                this.nativeAttempt({
                  harness: "codex",
                  adapter: codex,
                  attempt,
                  keyEnv: apiKey
                    ? async () => ({ CODEX_API_KEY: await apiKey() })
                    : undefined,
                }),
              errors,
            }),
            ...served,
            env: {
              ...(config.auth === "account"
                ? { CODEX_HOME: this.agentHome(config.id) }
                : {}),
              ...(config.auth === "api-key" && config.apiKey
                ? { CODEX_API_KEY: config.apiKey }
                : {}),
            },
            // Stateful native computer use belongs to the Codex process
            // that started it, never the profile-wide tool pool.
            mcpServers: () => live().nativeServers ?? {},
          },
          options: {
            // Host subsessions and todos replace Codex's own.
            disableNativeSubagents: true,
            disableNativeGoals: true,
          },
          defaults: {
            effort: config.effort,
            ...(config.model ? { model: config.model } : {}),
            harnessPermissions: permissions,
          },
        };
      }
    }
  }

  /**
   * A native harness's attempt on this machine: the integrity-pinned
   * executable (downloaded on first use), Bun and the shell shims on PATH,
   * and a key resolved for this attempt when the agent has one.
   */
  private async nativeAttempt(input: {
    harness: DownloadableHarness;
    adapter: HarnessAdapter;
    attempt: AttemptStart;
    keyEnv?: () => Promise<Record<string, string>>;
  }): Promise<{ adapter: HarnessAdapter; attempt: AttemptStart }> {
    const { component, environment } = await this.ensureNativeComponents(
      input.harness,
    );
    const key = input.keyEnv ? await input.keyEnv() : {};
    const options: JsonObject = {
      ...input.attempt.options,
      command: component.executablePath,
    };
    return {
      adapter: input.adapter,
      attempt: {
        ...input.attempt,
        env: { ...environment, ...input.attempt.env, ...key },
        options,
      },
    };
  }

  /**
   * Workspace awareness for every harness (ADR 0152): the Work section of
   * the agent's instructions, and each turn's screen, desktop facts and
   * peers. Nothing without a workspace bridge.
   */
  private workspaceHooks({
    config,
    profileId,
  }: {
    config: AgentConfig;
    profileId: string;
  }): Pick<HostHarness, "context" | "instructions"> {
    const bridge = this.deps.workspaceBridge;
    if (!bridge) return {};
    const hasTools = this.workspaceToolkit !== undefined;
    const strategy = config.coordination ?? "shared-first";
    return {
      instructions: workspaceInstructions({
        hasTools,
        strategy,
        skillsNote: this.skillsNote(config, profileId, hasTools),
      }),
      context: async (turn: AgentTurnContext) =>
        turn.sessionId
          ? workspaceTurnContext({
              bridge,
              projectId: turn.projectId,
              sessionId: turn.sessionId,
              coordination: {
                strategy,
                peers: (projectId, sessionId) =>
                  this.deps.sessionPeers?.(projectId, sessionId) ??
                  Promise.resolve([]),
                checkoutNotice: (projectId, sessionId) =>
                  this.deps.checkoutNotice?.(projectId, sessionId) ??
                  Promise.resolve(null),
              },
              desktopFacts: (projectId) => {
                const settings = this.settingsContext(projectId, config);
                return {
                  ...("personalFilesDirectory" in settings &&
                  settings.personalFilesDirectory
                    ? { personalFilesDirectory: settings.personalFilesDirectory }
                    : {}),
                  ...("errors" in settings && settings.errors?.length
                    ? { settingsErrors: settings.errors }
                    : {}),
                };
              },
            })
          : [],
    };
  }

  /**
   * Who failed, for errors the person can act on: raw provider bodies
   * (OpenRouter's 401 is literally "User not found.") become a reconnect.
   */
  private errorLabels(config: AgentConfig): AgentErrorLabels {
    const labels: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      openrouter: "OpenRouter",
    };
    return {
      agentName: config.name,
      providerLabel:
        config.harness === "claude-code"
          ? "Claude Code"
          : config.harness === "codex"
            ? "Codex"
            : (labels[config.provider ?? "anthropic"] ?? "The model provider"),
    };
  }

  /** The built-in agent's shell for one chat, kept across its turns. */
  private shell(sessionId: string): ShellState {
    let shell = this.shells.get(sessionId);
    if (!shell) {
      shell = {};
      this.shells.set(sessionId, shell);
    }
    return shell;
  }

  /** Host configuration paths and state, for the desktop_settings tool. */
  settingsContext(projectId: string, config?: Pick<AgentConfig, "sandboxing">) {
    return desktopSettingsContext({
      config: this.deps.profileConfig,
      profileId: this.deps.profiles.profileForProject(projectId).id,
      project: {
        id: projectId,
        rootPath: this.deps.projectRootPath?.(projectId) ?? null,
      },
      access: config?.sandboxing === "contained" ? "read-only" : "native",
    });
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
      // The skills plugin lists the app tier for Claude Code itself.
      appSkillsNative:
        config.harness === "claude-code" && setting.mode !== "picked",
      ...(host ? { appSkillsDir: host.skillsDir } : {}),
      userSkills: this.deps.userSkills?.(profileId) ?? [],
      ...(setting.mode === "picked" ? { picked: setting.names } : {}),
      hasTools,
    });
  }

  /**
   * The workspace toolset for one agent: a contained agent (ADR 0182)
   * loses the tools that run commands, mutate the project, or act on the
   * user's behalf. Its harness's permission mode governs only the harness,
   * not host tools.
   */
  private workspaceTools(
    config: Pick<AgentConfig, "sandboxing">,
    topology: RegisteredCodingAgent["topology"],
    all = false,
  ): WorkspaceTool[] | undefined {
    const tools = this.workspaceToolkit?.tools;
    if (!tools) return undefined;
    return tools.filter(
      (tool) =>
        (all || tool.eager) &&
        (topology === "native" || !tool.nativeOnly) &&
        (config.sandboxing !== "contained" || tool.readOnly),
    );
  }


  /** Live policy/configuration, shared by direct and discovered projections. */
  capabilitySurface(id: string) {
    const found = this.configFor(id);
    if (!found || !this.get(id)) return undefined;
    const { config, profileId } = found;
    return {
      revision: JSON.stringify([id, config.sandboxing, profileId, "native"]),
      tools: this.workspaceTools(config, "native", true) ?? [],
      readOnly: config.sandboxing === "contained",
      profileId,
      mcp: this.mcp.live({ config, profileId }),
    };
  }

  /** A profile agent's config, or a project agent's as its definition says. */
  private configFor(
    id: string,
  ): { config: AgentConfig; profileId: string } | undefined {
    const profile = this.findConfig(id);
    if (profile) return profile;
    const project = parseProjectAgentId(id);
    if (!project) return undefined;
    const resolved = this.resolveProjectConfig(
      id,
      project.projectId,
      project.slug,
    );
    return "error" in resolved
      ? undefined
      : { config: resolved.config, profileId: resolved.profileId };
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
          path.join(root, PROJECT_AGENTS_DIR, `${project.slug}.json`),
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
}

