import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ImportedItem,
  ImportedItemPayload,
  ImportedTranscript,
  ImportedTurn,
  ItemPayload,
} from "@catamorphic/agent-protocol";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { ClaudeTranscript } from "./transcript.js";

/** A turn whose last line is older than this has ended, whatever it says. */
const SETTLED_AFTER_MS = 10 * 60_000;

const IMPORTED_KINDS: ReadonlySet<string> = new Set([
  "assistant_message",
  "reasoning",
  "tool_call",
  "command",
  "file_change",
  "plan",
  "subagent",
] satisfies ImportedItemPayload["kind"][]);

/**
 * A Claude Code session transcript (`~/.claude/projects/<cwd>/<id>.jsonl`)
 * as a host-neutral transcript (ADR 0233), read as the CLI appends to it:
 * `push` each complete line once, `read` whenever. Its records run through
 * the same translator as Work's own Claude Code turns, so imported items
 * read exactly like them. Each prompt the person typed starts a turn; side
 * chains, meta prompts and compaction summaries are left out.
 */
export class ClaudeCodeTranscriptReader {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private firstAt: string | undefined;
  private lastAt: string | undefined;
  private model: string | null = null;
  private customTitle: string | undefined;
  private aiTitle: string | undefined;
  private readonly turns: ImportedTurn[] = [];
  private building: BuildingTurn | undefined;

  push(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(value)) this.record(value);
  }

  /**
   * The transcript so far, or undefined while it has no session or
   * nothing anyone asked. A last turn the CLI may still be working on
   * reads as open until it says it ended or goes quiet.
   */
  read(input: { now?: Date } = {}): ImportedTranscript | undefined {
    const sessionId = this.sessionId;
    const cwd = this.cwd;
    const firstAt = this.firstAt;
    const lastAt = this.lastAt;
    if (!sessionId || !cwd || !firstAt) return undefined;
    const building = this.building;
    const quiet =
      lastAt !== undefined &&
      (input.now ?? new Date()).getTime() - Date.parse(lastAt) >
        SETTLED_AFTER_MS;
    const turns = building
      ? [
          ...this.turns,
          building.result({
            ended:
              building.ended !== undefined ||
              building.status !== "completed" ||
              quiet,
            at: building.ended ?? lastAt,
          }),
        ]
      : this.turns;
    if (turns.every((turn) => turn.input === null)) return undefined;
    return {
      harness: "claude-code",
      nativeSessionId: sessionId,
      cwd,
      title: this.customTitle ?? this.aiTitle ?? null,
      model: this.model,
      startedAt: firstAt,
      turns,
    };
  }

  private record(record: Record<string, unknown>): void {
    if (isText(record.sessionId)) this.sessionId ??= record.sessionId;
    if (isText(record.cwd)) this.cwd ??= record.cwd;
    if (record.type === "custom-title" && isText(record.customTitle))
      this.customTitle = record.customTitle;
    if (record.type === "ai-title" && isText(record.aiTitle))
      this.aiTitle = record.aiTitle;
    if (record.isSidechain === true) return;
    const at = isText(record.timestamp) ? record.timestamp : this.lastAt;
    const sessionId = this.sessionId;
    if (!at || !sessionId) return;
    this.firstAt ??= at;
    this.lastAt = at;
    const uuid = isText(record.uuid) ? record.uuid : undefined;
    if (record.type === "user") {
      if (record.isMeta === true || record.isCompactSummary === true) return;
      if (!isRecord(record.message)) return;
      const prompt = promptText(record.message.content);
      if (prompt !== undefined) {
        if (prompt.startsWith("[Request interrupted by user")) {
          this.building?.interrupt(at);
          return;
        }
        if (!uuid) return;
        this.endTurn();
        this.building = new BuildingTurn({
          key: uuid,
          input: { key: uuid, text: prompt, at },
          at,
        });
        return;
      }
      const message = userMessage(record, sessionId);
      if (message && this.building) this.building.handle(message, at);
      return;
    }
    if (record.type === "assistant") {
      const message = assistantMessage(record, sessionId);
      if (!message) return;
      // Work the CLI started without a prompt (a resumed task).
      this.building ??= new BuildingTurn({
        key: message.uuid,
        input: null,
        at,
      });
      if (record.isApiErrorMessage === true) {
        this.building.fail(at, messageText(message.message.content));
        return;
      }
      if (message.message.model && message.message.model !== "<synthetic>")
        this.model = message.message.model;
      this.building.handle(message, at);
      if (message.message.stop_reason === "end_turn") this.building.ended = at;
      return;
    }
    if (record.type === "system" && record.subtype === "turn_duration")
      if (this.building) this.building.ended = at;
  }

  /** The person asked something new: the turn before it is over. */
  private endTurn(): void {
    const building = this.building;
    if (!building) return;
    building.close();
    this.turns.push(
      building.result({ ended: true, at: building.ended ?? this.lastAt }),
    );
    this.building = undefined;
  }
}

/** A whole Claude Code transcript at once (see {@link ClaudeCodeTranscriptReader}). */
export function readClaudeCodeTranscript(input: {
  content: string;
  now?: Date;
}): ImportedTranscript | undefined {
  const reader = new ClaudeCodeTranscriptReader();
  for (const line of input.content.split("\n")) reader.push(line);
  return reader.read(input.now ? { now: input.now } : {});
}

/** One turn as its records arrive: the translator's events folded into items. */
class BuildingTurn {
  readonly key: string;
  private readonly input: ImportedTurn["input"];
  private readonly startedAt: string;
  private readonly items = new Map<string, ImportedItem>();
  private readonly translator: ClaudeTranscript;
  private at: string;
  status: ImportedTurn["status"] = "completed";
  private error: string | null = null;
  /** The CLI said the turn ended (a final answer, or its turn record). */
  ended: string | undefined;

  constructor(input: {
    key: string;
    input: ImportedTurn["input"];
    at: string;
  }) {
    this.key = input.key;
    this.input = input.input;
    this.startedAt = input.at;
    this.at = input.at;
    this.translator = new ClaudeTranscript(
      (event) => this.apply(event),
      new Set(),
      [],
    );
  }

  handle(message: SDKAssistantMessage | SDKUserMessage, at: string): void {
    this.at = at;
    this.translator.handle(message);
  }

  interrupt(at: string): void {
    this.status = "interrupted";
    this.ended = at;
  }

  fail(at: string, error: string): void {
    this.status = "failed";
    this.error = error || "Claude Code could not finish this turn.";
    this.ended = at;
  }

  /** End the translator's open items: the turn will hear nothing more. */
  close(): void {
    this.translator.close({ interrupted: this.status === "interrupted" });
  }

  /**
   * The turn as read now. An ended one's unfinished items read as
   * stopped, without closing the translator: a long call's result may
   * still arrive after a quiet spell.
   */
  result(input: { ended: boolean; at: string | undefined }): ImportedTurn {
    const items = [...this.items.values()];
    return {
      key: this.key,
      input: this.input,
      status: this.status,
      error: this.error,
      startedAt: this.startedAt,
      completedAt: input.ended ? (input.at ?? this.at) : null,
      items: input.ended
        ? items.map((item) =>
            item.status === "in_progress"
              ? { ...item, status: "cancelled" }
              : item,
          )
        : items,
    };
  }

  /** Keys are the turn's: a translator's own (a plan's) repeat across turns. */
  private keyOf(key: string): string {
    return `${this.key}/${key}`;
  }

  private apply(event: HarnessEvent): void {
    switch (event.type) {
      case "item.started": {
        const { parentKey, ...payload } = event.item;
        if (!isImportedPayload(payload)) return;
        const key = this.keyOf(event.key);
        this.items.set(key, {
          key,
          ...(parentKey ? { parentKey: this.keyOf(parentKey) } : {}),
          status: event.status ?? "in_progress",
          at: this.at,
          item: payload,
        });
        return;
      }
      case "item.delta": {
        const current = this.items.get(this.keyOf(event.key));
        if (!current) return;
        const field = Reflect.get(current.item, event.field);
        this.update(current, {
          [event.field]: `${typeof field === "string" ? field : ""}${event.text}`,
        });
        return;
      }
      case "item.updated": {
        const current = this.items.get(this.keyOf(event.key));
        if (current) this.update(current, event.item);
        return;
      }
      case "item.completed": {
        const current = this.items.get(this.keyOf(event.key));
        if (!current) return;
        this.update(current, event.item ?? {}, event.status);
        return;
      }
      default:
        return;
    }
  }

  private update(
    current: ImportedItem,
    change: Partial<ItemPayload>,
    status?: ImportedItem["status"],
  ): void {
    const item = { ...current.item, ...change };
    this.items.set(current.key, {
      ...current,
      ...(status ? { status } : {}),
      item: isImportedPayload(item) ? item : current.item,
    });
  }
}

/**
 * What a user record says the person typed: its text, or a slash command
 * as they typed it. Undefined for tool results and the CLI's own output.
 */
function promptText(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) &&
          content.every(
            (block) => isRecord(block) && block.type !== "tool_result",
          )
        ? content
            .map((block) =>
              isRecord(block) && block.type === "text" && isText(block.text)
                ? block.text
                : "",
            )
            .filter(Boolean)
            .join("\n\n")
        : undefined;
  // What the CLI or its host added to the prompt is not what was typed.
  const typed = text
    ?.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  if (!typed) return undefined;
  if (typed.startsWith("<local-command-") || typed.startsWith("<bash-stdout>"))
    return undefined;
  const command = /<command-name>(.*?)<\/command-name>/s.exec(typed)?.[1];
  if (command) {
    const args = /<command-args>(.*?)<\/command-args>/s
      .exec(typed)?.[1]
      ?.trim();
    return args ? `${command} ${args}` : command;
  }
  const bash = /<bash-input>(.*?)<\/bash-input>/s.exec(typed)?.[1];
  if (bash) return `! ${bash}`;
  return typed;
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && isText(block.text)
        ? block.text
        : "",
    )
    .join("\n")
    .trim();
}

/** A transcript's assistant record as the SDK message its translator reads. */
function assistantMessage(
  record: Record<string, unknown>,
  sessionId: string,
): SDKAssistantMessage | undefined {
  const message = record.message;
  const uuid = record.uuid;
  if (!isApiMessage(message) || !isUuid(uuid)) return undefined;
  return {
    type: "assistant",
    message,
    parent_tool_use_id: null,
    uuid,
    session_id: sessionId,
  };
}

/** A transcript's tool-result record as the SDK message its translator reads. */
function userMessage(
  record: Record<string, unknown>,
  sessionId: string,
): SDKUserMessage | undefined {
  const message = record.message;
  if (!isUserParam(message)) return undefined;
  return {
    type: "user",
    message,
    parent_tool_use_id: null,
    tool_use_result: record.toolUseResult,
    session_id: sessionId,
  };
}

function isApiMessage(value: unknown): value is SDKAssistantMessage["message"] {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    typeof value.id === "string" &&
    Array.isArray(value.content) &&
    value.content.every(
      (block) => isRecord(block) && typeof block.type === "string",
    )
  );
}

function isUserParam(value: unknown): value is SDKUserMessage["message"] {
  return (
    isRecord(value) &&
    value.role === "user" &&
    (typeof value.content === "string" || Array.isArray(value.content))
  );
}

function isUuid(value: unknown): value is SDKAssistantMessage["uuid"] {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isImportedPayload(value: {
  kind?: unknown;
}): value is ImportedItemPayload {
  return typeof value.kind === "string" && IMPORTED_KINDS.has(value.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
