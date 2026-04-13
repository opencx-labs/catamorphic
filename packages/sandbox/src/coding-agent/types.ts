import type { AgentEvent } from "../types.js";

export interface StartSessionOpts {
  projectId: string;
  userId: string;
  sandboxId: string;
  workingDirectory: string;
  systemPrompt?: string;
}

export interface ProviderSession {
  providerSessionId: string;
  sandboxId: string;
  workingDirectory: string;
}

export interface CodingAgentProvider {
  readonly name: string;

  startSession(opts: StartSessionOpts): Promise<ProviderSession>;

  resumeSession(providerSessionId: string): Promise<ProviderSession>;

  sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent>;

  dispose(session: ProviderSession): Promise<void>;
}
