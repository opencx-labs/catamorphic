import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HostToolDescriptor,
  type HostToolResult,
  type McpServerSpec,
  NO_CAPABILITIES,
} from "@catamorphic/agent-protocol/runner";
import { renderUserMessage } from "@catamorphic/sandbox";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * What an Agent Client Protocol agent offers through the protocol itself.
 * Its session lives with the agent (`session/load` reopens it where it was
 * made), so a chat moved elsewhere starts fresh with a handoff.
 */
export const ACP_CAPABILITIES: HarnessCapabilities = {
  ...NO_CAPABILITIES,
  interrupt: true,
  approvals: true,
  streamsText: true,
  streamsReasoning: true,
  ids: { thread: "strong", turn: "none", item: "weak" },
};

/** How long an agent gets to exit after its turn before it is killed. */
const EXIT_GRACE_MS = 3_000;
/** How long an interrupted agent gets to end its turn before it is killed. */
const CANCEL_GRACE_MS = 10_000;

/**
 * The ACP harness adapter (ADR 0050, 0241): runs one agent process per
 * attempt from `options.command` (`["hermes", "acp"]`) in the workspace,
 * speaks ACP over its stdio, and serves Work's host tools to it as a
 * loopback MCP server. The agent uses its own configuration and sign-in.
 */
export function createAcpAdapter(input: { id?: string } = {}): HarnessAdapter {
  return {
    id: input.id ?? "acp",
    capabilities: () => ACP_CAPABILITIES,
    start: (attempt, host) => startAttempt(attempt, host),
  };
}

function startAttempt(
  attempt: AttemptStart,
  host: AttemptHost,
): AttemptControl {
  const command = Array.isArray(attempt.options.command)
    ? attempt.options.command.filter(
        (part): part is string => typeof part === "string",
      )
    : [];
  let child: ChildProcess | undefined;
  let tools: Server | undefined;
  let connection: acp.ClientSideConnection | undefined;
  let sessionId: string | undefined;
  let interrupted = false;
  /** Permission requests still waiting on their person. */
  const asks = new Set<AbortController>();
  const stderr: string[] = [];
  const items = new ItemStream(host);

  const run = async () => {
    const [executable, ...args] = command;
    if (!executable)
      throw new Error(
        'This ACP agent names no command. Set "acp": { "command": [...] } in its definition.',
      );
    const spawned = spawn(executable, args, {
      cwd: attempt.workingDirectory,
      env: { ...process.env, ...attempt.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = spawned;
    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => {
      stderr.push(...chunk.split("\n").filter((line) => line.trim()));
      stderr.splice(0, Math.max(0, stderr.length - 20));
    });
    // Ends the attempt when the agent goes away mid-request.
    const exited = new Promise<never>((_, reject) => {
      spawned.once("error", (error) =>
        reject(
          new Error(
            `Couldn't start ${path.basename(executable)}: ${error.message}. Install it or fix the agent's command.`,
          ),
        ),
      );
      spawned.once("exit", (code, signal) =>
        reject(
          new Error(
            `${path.basename(executable)} exited (${signal ?? `code ${code}`}) during the turn.${stderr.length ? `\n${stderr.slice(-5).join("\n")}` : ""}`,
          ),
        ),
      );
    });
    exited.catch(() => {});
    const until = <T>(promise: Promise<T>) => Promise.race([promise, exited]);

    const hostServers = attempt.hostTools.length
      ? await serveHostTools({
          tools: attempt.hostTools,
          call: (call) => callHostTool({ attempt, host, ...call }),
        })
      : undefined;
    tools = hostServers?.server;
    const mcpServers = [
      ...Object.entries(attempt.mcpServers).map(([name, spec]) =>
        acpMcpServer(name, spec),
      ),
      ...(hostServers?.servers ?? []),
    ];

    let agentName = path.basename(executable);
    connection = new acp.ClientSideConnection(
      () => ({
        sessionUpdate: ({ update }) => items.update(update),
        requestPermission: async ({ toolCall, options }) => {
          const withdrawn = new AbortController();
          asks.add(withdrawn);
          const action = toolCall.title ?? "Run a tool";
          try {
            const response = await host.request(
              `permission:${toolCall.toolCallId}:${randomBytes(4).toString("hex")}`,
              {
                kind: "approval",
                blocking: true,
                title: action,
                origin: {
                  kind: "provider",
                  id: agentName,
                  displayName: agentName,
                },
                approval: {
                  action,
                  // What the agent says it is doing ("rm -rf build").
                  ...(toolCall.title ? { details: toolCall.title } : {}),
                  tool: {
                    server: null,
                    name: toolCall.name ?? toolCall.kind ?? "tool",
                    input: toJson(toolCall.rawInput),
                  },
                },
              },
              { signal: withdrawn.signal },
            );
            const kinds: acp.PermissionOptionKind[] =
              response.kind !== "approval" || response.decision === "denied"
                ? ["reject_once", "reject_always"]
                : response.remember === "always"
                  ? ["allow_always", "allow_once"]
                  : ["allow_once", "allow_always"];
            const option = kinds
              .map((kind) =>
                options.find((candidate) => candidate.kind === kind),
              )
              .find((candidate) => candidate !== undefined);
            return {
              outcome: option
                ? { outcome: "selected", optionId: option.optionId }
                : { outcome: "cancelled" },
            };
          } catch {
            // Withdrawn by an interrupt, or ended unanswered.
            return { outcome: { outcome: "cancelled" } };
          } finally {
            asks.delete(withdrawn);
          }
        },
      }),
      acp.ndJsonStream(
        Writable.toWeb(spawned.stdin),
        Readable.toWeb(spawned.stdout),
      ),
    );

    const initialized = await until(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "work", version: "1" },
      }),
    );
    agentName =
      initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? agentName;
    const capabilities = initialized.agentCapabilities;
    const reopen =
      attempt.thread.mode === "resume" || attempt.thread.mode === "restore"
        ? attempt.thread.nativeRef.id
        : undefined;
    if (reopen) {
      if (!capabilities?.loadSession)
        throw new Error(
          `${agentName} can't reopen its earlier session. Start a new chat to keep working with it.`,
        );
      // The agent replays the session's history before answering; the
      // stream ignores it until the turn starts.
      await until(
        connection.loadSession({
          sessionId: reopen,
          cwd: attempt.workingDirectory,
          mcpServers,
        }),
      );
      sessionId = reopen;
    } else {
      sessionId = (
        await until(
          connection.newSession({ cwd: attempt.workingDirectory, mcpServers }),
        )
      ).sessionId;
    }
    host.emit({ type: "thread", ref: { id: sessionId, strength: "strong" } });
    if (interrupted) {
      host.emit({ type: "turn.completed", status: "interrupted" });
      return;
    }
    host.emit({ type: "turn.started" });
    items.live = true;
    const response = await until(
      connection.prompt({
        sessionId,
        prompt: promptBlocks(
          attempt,
          capabilities?.promptCapabilities?.image === true,
        ),
      }),
    );
    const cancelled = interrupted || response.stopReason === "cancelled";
    items.live = false;
    items.closeAll(cancelled ? "cancelled" : "completed");
    host.emit({
      type: "turn.completed",
      status: cancelled ? "interrupted" : "completed",
    });
  };

  const finished = run()
    .catch((error: unknown) => {
      items.live = false;
      items.closeAll(interrupted ? "cancelled" : "failed");
      host.emit({
        type: "turn.completed",
        status: interrupted ? "interrupted" : "failed",
        ...(interrupted
          ? {}
          : {
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            }),
      });
    })
    .finally(async () => {
      tools?.close();
      tools?.closeAllConnections();
      await stop(child);
    });

  return {
    // ponytail: ACP has no steer; core restarts the attempt with the input.
    steer: async () => false,
    interrupt: () => {
      interrupted = true;
      for (const ask of asks) ask.abort();
      if (connection && sessionId)
        void connection.cancel({ sessionId }).catch(() => {});
      else child?.kill();
      // An agent that ignores the cancel is stopped.
      const timer = setTimeout(() => child?.kill(), CANCEL_GRACE_MS);
      void finished.finally(() => clearTimeout(timer));
    },
    finished,
  };
}

/** Ends an agent process, killing it when it ignores the request. */
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.stdin?.end();
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

/**
 * The prompt: Work's instructions on a new session's first turn, the
 * turn's context (ADR 0152), and the person's words, each a block of its
 * own so the context never reads as theirs. Images go along when the agent
 * takes them; otherwise every media attachment is named as not delivered.
 */
function promptBlocks(
  attempt: AttemptStart,
  takesImages: boolean,
): acp.ContentBlock[] {
  const input = attempt.input ?? { itemId: "", text: "", attachments: [] };
  const media = input.attachments.filter((item) => item.kind !== "text");
  const delivered = takesImages && media.every((item) => item.kind === "image");
  const blocks: acp.ContentBlock[] = [];
  const instructions =
    attempt.thread.mode === "fresh" || attempt.thread.mode === "fork"
      ? attempt.systemPrompt.trim()
      : "";
  if (instructions)
    blocks.push({
      type: "text",
      text: `<work-instructions>\n${instructions}\n</work-instructions>`,
    });
  if (attempt.context.trim())
    blocks.push({
      type: "text",
      text: `<work-context>\n${attempt.context.trim()}\n</work-context>`,
    });
  blocks.push({
    type: "text",
    text: renderUserMessage(input.text, input.attachments, {
      omitMedia: !delivered,
    }),
  });
  if (delivered)
    for (const item of media)
      if (item.kind === "image")
        blocks.push({
          type: "image",
          data: item.dataBase64,
          mimeType: item.mediaType,
        });
  return blocks;
}

/** A server the attempt names, as ACP describes MCP servers. */
function acpMcpServer(name: string, spec: McpServerSpec): acp.McpServer {
  if (spec.transport === "stdio")
    return {
      name,
      command: spec.command,
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}).map(([key, value]) => ({
        name: key,
        value,
      })),
    };
  return {
    type: spec.transport,
    name,
    url: spec.url,
    headers: Object.entries(spec.headers ?? {}).map(([key, value]) => ({
      name: key,
      value,
    })),
  };
}

/**
 * A host tool the agent called over MCP (ADR 0198: a host call), decided by
 * the attempt's tool policy first.
 */
async function callHostTool(input: {
  attempt: AttemptStart;
  host: AttemptHost;
  tool: HostToolDescriptor;
  arguments: JsonValue;
}): Promise<CallToolResult> {
  const { tool, host } = input;
  const failure = (text: string): CallToolResult => ({
    content: [{ type: "text", text }],
    isError: true,
  });
  const server = tool.server ?? "workspace";
  if (input.attempt.toolPolicies[server]) {
    const verdict = await host.authorize({
      server,
      tool: tool.name,
      input: input.arguments,
    });
    if (!verdict.allowed) return failure(verdict.message);
  }
  let result: HostToolResult;
  try {
    result = await host.callTool({ name: tool.name, input: input.arguments });
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  const structured = result.structured;
  return {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType },
    ),
    ...(structured &&
    typeof structured === "object" &&
    !Array.isArray(structured)
      ? { structuredContent: structured }
      : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

/**
 * Host tools as loopback MCP servers, one per server key (`workspace`
 * unless a tool names its own), at `/<server>` behind a bearer only this
 * attempt's agent is given. Stateless: every request gets its own server.
 */
async function serveHostTools(input: {
  tools: readonly HostToolDescriptor[];
  call: (call: {
    tool: HostToolDescriptor;
    arguments: JsonValue;
  }) => Promise<CallToolResult>;
}): Promise<{ server: Server; servers: acp.McpServer[] }> {
  const byServer = new Map<string, HostToolDescriptor[]>();
  for (const tool of input.tools) {
    const key = tool.server ?? "workspace";
    byServer.set(key, [...(byServer.get(key) ?? []), tool]);
  }
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    const tools = byServer.get(
      decodeURIComponent((request.url ?? "").split("?")[0]?.slice(1) ?? ""),
    );
    if (request.headers.authorization !== `Bearer ${token}` || !tools) {
      response
        .writeHead(
          request.headers.authorization === `Bearer ${token}` ? 404 : 401,
        )
        .end();
      return;
    }
    const mcp = new McpServer(
      { name: "work", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { ...tool.inputSchema, type: "object" as const },
      })),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = tools.find(
        (candidate) => candidate.name === call.params.name,
      );
      return tool
        ? input.call({ tool, arguments: toJson(call.params.arguments ?? {}) })
        : {
            content: [
              { type: "text", text: `Unknown tool: ${call.params.name}` },
            ],
            isError: true,
          };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    servers: [...byServer.keys()].map((name) => ({
      type: "http" as const,
      name,
      url: `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    })),
  };
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

/**
 * Turns `session/update` notifications into the attempt's items: a run of
 * message or thought chunks is one item, each tool call one item. Nothing
 * is said before the turn starts (a reopened session's replayed history).
 */
class ItemStream {
  live = false;
  private open:
    | { key: string; kind: "assistant_message" | "reasoning" }
    | undefined;
  private readonly tools = new Set<string>();
  private count = 0;

  constructor(private readonly host: AttemptHost) {}

  update(update: acp.SessionUpdate): void {
    if (!this.live) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const kind =
          update.sessionUpdate === "agent_message_chunk"
            ? "assistant_message"
            : "reasoning";
        if (this.open?.kind !== kind) {
          this.closeText();
          const key = `${kind}:${++this.count}`;
          this.open = { key, kind };
          this.host.emit({
            type: "item.started",
            key,
            item:
              kind === "assistant_message"
                ? { kind, text: "", agentId: null }
                : { kind, text: "" },
          });
        }
        this.host.emit({
          type: "item.delta",
          key: this.open.key,
          field: "text",
          text: update.content.text,
        });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        this.closeText();
        const key = `tool:${update.toolCallId}`;
        if (!this.tools.has(key)) {
          this.tools.add(key);
          this.host.emit({
            type: "item.started",
            key,
            ref: { id: update.toolCallId, strength: "weak" },
            item: {
              kind: "tool_call",
              // Agents without a tool name title the call with it
              // (`mcp__workspace__lookup`), which the chat reads.
              tool: update.name ?? update.title ?? update.kind ?? "tool",
              server: null,
              description: update.title ?? null,
              input: toJson(update.rawInput ?? {}),
              result: null,
              error: null,
            },
          });
        } else if (update.title || update.rawInput !== undefined) {
          this.host.emit({
            type: "item.updated",
            key,
            item: {
              ...(update.title ? { description: update.title } : {}),
              ...(update.rawInput !== undefined
                ? { input: toJson(update.rawInput) }
                : {}),
            },
          });
        }
        if (update.status === "completed" || update.status === "failed") {
          this.tools.delete(key);
          const output = toolOutput(update);
          this.host.emit({
            type: "item.completed",
            key,
            status: update.status,
            item:
              update.status === "failed"
                ? {
                    error:
                      typeof output === "string"
                        ? output
                        : JSON.stringify(output),
                  }
                : { result: output },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Ends every open item, as the turn ends. */
  closeAll(status: "completed" | "failed" | "cancelled"): void {
    this.closeText();
    // A call the agent never finished did not run to its end.
    for (const key of this.tools)
      this.host.emit({
        type: "item.completed",
        key,
        status: status === "failed" ? "failed" : "cancelled",
      });
    this.tools.clear();
  }

  private closeText(): void {
    if (!this.open) return;
    this.host.emit({
      type: "item.completed",
      key: this.open.key,
      status: "completed",
    });
    this.open = undefined;
  }
}

/** What a finished tool call said: its raw output, else its text content. */
function toolOutput(update: acp.ToolCallUpdate): JsonValue {
  if (update.rawOutput !== undefined && update.rawOutput !== null)
    return toJson(update.rawOutput);
  const text = (update.content ?? [])
    .flatMap((part) =>
      part.type === "content" && part.content.type === "text"
        ? [part.content.text]
        : [],
    )
    .join("\n");
  return text;
}
