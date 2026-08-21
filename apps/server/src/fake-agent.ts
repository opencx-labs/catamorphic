import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "@catamorphic/sandbox";

/**
 * A deterministic echo agent (CATAMORPHIC_FAKE_AGENT=1): lets the server
 * boot, invite, and chat end to end with no model key — for tests and
 * for kicking the tires before configuring a provider.
 */
export class FakeEchoAgent implements CodingAgentProvider {
  readonly name = "fake-echo";
  private readonly sessions = new Set<string>();

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const providerSessionId = randomUUID();
    this.sessions.add(providerSessionId);
    return {
      providerSessionId,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(
    _session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    yield { type: "text", content: `Echo: ${message}` };
    yield { type: "done" };
  }

  hasSession(providerSessionId: string): boolean {
    return this.sessions.has(providerSessionId);
  }

  async dispose(session: ProviderSession): Promise<void> {
    if (session.providerSessionId) {
      this.sessions.delete(session.providerSessionId);
    }
  }
}
