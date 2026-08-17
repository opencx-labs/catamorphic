import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpToolPolicy } from "@catamorphic/sandbox";
import { safeStorage } from "electron";

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
export type AgentEffortSetting = "low" | "medium" | "high";
/**
 * How an agent authenticates:
 *  - `local`  — the machine's existing CLI setup (~/.claude, ~/.codex): the
 *    SDK is spawned with no credential overrides, so whatever `claude
 *    login` / `codex login` established just works. The default for CLI
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
  /** MCP connection assignment; absent means `{ mode: "all" }`. */
  connections?: AgentConnectionsSetting;
  /**
   * Per-connection tool policies this agent adds on top of the profile's
   * (keyed by connection id; see @catamorphic/sandbox tool-policy). Layers
   * intersect — an agent can narrow what the connection allows, never
   * widen it. The same shape a remote host would define for its agents.
   */
  toolPolicies?: Record<string, McpToolPolicy>;
}

interface StoredAgent extends Omit<AgentConfig, "apiKey"> {
  apiKeyEncrypted?: string;
  apiKeyPlaintext?: string;
}

interface AgentsFile {
  agents: StoredAgent[];
  defaultAgentId?: string;
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
  /** MCP connection assignment (always materialized; default "all"). */
  connections: AgentConnectionsSetting;
  /** Per-connection tool policies layered on the profile's (by id). */
  toolPolicies: Record<string, McpToolPolicy>;
}

/**
 * Attachment support by harness/provider: Anthropic models read images and
 * PDFs; other API providers get images only (model-dependent beyond that —
 * failures surface as friendly errors). Claude Code reads image and
 * document files natively via its Read tool; Codex has no media path yet.
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
      return [];
  }
}

export const HARNESS_LABELS: Record<AgentHarness, string> = {
  "ai-sdk": "Built-in",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export interface CreateAgentInput {
  name?: string;
  harness: AgentHarness;
  provider?: AiSdkProvider;
  model?: string;
  effort?: AgentEffortSetting;
  auth?: AgentAuthMode;
  apiKey?: string | null;
  connections?: AgentConnectionsSetting;
  toolPolicies?: Record<string, McpToolPolicy>;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: AiSdkProvider;
  model?: string;
  effort?: AgentEffortSetting;
  auth?: AgentAuthMode;
  /** New key; omit to keep the stored one, null to clear it. */
  apiKey?: string | null;
  connections?: AgentConnectionsSetting;
  /** Replace the per-connection tool policies (null clears them). */
  toolPolicies?: Record<string, McpToolPolicy> | null;
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

  create(input: CreateAgentInput): AgentConfig {
    const stored: StoredAgent = {
      id: randomUUID(),
      name: input.name?.trim() || HARNESS_LABELS[input.harness],
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
      ...(input.connections ? { connections: input.connections } : {}),
      ...(input.toolPolicies ? { toolPolicies: input.toolPolicies } : {}),
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
    if (patch.connections !== undefined) stored.connections = patch.connections;
    if (patch.toolPolicies !== undefined) {
      stored.toolPolicies = patch.toolPolicies ?? undefined;
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

export function toPublicAgent(agent: AgentConfig): PublicAgentConfig {
  const { apiKey, ...rest } = agent;
  return {
    ...rest,
    hasApiKey: apiKey !== null,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}` : null,
    accepts: agentAccepts(agent),
    connections: agent.connections ?? { mode: "all" },
    toolPolicies: agent.toolPolicies ?? {},
  };
}
