/** The chat whose workspace a new shell opens in, on this computer or its server. */
export interface TerminalChat {
  sessionId: string;
  remote: boolean;
}

export interface TerminalCreateInput {
  projectId?: string;
  cols?: number;
  rows?: number;
  chat?: TerminalChat;
}
