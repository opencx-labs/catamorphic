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
 * Its session lives with the agent (`session/load` or `session/resume`
 * reopens it where it was made), so a chat moved elsewhere starts fresh
 * with a handoff.
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

// ponytail: one agent process per attempt, its session reopened (and its
// history replayed) each turn; keep a thread's process warm between
// attempts (ADR 0222's pattern) when start-up or long histories cost too
// much.
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
  /** Conversation updates the agent replayed while reopening its session. */
  let replayed = 0;
  /** Permission requests still waiting on their person. */
  const asks = new Set<AbortController>();
  const stderr: string[] = [];
  const items = new ItemStream(host);

  const run = async (): Promise<"completed" | "cancelled"> => {
    const [executable, ...args] = command;
    if (!executable)
      throw new Error(
        'This ACP agent names no command. Set "acp": { "command": [...] } in its definition.',
      );
    const spawned = spawn(executable, args, {
      cwd: attempt.workingDirectory,
      env: { ...process.env, ...attempt.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so stopping it stops what it started too
      // (the agent behind an `npx` or `sh -c` command, its MCP servers).
      detached: process.platform !== "win32",
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
        acpMcpServer({ name, spec }),
      ),
      ...(hostServers?.servers ?? []),
    ];

    let agentName = path.basename(executable);
    connection = new acp.ClientSideConnection(
      () => ({
        sessionUpdate: ({ update }) => {
          // A reopened session's history, replayed before the turn starts.
          if (!items.live && REPLAYED.has(update.sessionUpdate)) replayed += 1;
          items.update(update);
        },
        requestPermission: async ({ toolCall, options }) => {
          // Asked before the agent read the cancel: nobody is left to answer.
          if (interrupted) return { outcome: { outcome: "cancelled" } };
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
            // A one-time answer never becomes the agent's "always": offered
            // no "once", an approval is a refusal and a refusal is the
            // request cancelled.
            const approved =
              response.kind === "approval" && response.decision === "approved";
            const always =
              response.kind === "approval" && response.remember === "always";
            const kinds: acp.PermissionOptionKind[] = approved
              ? always
                ? ["allow_always", "allow_once"]
                : ["allow_once", "reject_once"]
              : always
                ? ["reject_always", "reject_once"]
                : ["reject_once"];
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
    const earlier =
      attempt.thread.mode === "resume" || attempt.thread.mode === "restore"
        ? attempt.thread.nativeRef.id
        : undefined;
    // The earlier session reopens with `session/load` when the agent
    // offers it, else `session/resume`. Load replays the history first
    // (which the stream ignores until the turn starts), and that replay is
    // the proof the session is there: Work only reports a session once a
    // turn ran on it, while an agent may answer for one it lost without an
    // error (Hermes returns nothing, and its resume opens another session
    // under a new id).
    const reopen = capabilities?.loadSession
      ? "load"
      : capabilities?.sessionCapabilities?.resume
        ? "resume"
        : undefined;
    let reopened = false;
    let refused: string | undefined;
    if (earlier && reopen) {
      const session = {
        sessionId: earlier,
        cwd: attempt.workingDirectory,
        mcpServers,
      };
      let loaded = false;
      try {
        if (reopen === "resume") await until(connection.resumeSession(session));
        else await until(connection.loadSession(session));
        loaded = true;
      } catch (error) {
        // Only the agent's own answer that the session is gone counts: a
        // crash, an interrupt, a sign-in or a passing error ends this turn
        // and leaves the session to the next one.
        if (interrupted || !sessionGone(error)) throw error;
        refused = error.message;
      }
      reopened = loaded && (reopen === "resume" || replayed > 0);
      // A load that replayed nothing: Hermes answers so for a session it
      // lost, and for one it failed to restore. One it still lists is there,
      // so this turn fails and the next tries again.
      if (loaded && !reopened) {
        if (
          capabilities?.sessionCapabilities?.list &&
          (await listsSession({ connection, sessionId: earlier, until }))
        )
          throw new Error(
            `${agentName} couldn't load its earlier session, though it still has it. Send your message again to retry.`,
          );
        refused = "it replayed none of it";
      }
    }
    // The earlier session is gone (refused, or the agent no longer reopens
    // sessions): Work is told, and runs the turn again on a new thread that
    // is handed the conversation (ADR 0245).
    if (earlier && !reopened) {
      const reason = `${agentName} couldn't reopen its earlier session${refused ? ` (${refused})` : ""}.`;
      host.emit({ type: "thread.lost", reason });
      throw new Error(reason);
    }
    const opened =
      reopened && earlier
        ? earlier
        : (
            await until(
              connection.newSession({
                cwd: attempt.workingDirectory,
                mcpServers,
              }),
            )
          ).sessionId;
    sessionId = opened;
    // Work hears of a session once it holds the conversation and can be
    // reopened: a reopened one at once, a new one after its first turn ends
    // (an interrupted one starts afresh, told Work's instructions again),
    // and never one the agent cannot reopen, so that Work hands the agent
    // the whole conversation each turn instead.
    const report = () =>
      host.emit({ type: "thread", ref: { id: opened, strength: "strong" } });
    if (reopened) report();
    if (interrupted) return "cancelled";
    host.emit({ type: "turn.started" });
    items.live = true;
    await until(
      connection.prompt({
        sessionId: opened,
        prompt: promptBlocks({
          attempt,
          takesImages: capabilities?.promptCapabilities?.image === true,
          newSession: !reopened,
        }),
      }),
    );
    // Only Work's interrupt makes the turn interrupted: an agent that ends
    // its own turn as cancelled (a request it was told no to) finished it.
    const outcome = interrupted ? "cancelled" : "completed";
    if (!reopened && reopen && outcome === "completed") report();
    return outcome;
  };

  // The turn ends once the agent's process has, so an agent that saves its
  // session as it exits (Hermes) has saved it before a next attempt, such
  // as the restart a mid-turn message causes, reopens it.
  const finished = run()
    .then(
      (outcome) => ({ outcome, error: undefined }),
      (error: unknown) => ({
        outcome: interrupted ? ("cancelled" as const) : ("failed" as const),
        error,
      }),
    )
    .then(async ({ outcome, error }) => {
      items.live = false;
      items.closeAll(outcome);
      tools?.close();
      tools?.closeAllConnections();
      await stop(child);
      host.emit({
        type: "turn.completed",
        status:
          outcome === "completed"
            ? "completed"
            : outcome === "cancelled"
              ? "interrupted"
              : "failed",
        ...(outcome === "failed"
          ? {
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            }
          : {}),
      });
    });

  return {
    // ponytail: ACP has no steer; core restarts the attempt with the input.
    steer: async () => false,
    interrupt: () => {
      interrupted = true;
      for (const ask of asks) ask.abort();
      if (connection && sessionId)
        void connection.cancel({ sessionId }).catch(() => {});
      else if (child) signal({ child, name: "SIGTERM" });
      // An agent that ignores the cancel, and the stop, is killed.
      const timer = setTimeout(
        () => child && signal({ child, name: "SIGKILL" }),
        CANCEL_GRACE_MS,
      );
      void finished.finally(() => clearTimeout(timer));
    },
    finished,
  };
}

/** Signals the agent and everything it started, its process group. */
function signal(input: { child: ChildProcess; name: NodeJS.Signals }): void {
  const { child, name } = input;
  try {
    if (child.pid !== undefined && process.platform !== "win32")
      process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    // The group is gone: the agent alone, if it is still there.
    child.kill(name);
  }
}

/**
 * Ends an agent process: its input closes so it can exit on its own (Hermes
 * does in under a second, saving its session), then it is asked to stop,
 * then killed.
 */
async function stop(child: ChildProcess | undefined): Promise<void> {
  // A command that never started has no process to end.
  if (
    child?.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.stdin?.end();
  const term = setTimeout(
    () => signal({ child, name: "SIGTERM" }),
    EXIT_GRACE_MS,
  );
  const kill = setTimeout(
    () => signal({ child, name: "SIGKILL" }),
    2 * EXIT_GRACE_MS,
  );
  await exited;
  clearTimeout(term);
  clearTimeout(kill);
}

/**
 * The prompt: Work's instructions on a new session's first turn, the
 * turn's context (ADR 0152), and the person's words, each a block of its
 * own so the context never reads as theirs. Images go along when the agent
 * takes them; otherwise every media attachment is named as not delivered.
 */
function promptBlocks({
  attempt,
  takesImages,
  newSession,
}: {
  attempt: AttemptStart;
  takesImages: boolean;
  newSession: boolean;
}): acp.ContentBlock[] {
  const input = attempt.input ?? { itemId: "", text: "", attachments: [] };
  const media = input.attachments.filter((item) => item.kind !== "text");
  const delivered = takesImages && media.every((item) => item.kind === "image");
  const blocks: acp.ContentBlock[] = [];
  const instructions = newSession ? attempt.systemPrompt.trim() : "";
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
function acpMcpServer({
  name,
  spec,
}: {
  name: string;
  spec: McpServerSpec;
}): acp.McpServer {
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
  // Served at their encoded paths, matched as sent: nothing a request
  // carries is decoded before its bearer is checked.
  const byPath = new Map(
    [...byServer].map(([name, tools]) => [
      `/${encodeURIComponent(name)}`,
      tools,
    ]),
  );
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const tools = byPath.get((request.url ?? "").split("?")[0] ?? "");
    if (!tools) {
      response.writeHead(404).end();
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
    // ponytail: HTTP even when the agent does not advertise it (Hermes takes
    // HTTP MCP servers without saying so); a stdio bridge would serve the
    // agents that cannot.
    servers: [...byServer.keys()].map((name) => ({
      type: "http" as const,
      name,
      url: `http://127.0.0.1:${port}/${encodeURIComponent(name)}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    })),
  };
}

/** The conversation updates an agent replays from a session it reopens. */
const REPLAYED: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
]);

/** How many pages of an agent's sessions to look through for one. */
const LIST_PAGES = 10;

/**
 * Whether the agent lists the session among its own, most recent first by
 * its own order, a page at a time. A failure to list is passing: it throws.
 */
async function listsSession(input: {
  connection: acp.ClientSideConnection;
  sessionId: string;
  until: <T>(promise: Promise<T>) => Promise<T>;
}): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    const { sessions, nextCursor } = await input.until(
      input.connection.listSessions(cursor ? { cursor } : {}),
    );
    if (sessions.some((listed) => listed.sessionId === input.sessionId))
      return true;
    if (!nextCursor) return false;
    cursor = nextCursor;
  }
  return false;
}

/** What a refused reopen answers when the session is gone for good. */
const GONE_CODES: ReadonlySet<number> = new Set([
  acp.RequestError.resourceNotFound().code,
  acp.RequestError.invalidParams().code,
  acp.RequestError.methodNotFound("").code,
]);
/** What it answers when something passing stood in the way. */
const PASSING_CODES: ReadonlySet<number> = new Set([
  acp.RequestError.authRequired().code,
  acp.RequestError.requestCancelled().code,
]);

/**
 * Whether a refused reopen says the session is gone, rather than something
 * passing: not found, a session id the agent does not take, or a method it
 * does not have; never a sign-in or a cancel. An agent that throws a plain
 * error answers "Internal error", its words in the error's data.
 */
function sessionGone(error: unknown): error is acp.RequestError {
  if (!(error instanceof acp.RequestError)) return false;
  if (GONE_CODES.has(error.code)) return true;
  if (PASSING_CODES.has(error.code)) return false;
  return /not found|no such|unknown session|invalid session|does ?n[o']t exist/i.test(
    `${error.message} ${JSON.stringify(error.data ?? null)}`,
  );
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
  /** Calls already finished: a late update for one says nothing new. */
  private readonly done = new Set<string>();
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
        const key = `tool:${update.toolCallId}`;
        if (this.done.has(key)) return;
        this.closeText();
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
          this.done.add(key);
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
