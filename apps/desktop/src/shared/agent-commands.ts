/** Native commands supplement the shared project, personal, and app skills. */
export interface AgentCommand {
  name: string;
  description: string;
  argumentHint: string;
  /** Codex skills are invoked as skill messages, never as CLI slash text. */
  skillPath?: string;
}

export interface AgentCommandsResult {
  commands: AgentCommand[];
  error?: string;
}
