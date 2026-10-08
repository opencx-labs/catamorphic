import type { AgentHarness } from "./desktop-api.js";

const HARNESS_NAMES: Record<AgentHarness, string> = {
  "ai-sdk": "the built-in agent",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Whether a chat can switch to an agent. A chat that has not started is
 * bound to nothing: any agent. Once its conversation has started, it stays
 * on its harness, as T3 Code keeps a started thread on its provider: another
 * agent on the same harness picks up the same native thread (ADR 0198),
 * while one on another harness would continue from a summary of the
 * conversation instead of the conversation, so it waits for a new chat.
 */
export function canSwitchAgent(input: {
  /** The chat has a conversation (a session). */
  started: boolean;
  /** The harness the chat runs on, when known. */
  current: AgentHarness | undefined;
  next: AgentHarness;
}): boolean {
  return !input.started || !input.current || input.current === input.next;
}

/** Why a started chat has no agent to switch to, its harness being the only one. */
export function agentSwitchNone(current: AgentHarness): string {
  return `This chat runs on ${HARNESS_NAMES[current]}, and no other agent does. Start a new chat to use another agent.`;
}

/** The agents a chat can switch to: every other agent the rule allows. */
export function switchableAgents<
  Agent extends { id: string; harness: AgentHarness },
>(input: {
  agents: readonly Agent[];
  currentId: string | undefined;
  started: boolean;
}): Agent[] {
  const current = input.agents.find((agent) => agent.id === input.currentId);
  return input.agents.filter(
    (agent) =>
      agent.id !== input.currentId &&
      canSwitchAgent({
        started: input.started,
        current: current?.harness,
        next: agent.harness,
      }),
  );
}
