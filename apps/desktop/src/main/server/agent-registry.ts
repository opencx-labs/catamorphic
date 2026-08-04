import fs from "node:fs";
import path from "node:path";
import { ClaudeCodeAgent } from "@catamorphic/claude-code";
import { CodexAgent } from "@catamorphic/codex";
import type {
  CodingAgentRegistry,
  RegisteredCodingAgent,
} from "@catamorphic/core";
import type {
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import type { AgentConfig } from "../agents-store.js";
import { bestFreeModelId, fetchOpenRouterModels } from "../openrouter.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { buildAiSdkAgent } from "./coding-agent.js";
import { DesktopConfigAgent } from "./desktop-config-agent.js";
import { E2eFakeCodingAgent } from "./e2e-fakes.js";

export interface DesktopAgentRegistryDeps {
  profiles: ProfilesStore;
  profileConfig: ProfileConfigManager;
  sandboxProvider: SandboxProvider;
  /** `agent-homes/` root; each account-auth agent gets a private home. */
  agentHomesDir: string;
  /** E2E: every configured agent resolves to the scripted fake. */
  e2eFake?: boolean;
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
  /**
   * OpenRouter's current best free model, warmed from the live catalog —
   * the default for openrouter agents with no model pinned. Nothing is
   * hardcoded: until the catalog answers, such agents stay unresolved.
   */
  private openrouterDefault: string | undefined;

  constructor(private readonly deps: DesktopAgentRegistryDeps) {
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
    const config = this.findConfig(id);
    if (!config) {
      this.cache.delete(id);
      return undefined;
    }
    // Providers are cached by credential identity only: model and effort
    // travel per turn (TurnOptions via fresh defaults below), so switching
    // them must NOT rebuild the provider — a rebuild would drop the
    // built-in agent's in-memory sessions mid-conversation.
    const key = JSON.stringify({ ...config, model: "", effort: "" });
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

    const built = this.build(config);
    if (!built) {
      this.cache.delete(id);
      return undefined;
    }
    this.cache.set(id, {
      key,
      provider: built.provider,
      execution: built.execution,
    });
    return { ...built, defaults };
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

  private findConfig(id: string): AgentConfig | undefined {
    for (const profile of this.deps.profiles.list().profiles) {
      const config = this.deps.profileConfig
        .forProfile(profile.id)
        .agents.get(id);
      if (config) return config;
    }
    return undefined;
  }

  private build(config: AgentConfig): RegisteredCodingAgent | undefined {
    // E2E: same registry mechanics, scripted provider — renderer flows
    // (agent lists, switching, effort) exercise the real plumbing.
    if (this.deps.e2eFake) {
      return {
        id: config.id,
        provider: this.wrapSandboxAgent(
          new E2eFakeCodingAgent(this.deps.sandboxProvider),
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
        );
        if (!provider) {
          // An unresolved OpenRouter default may just not have warmed yet.
          if (config.provider === "openrouter" && !this.openrouterDefault) {
            void this.refreshOpenRouterDefault();
          }
          return undefined;
        }
        return {
          id: config.id,
          provider: this.wrapSandboxAgent(provider),
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
          provider: new ClaudeCodeAgent({
            model: config.model || undefined,
            effort: config.effort,
            ...(Object.keys(env).length > 0 ? { env } : {}),
          }),
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
          provider: new CodexAgent({
            model: config.model || undefined,
            effort: config.effort,
            ...(config.auth === "api-key" && config.apiKey
              ? { apiKey: config.apiKey }
              : {}),
            ...(config.auth === "account"
              ? { env: { CODEX_HOME: this.agentHome(config.id) } }
              : {}),
          }),
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
