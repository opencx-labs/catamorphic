import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type CodingAgentProvider,
  followProcess,
  type ProviderSession,
  type StartSessionOpts,
} from "@catamorphic/sandbox";

/**
 * A deterministic echo agent (WORK_FAKE_AGENT=1): lets the server
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
    // `execution-location`, `write-file <name> <text>` and `read-file <name>`
    // run in the allocated workspace, so tests can see where and what.
    // Workflow deliveries arrive under a provenance header: act on the last line.
    const request = message.trim().split("\n").at(-1) ?? "";
    const [command, name, ...text] = request.split(" ");
    const workspaceCommand =
      command === "execution-location"
        ? "pwd"
        : command === "write-file" && name
          ? `printf %s '${text.join(" ")}' > '${name}'`
          : command === "read-file" && name
            ? `cat '${name}' 2>/dev/null || printf missing`
            : undefined;
    if (workspaceCommand) {
      const opts = this.sessions.get(session.providerSessionId ?? "");
      if (!opts?.sandboxProvider) throw new Error("Allocated provider missing");
      const result = await opts.sandboxProvider.executeCommand(
        session.sandboxId,
        workspaceCommand,
        { cwd: session.workingDirectory },
      );
      yield { type: "text", content: result.result.trim() };
    } else if (message.startsWith("background-")) {
      // Background processes through the allocated provider (ADR 0174):
      // "background-start", "background-list", "background-stop <id>".
      const opts = this.sessions.get(session.providerSessionId ?? "");
      const processes = opts?.sandboxProvider?.processes;
      if (!processes) throw new Error("Background processes unavailable");
      const sandboxId = session.sandboxId;
      if (message === "background-start") {
        const started = await processes.startProcess({
          sandboxId,
          command: 'echo "ready $$"; exec sleep 600',
          cwd: session.workingDirectory,
          name: "Fake server",
        });
        const ready = await followProcess({
          processes,
          sandboxId,
          processId: started.processId,
          cursor: 0,
          until: /^ready \d+$/,
          timeoutMs: 20_000,
        });
        yield {
          type: "text",
          content: `${started.processId} ${ready.matched?.slice("ready ".length) ?? ""}`,
        };
      } else if (message === "background-list") {
        const listed = await processes.listProcesses({ sandboxId });
        yield {
          type: "text",
          content: JSON.stringify(
            listed.map(({ processId, status }) => ({ processId, status })),
          ),
        };
      } else {
        const processId = message.slice("background-stop ".length);
        await processes.signalProcess({
          sandboxId,
          processId,
          signal: "SIGTERM",
        });
        const ended = await followProcess({
          processes,
          sandboxId,
          processId,
          cursor: 0,
          timeoutMs: 20_000,
        });
        yield { type: "text", content: `${ended.status} ${ended.signal}` };
      }
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
