import type { AgentEvent } from "../types.js";

/**
 * Lightweight description of a plugin package attached to a project. Passed
 * into {@link CodingAgentProvider.startSession} so the agent can (1) stage
 * the plugin's docs inside the working directory for filesystem discovery,
 * and (2) prepend an "attached packages" preamble to the system prompt.
 *
 * `files` is a map of paths relative to the plugin package root. Only docs
 * (README, `dist/index.d.ts`) are expected — not the full package contents.
 */
export interface AttachedPluginForAgent {
  packageName: string;
  displayName: string;
  description: string;
  files: Record<string, string>;
}

export interface StartSessionOpts {
  projectId: string;
  userId: string;
  sandboxId: string;
  workingDirectory: string;
  systemPrompt?: string;
  attachedPlugins?: AttachedPluginForAgent[];
}

export interface ProviderSession {
  providerSessionId: string;
  sandboxId: string;
  workingDirectory: string;
}

/**
 * Normalized reasoning-effort scale shared by every harness. Each provider
 * maps it onto its native knob (thinking budgets, reasoning effort levels);
 * providers that have no such knob ignore it.
 */
export type AgentEffort = "low" | "medium" | "high";

/** Per-turn overrides; anything unset falls back to the provider's defaults. */
export interface TurnOptions {
  model?: string;
  effort?: AgentEffort;
}

export interface CodingAgentProvider {
  readonly name: string;

  startSession(opts: StartSessionOpts): Promise<ProviderSession>;

  resumeSession(providerSessionId: string): Promise<ProviderSession>;

  sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent>;

  dispose(session: ProviderSession): Promise<void>;
}
