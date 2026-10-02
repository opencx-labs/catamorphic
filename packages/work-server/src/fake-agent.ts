import { randomUUID } from "node:crypto";
import type { NativeRef } from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  RequestClosedError,
} from "@catamorphic/agent-protocol/runner";
import { EchoAdapter } from "@catamorphic/agent-runner";
import { followProcess, type SandboxProvider } from "@catamorphic/sandbox";
import { z } from "zod";

/** What the fake needs of the session's sandbox (core's `local.sandbox`). */
interface FakeSandbox {
  provider: Pick<SandboxProvider, "executeCommand" | "processes">;
  sandboxId: string;
  workingDirectory: string;
}

/**
 * The deterministic agent of `WORK_FAKE_AGENT=1` (ADR 0197): lets the
 * server boot, invite and chat end to end with no model key, for tests and
 * for trying the server before configuring a provider. It is the
 * `EchoAdapter` (`Echo: <message>`, and its `[[directive]]`s) run on the
 * host, plus commands that act in the chat's workspace so tests see where
 * and what:
 *
 * - `execution-location`, `docker-host`
 * - `write-file <name> <text>`, `read-file <name>`
 * - `run <shell>`: `exit=<code>` then the output (` ;; ` chains steps)
 * - `mcp <alias> <tool> <json>`: one tool of the chat's connection server
 * - `background-start`, `background-list`, `background-stop <id>`
 * - `ask <question>`: asks the person and answers with their answer
 *
 * Workflow deliveries arrive under a provenance header: the last line is
 * the command.
 */
export function createFakeAgentAdapter(): HarnessAdapter {
  const echo = new EchoAdapter();
  return {
    id: echo.id,
    capabilities: () => echo.capabilities(),
    start: (attempt, host, local) => {
      const request = (attempt.input?.text ?? "").trim().split("\n").at(-1);
      if (!request || !isWorkspaceCommand(request))
        return echo.start(attempt, host);
      return startWorkspaceCommand({
        attempt,
        host,
        request,
        sandbox: isFakeSandbox(local?.sandbox) ? local.sandbox : undefined,
      });
    },
  };
}

const COMMANDS = [
  "execution-location",
  "docker-host",
  "write-file",
  "read-file",
  "run",
  "mcp",
  "ask",
  "background-start",
  "background-list",
  "background-stop",
];

function isWorkspaceCommand(request: string): boolean {
  return COMMANDS.includes(request.split(" ")[0] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFakeSandbox(value: unknown): value is FakeSandbox {
  return (
    isRecord(value) &&
    isRecord(value.provider) &&
    typeof value.provider.executeCommand === "function" &&
    typeof value.sandboxId === "string" &&
    typeof value.workingDirectory === "string"
  );
}

function startWorkspaceCommand(input: {
  attempt: AttemptStart;
  host: AttemptHost;
  request: string;
  sandbox: FakeSandbox | undefined;
}): AttemptControl {
  const { attempt, host } = input;
  const stop = new AbortController();
  const ref: NativeRef =
    attempt.thread.mode === "resume"
      ? attempt.thread.nativeRef
      : { id: randomUUID(), strength: "strong" };
  const turnRef: NativeRef = {
    id: `${ref.id}:${attempt.turnId}`,
    strength: "strong",
  };
  const run = async () => {
    host.emit({ type: "thread", ref });
    host.emit({ type: "turn.started", ref: turnRef });
    const reply = await answer({ ...input, signal: stop.signal });
    if (reply === undefined) {
      host.emit({ type: "turn.completed", status: "interrupted" });
      return;
    }
    host.emit({
      type: "item.started",
      key: `reply:${attempt.attemptId}`,
      status: "completed",
      item: { kind: "assistant_message", text: reply, agentId: null },
    });
    host.emit({ type: "turn.completed", status: "completed", ref: turnRef });
  };
  const finished = run().catch((error: unknown) => {
    host.emit({
      type: "turn.completed",
      status: "failed",
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });
  return {
    steer: async () => false,
    interrupt: () => stop.abort(),
    finished,
  };
}

/** The reply to one command, or undefined when it was interrupted. */
async function answer(input: {
  attempt: AttemptStart;
  host: AttemptHost;
  request: string;
  sandbox: FakeSandbox | undefined;
  signal: AbortSignal;
}): Promise<string | undefined> {
  const { request, signal } = input;
  const [command = "", name = "", ...rest] = request.split(" ");
  if (command === "ask") {
    // A question the person answers from any client, on any replica.
    try {
      const response = await input.host.request(
        `ask:${randomUUID()}`,
        {
          kind: "question",
          blocking: true,
          title: "Question",
          origin: { kind: "tool", id: "ask_user", displayName: "Ask User" },
          questions: [
            {
              question: [name, ...rest].join(" "),
              header: "Question",
              multiSelect: false,
              options: [],
            },
          ],
        },
        { signal },
      );
      return response.kind === "question"
        ? `Answered where asked: ${response.answers.join(", ")}`
        : "No answer.";
    } catch (error) {
      if (error instanceof RequestClosedError) return undefined;
      throw error;
    }
  }
  const sandbox = input.sandbox;
  if (!sandbox) throw new Error("Allocated provider missing");
  const exec = (shell: string) =>
    sandbox.provider.executeCommand(sandbox.sandboxId, shell, {
      cwd: sandbox.workingDirectory,
      signal,
    });
  const stopped = new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  if (command === "run" || command === "mcp") {
    // An interrupt ends the turn at once; the step's command is left to
    // finish on its own.
    const results: string[] = [];
    for (const step of request.split(" ;; ")) {
      const result = await Promise.race([
        step.startsWith("mcp ")
          ? callConnectionTool(input.attempt, step.slice("mcp ".length))
          : exec(step.slice("run ".length)).then(
              (done) => `exit=${done.exitCode}\n${done.result.trim()}`,
            ),
        stopped,
      ]);
      if (result === undefined) return undefined;
      results.push(result);
    }
    return results.join("\n---\n");
  }
  const workspaceCommand =
    command === "execution-location"
      ? "pwd"
      : command === "docker-host"
        ? 'echo "$DOCKER_HOST"'
        : command === "write-file" && name
          ? `printf %s '${rest.join(" ")}' > '${name}'`
          : command === "read-file" && name
            ? `cat '${name}' 2>/dev/null || printf missing`
            : undefined;
  if (workspaceCommand) return (await exec(workspaceCommand)).result.trim();
  return background({ sandbox, command, processId: name });
}

/**
 * Background processes through the allocated provider (ADR 0174):
 * `background-start`, `background-list`, `background-stop <id>`.
 */
async function background(input: {
  sandbox: FakeSandbox;
  command: string;
  processId: string;
}): Promise<string> {
  const processes = input.sandbox.provider.processes;
  if (!processes) throw new Error("Background processes unavailable");
  const { sandboxId, workingDirectory } = input.sandbox;
  if (input.command === "background-start") {
    const started = await processes.startProcess({
      sandboxId,
      command: 'echo "ready $$"; exec sleep 600',
      cwd: workingDirectory,
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
    return `${started.processId} ${ready.matched?.slice("ready ".length) ?? ""}`;
  }
  if (input.command === "background-list") {
    const listed = await processes.listProcesses({ sandboxId });
    return JSON.stringify(
      listed.map(({ processId, status }) => ({ processId, status })),
    );
  }
  await processes.signalProcess({
    sandboxId,
    processId: input.processId,
    signal: "SIGTERM",
  });
  const ended = await followProcess({
    processes,
    sandboxId,
    processId: input.processId,
    cursor: 0,
    timeoutMs: 20_000,
  });
  return `${ended.status} ${ended.signal}`;
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
  attempt: AttemptStart,
  step: string,
): Promise<string> {
  const [alias = "", tool = "", ...rest] = step.split(" ");
  const server = attempt.mcpServers[`connection_${alias}`];
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
  const parsed = ToolAnswer.parse(await response.json());
  if (parsed.error) return `error: ${parsed.error.message}`;
  return `${parsed.result?.isError ? "error: " : ""}${JSON.stringify(
    parsed.result?.structuredContent ?? null,
  )}`;
}
