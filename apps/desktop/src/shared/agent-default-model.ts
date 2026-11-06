/**
 * The model an agent's harness runs when neither the chat nor the agent
 * pins one, resolved from the harness itself for a project folder.
 */
export interface AgentDefaultModel {
  /** The id the harness will send (e.g. "claude-sonnet-5"). */
  id: string;
  /** The harness catalog's display name for that id, when it lists one. */
  name?: string;
}

export interface AgentDefaultModelResult {
  /** Null when the harness cannot say which model it would run. */
  model: AgentDefaultModel | null;
  error?: string;
}
