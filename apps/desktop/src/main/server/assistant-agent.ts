import type { AgentDelegationPolicy } from "@catamorphic/core";
import type { ExtraTool } from "@catamorphic/sandbox";

/** The route to the person's own agent: where work goes by default. */
export const ASSISTANT_WORK_ROUTE = "work";
/** The route to an agent the person names. */
export const ASSISTANT_NAMED_ROUTE = "named";

/**
 * Sessions the assistant starts run on its base agent, or on any agent
 * the person names.
 */
export function assistantDelegation(
  baseAgentId: string,
): AgentDelegationPolicy {
  return {
    enabled: true,
    maxConcurrentChildren: 10,
    routes: [
      {
        id: ASSISTANT_WORK_ROUTE,
        target: baseAgentId,
        allowFurtherDelegation: true,
      },
      { id: ASSISTANT_NAMED_ROUTE, target: "*", allowFurtherDelegation: true },
    ],
  };
}

/**
 * Work's own session tools reach this project's sessions only; the
 * assistant's reach the person's chats in every project, and its sessions
 * report back through it. One set of each, so the assistant has its own.
 */
const REPLACED = new Set([
  "spawn_subsession",
  "wait_for_subsessions",
  "interrupt_subsession",
  "list_project_sessions",
  "read_project_session",
  "send_project_session_message",
]);

/** The base agent's tools, with the assistant's session tools. */
export function assistantHostTools(
  workspace: readonly ExtraTool[],
  sessions: readonly ExtraTool[],
): ExtraTool[] {
  return [...workspace.filter((tool) => !REPLACED.has(tool.name)), ...sessions];
}
