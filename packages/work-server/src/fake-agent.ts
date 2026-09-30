import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type CodingAgentProvider,
  followProcess,
  type ProviderSession,
  type StartSessionOpts,
} from "@catamorphic/sandbox";
import { z } from "zod";

/**
 * A deterministic echo agent (WORK_FAKE_AGENT=1): lets the server
 * boot, invite, and chat end to end with no model key — for tests and
 * for kicking the tires before configuring a provider.
 */
export class FakeEchoAgent implements CodingAgentProvider {
  readonly name = "fake-echo";
  /** Replica memory (a): the sessions this process's turns started. */
  private readonly sessions = new Map<string, StartSessionOpts>();
  /**
   * Replica memory (a): stops for the `run` turns in flight here, by
   * provider session id and by chat id.
   */
  private readonly running = new Map<string, () => void>();
  /** Replica memory (a): sessions whose `ask` question waits here. */
  private readonly asked = new Set<string>();

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

  interrupt(providerSessionId: string): void {
    this.running.get(providerSessionId)?.();
  }

  holdsQuestion(providerSessionId: string): boolean {
    return this.asked.has(providerSessionId);
  }

  releaseQuestion(providerSessionId: string): void {
    this.asked.delete(providerSessionId);
  }

  async *sendMessage(
    session: ProviderSession,
    message: string,
  ): AsyncIterable<AgentEvent> {
    // `execution-location`, `docker-host`, `write-file <name> <text>` and
    // `read-file <name>`
    // run in the allocated workspace, so tests can see where and what.
    // Workflow deliveries arrive under a provenance header: act on the last line.
    const request = message.trim().split("\n").at(-1) ?? "";
    const [command, name, ...text] = request.split(" ");
    const providerSessionId = session.providerSessionId ?? "";
    if (this.asked.delete(providerSessionId)) {
      // The answer to `ask`, in the process that asked.
      yield { type: "text", content: `Answered where asked: ${request}` };
      yield { type: "done" };
      return;
    }
    if (command === "ask") {
      // `ask <question>`: a question this process holds until answered, as
      // Claude Code's AskUserQuestion does (ADR 0193).
      this.asked.add(providerSessionId);
      yield {
        type: "question",
        questions: [
          {
            question: [name, ...text].join(" "),
            header: "Question",
            multiSelect: false,
            options: [],
          },
        ],
      };
      yield { type: "done" };
      return;
    }
    if (command === "run" || command === "mcp") {
      // `run <shell>`: any command in the workspace, answering `exit=<code>`
      // then its output (tests of sandbox Git, ADR 0175). `mcp <alias>
      // <tool> <json>`: a tool of the session's connection MCP server, as a
      // harness calls it with its grant. ` ;; ` chains steps in one turn.
      // An interrupt ends the turn at once; the step's command is left to
      // finish on its own.
      const opts = this.sessions.get(providerSessionId);
      let stop = () => {};
      const stopped = new Promise<"stopped">((resolve) => {
        stop = () => resolve("stopped");
      });
      const ids = [providerSessionId, session.sessionId];
      for (const id of ids) this.running.set(id, stop);
      try {
        const results: string[] = [];
        for (const step of request.split(" ;; ")) {
          const result = await Promise.race([
            step.startsWith("mcp ")
              ? callConnectionTool(opts, step.slice("mcp ".length))
              : runInWorkspace(opts, session, step.slice("run ".length)),
            stopped,
          ]);
          if (result === "stopped") {
            yield { type: "error", content: "Interrupted." };
            yield { type: "done" };
            return;
          }
          results.push(result);
        }
        yield { type: "text", content: results.join("\n---\n") };
        yield { type: "done" };
        return;
      } finally {
        for (const id of ids)
          if (this.running.get(id) === stop) this.running.delete(id);
      }
    }
    const workspaceCommand =
      command === "execution-location"
        ? "pwd"
        : command === "docker-host"
          ? 'echo "$DOCKER_HOST"'
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
      this.asked.delete(session.providerSessionId);
    }
  }
}

async function runInWorkspace(
  opts: StartSessionOpts | undefined,
  session: ProviderSession,
  command: string,
): Promise<string> {
  if (!opts?.sandboxProvider) throw new Error("Allocated provider missing");
  const result = await opts.sandboxProvider.executeCommand(
    session.sandboxId,
    command,
    { cwd: session.workingDirectory },
  );
  return `exit=${result.exitCode}\n${result.result.trim()}`;
}

const ToolAnswer = z.object({
  result: z
    .object({
      structuredContent: z.unknown().optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

/** `<alias> <tool> <json>`: one `tools/call` on the alias's MCP server. */
async function callConnectionTool(
  opts: StartSessionOpts | undefined,
  step: string,
): Promise<string> {
  const [alias = "", tool = "", ...rest] = step.split(" ");
  const server = opts?.mcpServers?.[`connection_${alias}`];
  if (!server || server.transport === "stdio")
    return `no connection '${alias}' in this session`;
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: JSON.parse(rest.join(" ") || "{}") },
    }),
  });
  const answer = ToolAnswer.parse(await response.json());
  if (answer.error) return `error: ${answer.error.message}`;
  return `${answer.result?.isError ? "error: " : ""}${JSON.stringify(
    answer.result?.structuredContent ?? null,
  )}`;
}
