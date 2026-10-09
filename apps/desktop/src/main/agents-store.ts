import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentCoordinationStrategy,
  AgentDelegationPolicy,
  AgentEnvironmentPolicy,
} from "@catamorphic/core";
import { AgentDelegationPolicySchema } from "@catamorphic/core";
import {
  harnessPermissionIssues,
  type McpToolPolicy,
} from "@catamorphic/sandbox";
import { safeStorage } from "electron";
import {
  DESKTOP_DEFAULT_SANDBOXING,
  effectiveHarnessPermissions,
  type HarnessPermissions,
  type Sandboxing,
} from "../shared/agent-permissions.js";

/**
 * Per-profile AI agent roster: `<userData>/profiles/<id>/agents.json`.
 *
 * A profile can hold several agents — two Claude Code agents on different
 * accounts and a Codex, say — each a named configuration of a harness:
 *  - `ai-sdk`: the built-in sandboxed agent (Vercel AI SDK tool loop).
 *    Runs against the per-project dev sandbox with draft sync-back, on an
 *    Anthropic, OpenAI, or OpenRouter model.
 *  - `claude-code`: the Claude Code CLI on this machine, working directly
 *    in the project folder.
 *  - `codex`: the OpenAI Codex CLI on this machine, likewise.
 *
 * Auth is per agent: an API key (encrypted at rest via safeStorage) or
 * `account` — for the CLIs that's their own login isolated per agent
 * through a private home dir (CLAUDE_CONFIG_DIR / CODEX_HOME); for the
 * built-in agent on OpenRouter it's the browser PKCE flow, whose scoped
 * key lands back in the config so the user never pastes one.
 */
export type AgentHarness = "ai-sdk" | "claude-code" | "codex";
export type AgentEffortSetting = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Which skills an agent is offered (any tier — project, user, host, by
 * name). "all" (the default) includes every current and future skill;
 * "picked" pins an explicit set: the prompt's skills section lists only
 * those, and the host-skills plugin is withheld from Claude Code.
 */
export type AgentSkillsSetting =
  | { mode: "all" }
  | { mode: "picked"; names: string[] };
/**
 * How an agent authenticates:
 *  - `local`  — the machine's existing CLI setup (~/.claude, ~/.codex): the
 *    SDK is spawned with no credential overrides, so whatever `claude
 *    login` / `codex login` established just works. An Anthropic key or
 *    token merely inherited from the shell Work started from never
 *    outranks that sign-in (unless Claude is routed to a gateway), so a
 *    chat and the commands it runs do not see it. The default for CLI
 *    harnesses.
 *  - `account` — a per-agent isolated login (private CLAUDE_CONFIG_DIR /
 *    CODEX_HOME, or OpenRouter's browser PKCE) for second accounts.
 *  - `api-key` — an explicit key, encrypted at rest.
 */
export type AgentAuthMode = "local" | "account" | "api-key";
export type AiSdkProvider = "anthropic" | "openai" | "openrouter";

/**
 * Which of the profile's MCP connections an agent gets. "all" (the
 * default) includes every current AND future connection; "picked" pins an
 * explicit subset. Editable per agent after creation.
 */
export type AgentConnectionsSetting =
  | { mode: "all" }
  | { mode: "picked"; connectionIds: string[] };

export interface AgentConfig {
  id: string;
  name: string;
  harness: AgentHarness;
  /** Model provider — built-in (ai-sdk) only; the CLIs imply theirs. */
  provider?: AiSdkProvider;
  /** Model id; empty string = the harness default. */
  model: string;
  effort: AgentEffortSetting;
  auth: AgentAuthMode;
  /** Decrypted in memory; never crosses the contextBridge. */
  apiKey: string | null;
  /**
   * The agent's own main prompt (its persona) — prepended at the provider
   * boundary so it leads and the host playbooks follow, exactly like a
   * project agent's `.work/agents/<slug>.md` (ADR 0056). Harness-neutral.
   */
  instructions?: string;
  /**
   * What may leave the agent's sandbox (ADR 0182); absent means "publish",
   * the local default (ADR 0140).
   */
  sandboxing?: Sandboxing;
  /**
   * The harness's own permission mode in its native values (ADR 0182):
   * Claude Code `permissionMode`, Codex `sandbox` and `approvals`. Absent
   * fields take the local defaults; the built-in agent has none.
   */
  harnessPermissions?: HarnessPermissions;
  /** Checkout doctrine; absent means "shared-first". */
  coordination?: AgentCoordinationStrategy;
  /** Logical Environment preferences and compatibility requirements. */
  environment?: AgentEnvironmentPolicy;
  /**
   * Claude Code auto-memory; absent means OFF — memory is opt-in
   * (ADR 0056): accumulated memories change an agent's behavior over
   * time without the user seeing it happen, so nothing remembers unless
   * the user turned it on. `true` enables the CLI's auto-memory. Other
   * harnesses have no memory and ignore it.
   */
  memory?: boolean;
  /** MCP connection assignment; absent means `{ mode: "all" }`. */
  connections?: AgentConnectionsSetting;
  /** Skills assignment; absent means `{ mode: "all" }`. */
  skills?: AgentSkillsSetting;
  /**
   * Per-connection tool policies this agent adds on top of the profile's
   * (keyed by connection id; see @catamorphic/sandbox tool-policy). Layers
   * intersect — an agent can narrow what the connection allows, never
   * widen it. The same shape a remote host would define for its agents.
   */
  toolPolicies?: Record<string, McpToolPolicy>;
  /** Explicit source-to-target subsession grants. */
  delegation?: AgentDelegationPolicy;
}

interface StoredAgent extends Omit<AgentConfig, "apiKey"> {
  apiKeyEncrypted?: string;
  apiKeyPlaintext?: string;
}

interface AgentsFile {
  agents: StoredAgent[];
  defaultAgentId?: string;
  /**
   * This user's per-project default agent overrides (ADR 0056): project id
   * → agent id (roster or `project:` id). Layered ABOVE the project's own
   * committed default and the global `defaultAgentId`.
   */
  projectDefaults?: Record<string, string>;
}

/** Media kinds an agent's chat input accepts (paste/attach gating). */
export type AgentAttachmentKind = "image" | "document";

/** Agent as exposed to the renderer: never the raw key. */
export interface PublicAgentConfig {
  id: string;
  name: string;
  harness: AgentHarness;
  provider?: AiSdkProvider;
  model: string;
  effort: AgentEffortSetting;
  auth: AgentAuthMode;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  /** What media the chat composer may attach for this agent. */
  accepts: AgentAttachmentKind[];
  /** The agent's own main prompt ("" when none). */
  instructions: string;
  /** What may leave the agent's sandbox (always materialized). */
  sandboxing: Sandboxing;
  /**
   * The harness's permission settings in effect (always materialized, only
   * the fields this harness has; empty for the built-in agent).
   */
  harnessPermissions: HarnessPermissions;
  /** Checkout-coordination doctrine (always materialized). */
  coordination: AgentCoordinationStrategy;
  environment?: AgentEnvironmentPolicy;
  /** Claude Code auto-memory (always materialized; opt-in, default false). */
  memory: boolean;
  /** MCP connection assignment (always materialized; default "all"). */
  connections: AgentConnectionsSetting;
  /** Skills assignment (always materialized; default "all"). */
  skills: AgentSkillsSetting;
  /** Per-connection tool policies layered on the profile's (by id). */
  toolPolicies: Record<string, McpToolPolicy>;
  delegation: AgentDelegationPolicy;
}

/**
 * Attachment support by harness/provider: Anthropic models read images and
 * PDFs; other API providers get images only (model-dependent beyond that —
 * failures surface as friendly errors). Claude Code reads image and
 * document files natively via its Read tool; Codex stages images and documents
 * as native image inputs and files for the turn.
 */
export function agentAccepts(config: {
  harness: AgentHarness;
  provider?: AiSdkProvider;
}): AgentAttachmentKind[] {
  switch (config.harness) {
    case "ai-sdk":
      return (config.provider ?? "anthropic") === "anthropic"
        ? ["image", "document"]
        : ["image"];
    case "claude-code":
      return ["image", "document"];
    case "codex":
      return ["image", "document"];
  }
}

/** What a new agent is called when the user leaves the name blank: the
 * product people know (Claude, ChatGPT), not the harness that runs it. */
export const DEFAULT_AGENT_NAMES: Record<AgentHarness, string> = {
  "ai-sdk": "Built-in",
  "claude-code": "Claude",
  codex: "ChatGPT",
};

export interface CreateAgentInput {
  name?: string;
  harness: AgentHarness;
  provider?: AiSdkProvider;
  model?: string;
  effort?: AgentEffortSetting;
  auth?: AgentAuthMode;
  apiKey?: string | null;
  instructions?: string;
  sandboxing?: Sandboxing;
  harnessPermissions?: HarnessPermissions;
  coordination?: AgentCoordinationStrategy;
  environment?: AgentEnvironmentPolicy;
  memory?: boolean;
  connections?: AgentConnectionsSetting;
  skills?: AgentSkillsSetting;
  toolPolicies?: Record<string, McpToolPolicy>;
  delegation?: AgentDelegationPolicy;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: AiSdkProvider;
  model?: string;
  effort?: AgentEffortSetting;
  auth?: AgentAuthMode;
  /** New key; omit to keep the stored one, null to clear it. */
  apiKey?: string | null;
  /** New instructions; "" clears them. */
  instructions?: string;
  sandboxing?: Sandboxing;
  /**
   * Replace the harness's permission settings; `{}` returns to the local
   * defaults. Fields the harness does not have are refused.
   */
  harnessPermissions?: HarnessPermissions;
  coordination?: AgentCoordinationStrategy;
  environment?: AgentEnvironmentPolicy;
  memory?: boolean;
  connections?: AgentConnectionsSetting;
  skills?: AgentSkillsSetting;
  /** Replace the per-connection tool policies (null clears them). */
  toolPolicies?: Record<string, McpToolPolicy> | null;
  delegation?: AgentDelegationPolicy;
}

export class AgentsStore {
  private data: AgentsFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): AgentsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (Array.isArray(raw?.agents)) return raw as AgentsFile;
    } catch {
      // First run.
    }
    return { agents: [] };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  list(): AgentConfig[] {
    return this.data.agents.map((agent) => this.decrypt(agent));
  }

  get(id: string): AgentConfig | undefined {
    const stored = this.data.agents.find((agent) => agent.id === id);
    return stored ? this.decrypt(stored) : undefined;
  }

  defaultAgentId(): string | undefined {
    if (
      this.data.defaultAgentId &&
      // Project agents (`project:<projectId>:<slug>`, ADR 0050) live in the
      // project repo, not this roster — a default pointing at one is taken
      // at face value; the registry validates it live per turn.
      (this.data.defaultAgentId.startsWith("project:") ||
        this.data.agents.some((agent) => agent.id === this.data.defaultAgentId))
    ) {
      return this.data.defaultAgentId;
    }
    return this.data.agents[0]?.id;
  }

  setDefault(id: string): void {
    if (
      id.startsWith("project:") ||
      this.data.agents.some((agent) => agent.id === id)
    ) {
      this.data.defaultAgentId = id;
      this.save();
    }
  }

  /**
   * This user's default-agent override for one project (ADR 0056 layer 1),
   * validated like {@link defaultAgentId} — an override naming a removed
   * agent is ignored so resolution falls to the next layer.
   */
  projectDefault(projectId: string): string | undefined {
    const id = this.data.projectDefaults?.[projectId];
    if (!id) return undefined;
    if (
      id.startsWith("project:") ||
      this.data.agents.some((agent) => agent.id === id)
    ) {
      return id;
    }
    return undefined;
  }

  /** Set (or with null clear) the per-project default-agent override. */
  setProjectDefault(projectId: string, agentId: string | null): void {
    if (agentId === null) {
      if (!this.data.projectDefaults?.[projectId]) return;
      delete this.data.projectDefaults[projectId];
      if (Object.keys(this.data.projectDefaults).length === 0) {
        delete this.data.projectDefaults;
      }
      this.save();
      return;
    }
    if (
      !agentId.startsWith("project:") &&
      !this.data.agents.some((agent) => agent.id === agentId)
    ) {
      return;
    }
    this.data.projectDefaults = {
      ...this.data.projectDefaults,
      [projectId]: agentId,
    };
    this.save();
  }

  /** The raw per-project overrides (renderer state; values validated live). */
  projectDefaults(): Record<string, string> {
    return { ...this.data.projectDefaults };
  }

  create(input: CreateAgentInput): AgentConfig {
    const harnessPermissions = checkedHarnessPermissions({
      harness: input.harness,
      permissions: input.harnessPermissions,
    });
    const stored: StoredAgent = {
      id: randomUUID(),
      name: input.name?.trim() || DEFAULT_AGENT_NAMES[input.harness],
      harness: input.harness,
      ...(input.harness === "ai-sdk"
        ? { provider: input.provider ?? "anthropic" }
        : {}),
      // Empty model = the harness/provider default, resolved at run time —
      // no model ids hardcoded here (OpenRouter picks its best free model).
      model: input.model?.trim() ?? "",
      effort: input.effort ?? "medium",
      auth:
        input.auth ??
        (input.harness === "ai-sdk"
          ? input.provider === "openrouter"
            ? "account"
            : "api-key"
          : "local"),
      ...(input.instructions?.trim()
        ? { instructions: input.instructions.trim() }
        : {}),
      ...(input.sandboxing ? { sandboxing: input.sandboxing } : {}),
      ...(harnessPermissions ? { harnessPermissions } : {}),
      ...(input.coordination && input.coordination !== "shared-first"
        ? { coordination: input.coordination }
        : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.memory === true ? { memory: true } : {}),
      ...(input.connections ? { connections: input.connections } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.toolPolicies ? { toolPolicies: input.toolPolicies } : {}),
      ...(input.delegation
        ? { delegation: AgentDelegationPolicySchema.parse(input.delegation) }
        : {}),
      ...this.encrypt(input.apiKey ?? null),
    };
    this.data.agents.push(stored);
    this.data.defaultAgentId ??= stored.id;
    this.save();
    return this.decrypt(stored);
  }

  update(id: string, patch: UpdateAgentInput): AgentConfig | undefined {
    const stored = this.data.agents.find((agent) => agent.id === id);
    if (!stored) return undefined;
    if (patch.name !== undefined)
      stored.name = patch.name.trim() || stored.name;
    if (patch.provider !== undefined && stored.harness === "ai-sdk") {
      stored.provider = patch.provider;
    }
    if (patch.model !== undefined) stored.model = patch.model.trim();
    if (patch.effort !== undefined) stored.effort = patch.effort;
    if (patch.auth !== undefined) stored.auth = patch.auth;
    if (patch.instructions !== undefined) {
      const instructions = patch.instructions.trim();
      if (instructions) stored.instructions = instructions;
      else delete stored.instructions;
    }
    if (patch.sandboxing !== undefined) {
      stored.sandboxing = patch.sandboxing;
    }
    if (patch.harnessPermissions !== undefined) {
      const harnessPermissions = checkedHarnessPermissions({
        harness: stored.harness,
        permissions: patch.harnessPermissions,
      });
      if (harnessPermissions) stored.harnessPermissions = harnessPermissions;
      else delete stored.harnessPermissions;
    }
    if (patch.coordination !== undefined) {
      if (patch.coordination === "shared-first") delete stored.coordination;
      else stored.coordination = patch.coordination;
    }
    if (patch.environment !== undefined) {
      stored.environment = patch.environment;
    }
    if (patch.memory !== undefined) {
      if (patch.memory) stored.memory = true;
      else delete stored.memory;
    }
    if (patch.connections !== undefined) stored.connections = patch.connections;
    if (patch.skills !== undefined) {
      if (patch.skills.mode === "all") delete stored.skills;
      else stored.skills = patch.skills;
    }
    if (patch.toolPolicies !== undefined) {
      stored.toolPolicies = patch.toolPolicies ?? undefined;
    }
    if (patch.delegation !== undefined) {
      stored.delegation = AgentDelegationPolicySchema.parse(patch.delegation);
    }
    if (patch.apiKey !== undefined) {
      const { apiKeyEncrypted, apiKeyPlaintext } = this.encrypt(
        patch.apiKey?.trim() || null,
      );
      stored.apiKeyEncrypted = apiKeyEncrypted;
      stored.apiKeyPlaintext = apiKeyPlaintext;
    }
    this.save();
    return this.decrypt(stored);
  }

  remove(id: string): boolean {
    const before = this.data.agents.length;
    this.data.agents = this.data.agents.filter((agent) => agent.id !== id);
    if (this.data.agents.length === before) return false;
    if (this.data.defaultAgentId === id) {
      this.data.defaultAgentId = this.data.agents[0]?.id;
    }
    for (const [projectId, agentId] of Object.entries(
      this.data.projectDefaults ?? {},
    )) {
      if (agentId === id) this.setProjectDefault(projectId, null);
    }
    this.save();
    return true;
  }

  private encrypt(apiKey: string | null): {
    apiKeyEncrypted?: string;
    apiKeyPlaintext?: string;
  } {
    if (!apiKey) return {};
    if (safeStorage.isEncryptionAvailable()) {
      return {
        apiKeyEncrypted: safeStorage.encryptString(apiKey).toString("base64"),
      };
    }
    console.warn(
      "[desktop] OS keychain encryption unavailable; storing API key in plaintext.",
    );
    return { apiKeyPlaintext: apiKey };
  }

  private decrypt(stored: StoredAgent): AgentConfig {
    const { apiKeyEncrypted, apiKeyPlaintext, ...rest } = stored;
    let apiKey: string | null = null;
    if (apiKeyEncrypted) {
      try {
        apiKey = safeStorage.decryptString(
          Buffer.from(apiKeyEncrypted, "base64"),
        );
      } catch {
        apiKey = null;
      }
    } else {
      apiKey = apiKeyPlaintext ?? null;
    }
    return { ...rest, apiKey };
  }
}

/**
 * Permission settings this harness has, without unset fields; undefined when
 * none are set. Throws on a field another harness owns.
 */
function checkedHarnessPermissions(args: {
  harness: AgentHarness;
  permissions: HarnessPermissions | undefined;
}): HarnessPermissions | undefined {
  if (!args.permissions) return undefined;
  const issue = harnessPermissionIssues({
    kind: args.harness === "ai-sdk" ? "builtin" : args.harness,
    permissions: args.permissions,
  })[0];
  if (issue) throw new Error(issue.message);
  const { permissionMode, sandbox, approvals } = args.permissions;
  const kept: HarnessPermissions = {
    ...(permissionMode ? { permissionMode } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(approvals ? { approvals } : {}),
  };
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export function toPublicAgent(agent: AgentConfig): PublicAgentConfig {
  const { apiKey, ...rest } = agent;
  return {
    ...rest,
    hasApiKey: apiKey !== null,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}` : null,
    accepts: agentAccepts(agent),
    instructions: agent.instructions ?? "",
    sandboxing: agent.sandboxing ?? DESKTOP_DEFAULT_SANDBOXING,
    harnessPermissions: effectiveHarnessPermissions({
      harness: agent.harness,
      permissions: agent.harnessPermissions,
    }),
    coordination: agent.coordination ?? "shared-first",
    memory: agent.memory === true,
    connections: agent.connections ?? { mode: "all" },
    skills: agent.skills ?? { mode: "all" },
    toolPolicies: agent.toolPolicies ?? {},
    delegation: agent.delegation ?? {
      enabled: true,
      maxConcurrentChildren: 10,
      routes: [
        {
          id: "same-agent",
          target: "self",
          allowFurtherDelegation: true,
        },
      ],
    },
  };
}
