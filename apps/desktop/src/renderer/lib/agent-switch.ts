import { acpHarnessId } from "../../shared/acp-agents.js";

/**
 * Whether picking an agent for a chat starts a new chat with it instead
 * (ADR 0214). A chat's first turn binds it to its agent's harness: until
 * then any agent takes it, and after, only one on that harness does. An
 * agent on another harness would otherwise be handed the conversation and
 * keep it in that harness's own history (the ChatGPT app lists Codex's).
 */
export function startsNewChat(input: {
  /** The harness the chat's first turn bound; null before it starts. */
  bound: string | null;
  /** The harness the picked agent runs on. */
  next: string;
}): boolean {
  return input.bound !== null && input.bound !== input.next;
}

/**
 * The harness a chat on this agent binds: the agent's harness, except an
 * ACP agent's own (ADR 0241), one per agent as the registry names it.
 */
export function agentHarnessId(agent: { id: string; harness: string }): string {
  return agent.harness === "acp" ? acpHarnessId(agent.id) : agent.harness;
}
