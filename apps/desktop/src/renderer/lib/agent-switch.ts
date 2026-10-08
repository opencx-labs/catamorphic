import type { AgentHarness } from "./desktop-api.js";

/**
 * How a chat switched to another agent carries on (ADR 0198). A chat that
 * has not started is bound to nothing: the agent simply begins it. Once it
 * has, an agent on the same harness continues the same native thread, and
 * one on another harness picks up from a summary of what it missed (a
 * context handoff), as T3 Code switches a started thread's provider.
 */
export function switchContinuity(input: {
  /** The chat has a conversation (a session). */
  started: boolean;
  /** The harness the chat runs on, when known. */
  current: AgentHarness | undefined;
  next: AgentHarness;
}): "native" | "summary" {
  return input.started && input.current && input.current !== input.next
    ? "summary"
    : "native";
}
