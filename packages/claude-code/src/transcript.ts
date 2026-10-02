import type {
  SDKAssistantMessageError,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import type {
  HarnessEvent,
  ItemDraft,
} from "@catamorphic/agent-protocol/runner";
import { reasoningHeading } from "@catamorphic/sandbox";
import { FILE_EDIT_TOOLS, SUBAGENT_TOOLS } from "./options.js";

/** Longest tool output kept on an item: its tail, where results land. */
const OUTPUT_MAX = 4_000;

type ToolKind =
  | "command"
  | "file_change"
  | "subagent"
  | "tool_call"
  | "plan"
  | "question";

interface ToolRecord {
  kind: ToolKind;
  key: string;
  done: boolean;
  /** A subagent the CLI runs in the background: it ends with its task notification. */
  background?: boolean;
}

/** A text or thinking block streamed before its assistant message arrived. */
interface StreamedBlock {
  key: string;
  type: "text" | "thinking";
  index: number;
  text: string;
  /** Its assistant message arrived and completed the item. */
  matched: boolean;
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  const parsed: JsonValue = JSON.parse(JSON.stringify(value));
  return parsed;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value);
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

function stringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A tool_result's text (a string or text blocks), bounded to its tail. */
export function toolResultText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part: unknown) => {
              const value =
                part && typeof part === "object"
                  ? Reflect.get(part, "text")
                  : undefined;
              return typeof value === "string" ? value : "";
            })
            .join("")
        : "";
  const trimmed = text.trimEnd();
  if (!trimmed) return undefined;
  return trimmed.length > OUTPUT_MAX
    ? `…${trimmed.slice(-OUTPUT_MAX)}`
    : trimmed;
}

/**
 * An MCP tool's result as an MCP Apps view reads it: structured content
 * when the server sent it, else its text, else its content blocks with
 * image bytes left out.
 */
export function extractMcpToolResult(response: unknown): JsonValue {
  if (!response || typeof response !== "object") return toJson(response);
  const structured: unknown = Reflect.get(response, "structuredContent");
  if (structured !== undefined) return toJson(structured);
  const content: unknown = Reflect.get(response, "content");
  if (Array.isArray(content)) {
    const text = toolResultText(content);
    if (text) return text;
    return toJson({
      content: content.map((block: unknown) =>
        block &&
        typeof block === "object" &&
        Reflect.get(block, "type") === "image"
          ? { type: "image" }
          : block,
      ),
    });
  }
  return toJson(response);
}

/** `mcp__<server>__<tool>`, split at the first separator after the prefix. */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match?.[1] && match[2]
    ? { server: match[1], tool: match[2] }
    : undefined;
}

/** A subagent tool result that says the CLI went on running it in the background. */
function isBackgroundLaunch(result: unknown): boolean {
  const status =
    result && typeof result === "object"
      ? Reflect.get(result, "status")
      : undefined;
  return status === "async_launched" || status === "remote_launched";
}

/** An MCP call's structured result, as the CLI reports it beside the call. */
function mcpStructured(result: unknown): JsonValue | undefined {
  if (!result || typeof result !== "object") return undefined;
  const structured: unknown = Reflect.get(result, "structuredContent");
  return structured === undefined || structured === null
    ? undefined
    : toJson(structured);
}

function exitCodeOf(input: {
  failed: boolean;
  text: string | undefined;
  result: unknown;
}): number | null {
  const interpretation =
    input.result && typeof input.result === "object"
      ? Reflect.get(input.result, "returnCodeInterpretation")
      : undefined;
  const source = [
    typeof interpretation === "string" ? interpretation : "",
    input.text ?? "",
  ].join("\n");
  const match = /exit code (\d+)/i.exec(source);
  if (match?.[1]) return Number(match[1]);
  return input.failed ? null : 0;
}

/**
 * Claude Code's SDK messages as Work transcript items (ADR 0197). Text and
 * thinking stream into `assistant_message` and `reasoning` items keyed by
 * their API message id and block index; tool uses become command,
 * file change, subagent, plan or tool call items keyed by their tool-use
 * id, and their results complete them. Work inside a native subagent
 * nests under the subagent's item; its own prose stays private to it.
 */
export class ClaudeTranscript {
  private current?: { messageId: string; blocks: Map<number, StreamedBlock> };
  private readonly streamed = new Map<string, StreamedBlock[]>();
  private readonly tools = new Map<string, ToolRecord>();
  private readonly mcpResults = new Map<string, JsonValue>();
  /** Host tool calls the model made and the host has not run yet, FIFO per tool. */
  private readonly pendingHostCalls = new Map<string, string[]>();
  private plan?: { key: string; done: boolean };
  private heading?: string;
  private thinking = "";
  /** The main thread's last assistant message: the turn's native ref. */
  lastAssistantUuid?: string;
  /** Raw usage of the last main-thread assistant message. */
  lastMainUsage?: unknown;
  /** The SDK's tag for an API error the CLI reported. */
  sdkError?: SDKAssistantMessageError;
  /** The text of the CLI's API error message. */
  errorText?: string;
  /** Any tool ran (or was asked to): a failure after this is not a clean rejection. */
  workStarted = false;

  /** Native subagents still working in the background: the turn waits for them. */
  get backgroundAgents(): number {
    let count = 0;
    for (const record of this.tools.values())
      if (record.background && !record.done) count += 1;
    return count;
  }

  constructor(
    private readonly emit: (event: HarnessEvent) => void,
    private readonly hostServers: ReadonlySet<string>,
  ) {}

  handle(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id === null) this.stream(message.event);
        return;
      case "assistant":
        this.assistant(message);
        return;
      case "user":
        this.user(message);
        return;
      case "system":
        this.system(message);
        return;
      default:
        return;
    }
  }

  /** An MCP tool's result from the PostToolUse hook (the call's message carries none). */
  mcpResult(toolUseId: string, result: JsonValue): void {
    const record = this.tools.get(toolUseId);
    if (record?.done && record.kind === "tool_call") {
      this.emit({ type: "item.updated", key: record.key, item: { result } });
      return;
    }
    this.mcpResults.set(toolUseId, result);
  }

  /** The oldest call of a host tool still waiting to run, for the host's record. */
  takeHostCall(server: string, tool: string): string | undefined {
    return this.pendingHostCalls.get(`${server}\u0000${tool}`)?.shift();
  }

  /**
   * End the turn's items: streamed text without its message, calls without
   * a result (an interrupt) and the plan.
   */
  close(input: { interrupted: boolean }): void {
    for (const blocks of this.streamed.values())
      for (const block of blocks) {
        if (block.matched) continue;
        block.matched = true;
        this.emit({
          type: "item.completed",
          key: block.key,
          status: input.interrupted ? "cancelled" : "completed",
          item: { text: block.text },
        });
      }
    for (const record of this.tools.values()) {
      if (record.done) continue;
      record.done = true;
      if (record.kind === "plan" || record.kind === "question") continue;
      this.emit({
        type: "item.completed",
        key: record.key,
        status: "cancelled",
      });
    }
    if (this.plan && !this.plan.done) {
      this.plan.done = true;
      this.emit({
        type: "item.completed",
        key: this.plan.key,
        status: "completed",
      });
    }
  }

  private stream(
    event: Extract<SDKMessage, { type: "stream_event" }>["event"],
  ): void {
    switch (event.type) {
      case "message_start":
        this.current = { messageId: event.message.id, blocks: new Map() };
        return;
      case "content_block_start": {
        const current = this.current;
        const type = event.content_block.type;
        if (!current || (type !== "text" && type !== "thinking")) return;
        const key = `${current.messageId}:${event.index}`;
        const block: StreamedBlock = {
          key,
          type,
          index: event.index,
          text: "",
          matched: false,
        };
        current.blocks.set(event.index, block);
        this.streamed.set(current.messageId, [
          ...(this.streamed.get(current.messageId) ?? []),
          block,
        ]);
        if (type === "thinking") this.thinking = "";
        this.emit({
          type: "item.started",
          key,
          ref: { id: key, strength: "strong" },
          item:
            type === "text"
              ? { kind: "assistant_message", text: "", agentId: null }
              : { kind: "reasoning", text: "" },
        });
        return;
      }
      case "content_block_delta": {
        const block = this.current?.blocks.get(event.index);
        if (!block || block.matched) return;
        const delta = event.delta;
        const text =
          delta.type === "text_delta"
            ? delta.text
            : delta.type === "thinking_delta"
              ? delta.thinking
              : undefined;
        if (!text) return;
        block.text += text;
        this.emit({ type: "item.delta", key: block.key, field: "text", text });
        if (block.type === "thinking") {
          this.thinking += text;
          this.status(this.thinking);
        }
        return;
      }
      default:
        return;
    }
  }

  /** The agent's own heading for what it is thinking about, as its live line. */
  private status(thinking: string): void {
    const heading = reasoningHeading(thinking);
    if (!heading || heading === this.heading) return;
    this.heading = heading;
    this.emit({ type: "status", text: heading });
  }

  /** The streamed block an assistant message's block completes, if any. */
  private claim(
    messageId: string,
    type: "text" | "thinking",
  ): StreamedBlock | undefined {
    const block = (this.streamed.get(messageId) ?? [])
      .filter((candidate) => candidate.type === type && !candidate.matched)
      .sort((a, b) => a.index - b.index)[0];
    if (block) block.matched = true;
    return block;
  }

  private assistant(message: Extract<SDKMessage, { type: "assistant" }>): void {
    const parent = message.parent_tool_use_id;
    const api = message.message;
    if (parent === null) {
      if (message.error) {
        this.sdkError = message.error;
        this.errorText = api.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n")
          .trim();
        return;
      }
      this.lastAssistantUuid = message.uuid;
      this.lastMainUsage = api.usage;
    }
    for (const [index, block] of api.content.entries()) {
      if (block.type === "tool_use") {
        this.toolUse({
          id: block.id,
          name: block.name,
          input: toJsonObject(block.input),
          parent,
        });
        continue;
      }
      // A subagent's own prose is its conversation, not this chat's.
      if (parent !== null) continue;
      if (block.type !== "text" && block.type !== "thinking") continue;
      const text = block.type === "text" ? block.text : block.thinking;
      const streamed = this.claim(api.id, block.type);
      // An interrupt cuts a message short: its text may end mid-word.
      const status = message.aborted ? "cancelled" : "completed";
      if (streamed) {
        this.emit({
          type: "item.completed",
          key: streamed.key,
          status,
          item: { text },
        });
      } else if (text) {
        const key = `${api.id}:${message.uuid}:${index}`;
        this.emit({
          type: "item.started",
          key,
          ref: { id: message.uuid, strength: "strong" },
          ...(status === "completed" ? { status } : {}),
          item:
            block.type === "text"
              ? { kind: "assistant_message", text, agentId: null }
              : { kind: "reasoning", text },
        });
        if (status === "cancelled")
          this.emit({ type: "item.completed", key, status });
      }
      if (block.type === "thinking") this.status(text);
    }
  }

  private toolUse(input: {
    id: string;
    name: string;
    input: JsonObject;
    parent: string | null;
  }): void {
    if (this.tools.has(input.id)) return;
    this.workStarted = true;
    const parentKey =
      input.parent === null ? undefined : this.tools.get(input.parent)?.key;
    const { name } = input;
    const key = input.id;
    if (name === "AskUserQuestion") {
      // Its request is the call's surface; the host shows the question.
      this.tools.set(key, { kind: "question", key, done: false });
      return;
    }
    if (name === "TodoWrite" && input.parent === null) {
      this.tools.set(key, { kind: "plan", key, done: false });
      this.updatePlan(input.input);
      return;
    }
    let item: ItemDraft;
    let kind: ToolKind;
    if (name === "Bash") {
      kind = "command";
      item = {
        kind: "command",
        command: stringField(input.input, "command") ?? "",
        description: stringField(input.input, "description") ?? null,
        output: "",
        exitCode: null,
      };
    } else if (FILE_EDIT_TOOLS.has(name)) {
      kind = "file_change";
      item = {
        kind: "file_change",
        path:
          stringField(input.input, "file_path") ??
          stringField(input.input, "notebook_path") ??
          "",
        change: name === "Write" ? null : "modified",
        previousPath: null,
      };
    } else if (SUBAGENT_TOOLS.has(name)) {
      kind = "subagent";
      item = {
        kind: "subagent",
        title: stringField(input.input, "description") ?? "Subagent",
        agentType: stringField(input.input, "subagent_type") ?? null,
        childSessionId: null,
        result: null,
      };
    } else {
      kind = "tool_call";
      const mcp = parseMcpToolName(name);
      if (mcp && this.hostServers.has(mcp.server)) {
        const pending = `${mcp.server}\u0000${mcp.tool}`;
        this.pendingHostCalls.set(pending, [
          ...(this.pendingHostCalls.get(pending) ?? []),
          key,
        ]);
      }
      item = {
        kind: "tool_call",
        tool: name,
        server: mcp?.server ?? null,
        description: stringField(input.input, "description") ?? null,
        input: input.input,
        result: null,
        error: null,
      };
    }
    this.tools.set(key, { kind, key, done: false });
    this.emit({
      type: "item.started",
      key,
      ref: { id: input.id, strength: "strong" },
      item: parentKey ? { ...item, parentKey } : item,
    });
  }

  /** TodoWrite (when the host does not own todos) is the turn's plan, updated in place. */
  private updatePlan(input: JsonObject): void {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const steps = todos.flatMap((todo) => {
      if (!todo || typeof todo !== "object" || Array.isArray(todo)) return [];
      const text = stringField(todo, "content");
      if (!text) return [];
      const status: "pending" | "in_progress" | "completed" =
        todo.status === "in_progress" || todo.status === "completed"
          ? todo.status
          : "pending";
      return [{ text, status }];
    });
    if (!this.plan) {
      this.plan = { key: `plan:${this.tools.size}`, done: false };
      this.emit({
        type: "item.started",
        key: this.plan.key,
        item: { kind: "plan", steps },
      });
      return;
    }
    this.emit({ type: "item.updated", key: this.plan.key, item: { steps } });
  }

  private user(message: Extract<SDKMessage, { type: "user" }>): void {
    const content = message.message.content;
    if (typeof content === "string") return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const record = this.tools.get(block.tool_use_id);
      if (!record || record.done || record.background) continue;
      if (
        record.kind === "subagent" &&
        isBackgroundLaunch(message.tool_use_result)
      ) {
        // The CLI runs the subagent on: its task notification ends it.
        record.background = true;
        continue;
      }
      record.done = true;
      const failed = block.is_error === true;
      const text = toolResultText(block.content);
      const status = failed ? "failed" : "completed";
      switch (record.kind) {
        case "plan":
        case "question":
          continue;
        case "command":
          this.emit({
            type: "item.completed",
            key: record.key,
            status,
            item: {
              output: text ?? "",
              exitCode: exitCodeOf({
                failed,
                text,
                result: message.tool_use_result,
              }),
            },
          });
          continue;
        case "file_change":
          this.emit({ type: "item.completed", key: record.key, status });
          continue;
        case "subagent":
          this.emit({
            type: "item.completed",
            key: record.key,
            status,
            item: { result: text ?? null },
          });
          continue;
        case "tool_call":
          this.emit({
            type: "item.completed",
            key: record.key,
            status,
            item: {
              // A failure's words are its error, not its result.
              result:
                mcpStructured(message.tool_use_result) ??
                this.mcpResults.get(block.tool_use_id) ??
                (failed ? null : (text ?? null)),
              error: failed ? (text ?? "The tool failed.") : null,
            },
          });
          this.mcpResults.delete(block.tool_use_id);
      }
    }
  }

  private system(message: Extract<SDKMessage, { type: "system" }>): void {
    switch (message.subtype) {
      case "api_retry":
        this.emit({
          type: "diagnostic",
          level: "warn",
          message: `Claude API retry ${message.attempt}/${message.max_retries}: ${String(message.error)}`,
        });
        return;
      case "task_notification": {
        const record = message.tool_use_id
          ? this.tools.get(message.tool_use_id)
          : undefined;
        if (!record?.background || record.done) return;
        record.done = true;
        this.emit({
          type: "item.completed",
          key: record.key,
          status:
            message.status === "completed"
              ? "completed"
              : message.status === "failed"
                ? "failed"
                : "cancelled",
          item: { result: message.summary || null },
        });
        return;
      }
      case "mirror_error":
        this.emit({
          type: "diagnostic",
          level: "error",
          message: `Claude Code could not store part of its transcript with Work: ${message.error}`,
        });
        return;
      default:
        return;
    }
  }
}
