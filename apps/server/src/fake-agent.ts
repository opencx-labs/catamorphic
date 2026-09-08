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
  private readonly sessions = new Map<string, StartSessionOpts>();

  async startSession(opts: StartSessionOpts): Promise<ProviderSession> {
    const providerSessionId = randomUUID();
    this.sessions.set(providerSessionId, opts);
    return {
      providerSessionId,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      sandboxId: opts.sandboxId,
      workingDirectory: opts.workingDirectory,
    };
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    if (message === "execution-location") {
      const opts = this.sessions.get(session.providerSessionId ?? "");
      if (!opts?.sandboxProvider) throw new Error("Allocated provider missing");
      const result = await opts.sandboxProvider.executeCommand(
        session.sandboxId,
        "pwd",
        { cwd: session.workingDirectory },
      );
      yield { type: "text", content: result.result.trim() };
    } else {
      yield { type: "text", content: `Echo: ${message}` };
    }
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
