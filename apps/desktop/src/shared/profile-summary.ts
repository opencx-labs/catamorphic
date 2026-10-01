import type { AgentHarnessKind } from "./agent-permissions.js";

/**
 * What sets a profile apart, shown in its preview card. Main reads it for
 * any profile, and only from stores that need no unlocking.
 */
export interface ProfileSummary {
  /** The profile's default agent, if it has one. */
  agent: {
    name: string;
    harness: AgentHarnessKind;
    provider?: "anthropic" | "openai" | "openrouter";
  } | null;
  /** Connection display names, in the profile's order. */
  connections: string[];
}
