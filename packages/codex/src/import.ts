import type {
  ImportedItem,
  ImportedItemPayload,
  ImportedTranscript,
  ImportedTurn,
  JsonValue,
} from "@catamorphic/agent-protocol";
import { CODEX_CLIENT_NAME } from "./app-server.js";

/** A turn whose last record is older than this has ended, whatever it says. */
const SETTLED_AFTER_MS = 10 * 60_000;

/** Longest command output kept on an item: its tail, where results land. */
const OUTPUT_MAX = 4_000;

type JsonRecord = { [key: string]: JsonValue };

/**
 * A Codex thread's rollout (`~/.codex/sessions/…/rollout-*.jsonl`, its
 * segments in order) as a host-neutral transcript (ADR 0233), read as
 * Codex appends to it: `push` each complete line once, `read` whenever.
 * Current Codex records every finished item (`item_completed`); older
 * versions only their messages and calls, read as a fallback. Each
 * message the person sent starts a turn.
 */
export class CodexRolloutReader {
  private session: JsonRecord | undefined;
  private firstAt: string | undefined;
  private model: string | null = null;
  /** This Codex records finished items: its other records are not read. */
  private completedItems = false;
  private lines = 0;
  private readonly builder = new TurnBuilder();

  push(line: string): void {
    const index = this.lines++;
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (isJsonRecord(value)) this.record(value, index);
  }

  /**
   * Whether this rollout is never imported, known from its first line: a
   * subagent's thread (it belongs to its parent) or one Work's own Codex
   * ran. A caller can stop reading it there.
   */
  skipped(): boolean {
    const session = this.session;
    if (!session) return false;
    return (
      (isJsonRecord(session.source) && "subagent" in session.source) ||
      session.originator === CODEX_CLIENT_NAME
    );
  }

  /**
   * The transcript so far. Undefined for a rollout that is never imported
   * (see {@link skipped}) or one nobody asked anything in yet. A last turn
   * Codex may still be working on reads as open until it ends or goes
   * quiet.
   */
  read(input: { now?: Date } = {}): ImportedTranscript | undefined {
    const session = this.session ?? {};
    const threadId = text(session.id);
    const cwd = text(session.cwd);
    if (!threadId || !cwd || this.skipped()) return undefined;
    const lastAt = this.builder.lastAt;
    const quiet =
      lastAt !== undefined &&
      (input.now ?? new Date()).getTime() - Date.parse(lastAt) >
        SETTLED_AFTER_MS;
    const turns = this.builder.read({ settled: quiet });
    if (turns.every((turn) => turn.input === null)) return undefined;
    return {
      harness: "codex",
      nativeSessionId: threadId,
      cwd,
      title: null,
      model: this.model,
      startedAt: text(session.timestamp) ?? this.firstAt ?? "",
      turns,
    };
  }

  private record(record: JsonRecord, index: number): void {
    const at = text(record.timestamp);
    const payload = record.payload;
    if (!at || !isJsonRecord(payload)) return;
    this.firstAt ??= at;
    const builder = this.builder;
    builder.at = at;
    switch (record.type) {
      case "session_meta":
        // A segment or a fork's copied history repeats it: the first is the thread's.
        this.session ??= payload;
        return;
      case "turn_context":
        this.model = text(payload.model) ?? this.model;
        return;
      case "response_item":
        if (!this.completedItems) legacyResponse({ builder, payload });
        return;
      case "event_msg":
        break;
      default:
        return;
    }
    switch (payload.type) {
      case "task_complete":
        builder.end(at);
        return;
      case "turn_aborted":
        builder.interrupt(at);
        return;
      case "error":
        builder.fail(at, text(payload.message) ?? "Codex stopped.");
        return;
      case "item_completed":
        this.completedItems = true;
        if (isJsonRecord(payload.item))
          completedItem({
            builder,
            item: payload.item,
            turnId: text(payload.turn_id),
          });
        return;
    }
    if (!this.completedItems) legacyEvent({ builder, payload, index });
  }
}

/** A whole rollout at once (see {@link CodexRolloutReader}). */
export function readCodexRollout(input: {
  content: string;
  now?: Date;
}): ImportedTranscript | undefined {
  const reader = new CodexRolloutReader();
  for (const line of input.content.split("\n")) reader.push(line);
  return reader.read(input.now ? { now: input.now } : {});
}

/** The turns of a rollout as its records arrive. */
class TurnBuilder {
  at = "";
  /** The last record that said anything: the rollout goes quiet after it. */
  lastAt: string | undefined;
  private readonly turns: ImportedTurn[] = [];
  private current: ImportedTurn | undefined;
  /** Whether the current turn's end was recorded. */
  private ended = false;
  /** The current turn's last record. */
  private currentAt: string | undefined;
  /** Calls waiting for their output (the fallback reading). */
  private readonly calls = new Map<string, ImportedItem>();
  /** Where each item is, by key: a later record of it replaces it there. */
  private readonly positions = new Map<
    string,
    { turn: ImportedTurn; index: number }
  >();
  /** Each Codex turn's turn: a result after it ended still goes there. */
  private readonly byTurnId = new Map<string, ImportedTurn>();

  /** A message the person sent (or, without text, Codex Desktop did): a turn of its own. */
  prompt(input: {
    key: string;
    text: string | null;
    turnId: string | undefined;
  }): void {
    this.close();
    this.open({
      key: input.key,
      input:
        input.text === null
          ? null
          : { key: input.key, text: input.text, at: this.at },
      turnId: input.turnId,
    });
  }

  add(item: ImportedItem, turnId: string | undefined): void {
    const known = this.positions.get(item.key);
    const turn =
      known?.turn ??
      (turnId ? this.byTurnId.get(turnId) : undefined) ??
      this.turnFor({ key: turnId ?? item.key, turnId });
    if (known) turn.items[known.index] = item;
    else {
      this.positions.set(item.key, { turn, index: turn.items.length });
      turn.items.push(item);
    }
    this.lastAt = this.at;
    if (turn === this.current) this.currentAt = this.at;
  }

  /** A call whose output arrives later (the fallback reading). */
  call(item: ImportedItem): void {
    this.calls.set(item.key, item);
    this.add(item, undefined);
  }

  output(input: { key: string; output: string }): void {
    const call = this.calls.get(input.key);
    if (!call) return;
    this.calls.delete(input.key);
    const done: ImportedItem = {
      ...call,
      status: "completed",
      item:
        call.item.kind === "command"
          ? { ...call.item, output: tail(input.output) }
          : call.item.kind === "tool_call"
            ? { ...call.item, result: tail(input.output) }
            : call.item,
    };
    this.add(done, undefined);
  }

  end(at: string): void {
    if (!this.current) return;
    this.ended = true;
    this.current.completedAt = at;
    this.lastAt = at;
    this.currentAt = at;
  }

  interrupt(at: string): void {
    if (!this.current) return;
    this.current.status = "interrupted";
    this.end(at);
  }

  fail(at: string, error: string): void {
    if (!this.current) return;
    this.current.status = "failed";
    this.current.error = error;
    this.end(at);
  }

  /**
   * The turns so far. The current one reads as ended when Codex said so
   * or went quiet, its unfinished calls as stopped, without closing it: a
   * long call's result may still arrive.
   */
  read(input: { settled: boolean }): ImportedTurn[] {
    // A late result may still change a turn read before.
    const turns = this.turns.map((turn) => ({
      ...turn,
      items: [...turn.items],
    }));
    const current = this.current;
    if (!current) return turns;
    if (!this.ended && !input.settled)
      return [...turns, { ...current, items: [...current.items] }];
    return [
      ...turns,
      {
        ...current,
        completedAt: current.completedAt ?? this.currentAt ?? null,
        items: current.items.map(stopped),
      },
    ];
  }

  /** The turn for a record of a turn not seen yet: the current one while it runs. */
  private turnFor(input: {
    key: string;
    turnId: string | undefined;
  }): ImportedTurn {
    const current = this.current;
    if (current && !this.ended) {
      if (input.turnId) this.byTurnId.set(input.turnId, current);
      return current;
    }
    // Work Codex did without a message (a resumed or scheduled turn).
    this.close();
    return this.open({ key: input.key, input: null, turnId: input.turnId });
  }

  private open(input: {
    key: string;
    input: ImportedTurn["input"];
    turnId: string | undefined;
  }): ImportedTurn {
    const turn: ImportedTurn = {
      key: input.key,
      input: input.input,
      status: "completed",
      error: null,
      startedAt: this.at,
      completedAt: null,
      items: [],
    };
    this.current = turn;
    this.ended = false;
    this.currentAt = this.at;
    this.lastAt = this.at;
    if (input.turnId) this.byTurnId.set(input.turnId, turn);
    return turn;
  }

  /** End the current turn at its last record: calls it never finished stop with it. */
  private close(): void {
    const turn = this.current;
    if (!turn) return;
    turn.completedAt ??= this.currentAt ?? this.at;
    turn.items = turn.items.map(stopped);
    this.calls.clear();
    this.turns.push(turn);
    this.current = undefined;
  }
}

function stopped(item: ImportedItem): ImportedItem {
  return item.status === "in_progress"
    ? { ...item, status: "cancelled" }
    : item;
}

/** One `item_completed` record: Codex's own finished item. */
function completedItem(input: {
  builder: TurnBuilder;
  item: JsonRecord;
  turnId: string | undefined;
}): void {
  const { builder, item, turnId } = input;
  const id = text(item.id);
  if (!id) return;
  const at = builder.at;
  const add = (key: string, payload: ImportedItemPayload, failed = false) =>
    builder.add(
      { key, status: failed ? "failed" : "completed", at, item: payload },
      turnId,
    );
  switch (item.type) {
    case "UserMessage": {
      const message = contentText(item.content);
      if (message)
        builder.prompt({ key: id, text: personText(message), turnId });
      return;
    }
    case "AgentMessage": {
      const message = contentText(item.content);
      if (message)
        add(id, { kind: "assistant_message", text: message, agentId: null });
      return;
    }
    case "Reasoning": {
      const summary = Array.isArray(item.summary_text)
        ? item.summary_text.filter(isText).join("\n\n")
        : "";
      if (summary) add(id, { kind: "reasoning", text: summary });
      return;
    }
    case "CommandExecution": {
      const exitCode =
        typeof item.exit_code === "number" ? item.exit_code : null;
      add(
        id,
        {
          kind: "command",
          command: commandLine(item.command),
          description: null,
          output: tail(text(item.aggregated_output) ?? text(item.stdout) ?? ""),
          exitCode,
        },
        item.status === "failed" || (exitCode !== null && exitCode !== 0),
      );
      return;
    }
    case "McpToolCall": {
      const server = text(item.server) ?? "";
      const tool = text(item.tool) ?? "";
      const failed =
        item.status === "failed" ||
        (isJsonRecord(item.result) && item.result.isError === true);
      // A failure's words are its error, not its result.
      const error =
        text(item.error) ??
        (isJsonRecord(item.error) ? text(item.error.message) : undefined) ??
        (failed ? mcpText(item.result) || "The tool failed." : null);
      add(
        id,
        {
          kind: "tool_call",
          tool: `mcp__${server}__${tool}`,
          server: server || null,
          description:
            isJsonRecord(item.arguments) && text(item.arguments.title)
              ? (text(item.arguments.title) ?? null)
              : null,
          input: item.arguments ?? null,
          result: error ? null : mcpResult(item.result),
          error,
        },
        Boolean(error),
      );
      return;
    }
    case "WebSearch": {
      add(id, {
        kind: "tool_call",
        tool: "web_search",
        server: null,
        description: null,
        input: { query: text(item.query) ?? "" },
        result: null,
        error: null,
      });
      return;
    }
    case "FileChange": {
      if (!isJsonRecord(item.changes)) return;
      for (const [path, change] of Object.entries(item.changes)) {
        const kind = isJsonRecord(change) ? change.type : undefined;
        const movedTo = isJsonRecord(change) ? text(change.move_path) : null;
        add(
          `${id}:${path}`,
          {
            kind: "file_change",
            path: movedTo ?? path,
            change: movedTo
              ? "renamed"
              : kind === "add"
                ? "created"
                : kind === "delete"
                  ? "deleted"
                  : "modified",
            previousPath: movedTo ? path : null,
          },
          item.status === "failed",
        );
      }
      return;
    }
    default:
      return;
  }
}

/** An `event_msg` of a Codex that records no finished items. */
function legacyEvent(input: {
  builder: TurnBuilder;
  payload: JsonRecord;
  index: number;
}): void {
  const { builder, payload, index } = input;
  const key = `line:${index}`;
  const at = builder.at;
  switch (payload.type) {
    case "user_message": {
      const message = text(payload.message)?.trim();
      if (message)
        builder.prompt({ key, text: personText(message), turnId: undefined });
      return;
    }
    case "agent_message": {
      const message = text(payload.message);
      if (message)
        builder.add(
          {
            key,
            status: "completed",
            at,
            item: { kind: "assistant_message", text: message, agentId: null },
          },
          undefined,
        );
      return;
    }
    case "agent_reasoning": {
      const reasoning = text(payload.text);
      if (reasoning)
        builder.add(
          {
            key,
            status: "completed",
            at,
            item: { kind: "reasoning", text: reasoning },
          },
          undefined,
        );
      return;
    }
  }
}

/** A `response_item` of a Codex that records no finished items: its calls. */
function legacyResponse(input: {
  builder: TurnBuilder;
  payload: JsonRecord;
}): void {
  const { builder, payload } = input;
  const callId = text(payload.call_id);
  if (!callId) return;
  const at = builder.at;
  switch (payload.type) {
    case "function_call":
    case "custom_tool_call": {
      const name = text(payload.name) ?? "tool";
      const raw =
        payload.type === "function_call" ? payload.arguments : payload.input;
      const args = parseArguments(raw);
      const shell =
        name === "shell" || name === "exec_command" || name === "local_shell";
      builder.call({
        key: callId,
        status: "in_progress",
        at,
        item: shell
          ? {
              kind: "command",
              command: commandLine(
                isJsonRecord(args) ? (args.command ?? args.cmd) : args,
              ),
              description: null,
              output: "",
              exitCode: null,
            }
          : {
              kind: "tool_call",
              tool: name,
              server: null,
              description: null,
              input: args,
              result: null,
              error: null,
            },
      });
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output":
      builder.output({ key: callId, output: outputText(payload.output) });
      return;
  }
}

/** A command as one line: the script of a `shell -lc` call, else its words. */
function commandLine(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const words = value.filter(isText);
  const script = words.length === 3 && words[1] === "-lc" ? words[2] : null;
  return script ?? words.join(" ");
}

function contentText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      isJsonRecord(part) &&
      (part.type === "text" || part.type === "Text") &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("")
    .trim();
}

function outputText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        isJsonRecord(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("\n");
  if (isJsonRecord(value) && typeof value.content === "string")
    return value.content;
  return "";
}

/**
 * An MCP result's text when it has some, else the result as it came with
 * image bytes left out (a screenshot's are hundreds of kilobytes), and
 * without `_meta`: Codex's own notes on the call, a browser tool's
 * screenshot among them.
 */
function mcpResult(value: JsonValue | undefined): JsonValue {
  if (value === undefined) return null;
  const words = mcpText(value);
  if (words) return words;
  if (!isJsonRecord(value)) return value;
  const { _meta, ...result } = value;
  if (!Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((part) =>
      isJsonRecord(part) && part.type === "image"
        ? {
            type: "image",
            ...(text(part.mimeType) ? { mimeType: part.mimeType } : {}),
          }
        : part,
    ),
  };
}

function mcpText(value: JsonValue | undefined): string {
  return tail(outputText(isJsonRecord(value) ? value.content : undefined));
}

/**
 * What the person wrote in a message Codex records as theirs, without
 * what Codex Desktop adds to it (its in-app browser's context, a question
 * reply's wrapper). Null for one Codex Desktop sent by itself: an
 * automation's heartbeat, a background task's notification.
 */
function personText(message: string): string | null {
  if (/^<(heartbeat|task-notification)>/.test(message)) return null;
  const reply =
    /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/.exec(
      message,
    )?.[1];
  if (reply !== undefined) return replyText(reply.trim());
  return (
    message
      .replace(
        /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,
        "",
      )
      .trim() || null
  );
}

/** The person's answers to Codex's questions (a JSON list of them), else the reply as it came. */
function replyText(reply: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return reply || null;
  }
  const answers = Array.isArray(value)
    ? value.flatMap((entry) => {
        const answer = isJsonRecord(entry) ? text(entry.answer) : undefined;
        return answer ? [answer] : [];
      })
    : [];
  return answers.length > 0 ? answers.join("\n\n") : reply || null;
}

function parseArguments(value: JsonValue | undefined): JsonValue {
  if (typeof value !== "string") return value ?? null;
  try {
    const parsed: JsonValue = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function tail(value: string): string {
  const trimmed = value.trimEnd();
  return trimmed.length > OUTPUT_MAX
    ? `…${trimmed.slice(-OUTPUT_MAX)}`
    : trimmed;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isText(value: JsonValue): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
