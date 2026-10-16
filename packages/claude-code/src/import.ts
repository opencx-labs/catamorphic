import type {
  SDKAssistantMessage,
  SDKTaskNotificationMessage,
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
 * read exactly like them. Each prompt the person typed starts a turn, one
 * typed while Claude worked included; what the CLI went back to work on by
 * itself (a background task's notification, a monitor's event) goes on in
 * the turn before it, as in a live Work turn. Side chains, meta prompts and
 * compaction summaries are left out.
 */
export class ClaudeCodeTranscriptReader {
  /** The file's own session (its name), when the caller knows it. */
  private readonly ownId: string | undefined;
  /** The session the records name, the last winning. */
  private sessionId: string | undefined;
  private cwd: string | undefined;
  /** Each session's first record. */
  private readonly firstAt = new Map<string, string>();
  private lastAt: string | undefined;
  private model: string | null = null;
  private customTitle: string | undefined;
  private aiTitle: string | undefined;
  /** Ended turns: a background subagent's notification may still reach one. */
  private readonly turns: BuildingTurn[] = [];
  private building: BuildingTurn | undefined;
  /** The turn each tool call was made in: its result and its task's notification go there. */
  private readonly calls = new Map<string, BuildingTurn>();

  /**
   * `sessionId` is the file's own (its name). A fork's file starts with
   * the records it copied from its original, under the original's id: the
   * session is the file's, started at its first own record, and reads as
   * nothing before one arrives. Without it, the last id named wins.
   */
  constructor(input: { sessionId?: string } = {}) {
    this.ownId = input.sessionId;
  }

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
    const sessionId = this.ownId ?? this.sessionId;
    const startedAt = sessionId ? this.firstAt.get(sessionId) : undefined;
    const cwd = this.cwd;
    const lastAt = this.lastAt;
    if (!sessionId || !cwd || !startedAt || !lastAt) return undefined;
    const building = this.building;
    const quiet =
      (input.now ?? new Date()).getTime() - Date.parse(lastAt) >
      SETTLED_AFTER_MS;
    const ended =
      building !== undefined &&
      (building.ended !== undefined ||
        building.status !== "completed" ||
        quiet);
    const turns = [
      ...this.turns.map((turn) => turn.result({ quiet })),
      ...(building
        ? [
            building.result({
              quiet,
              ...(ended ? { endedAt: building.ended ?? lastAt } : {}),
            }),
          ]
        : []),
    ];
    if (turns.every((turn) => turn.input === null)) return undefined;
    return {
      harness: "claude-code",
      nativeSessionId: sessionId,
      cwd,
      title: this.customTitle ?? this.aiTitle ?? null,
      model: this.model,
      startedAt,
      turns,
    };
  }

  private record(record: Record<string, unknown>): void {
    if (isText(record.sessionId)) this.sessionId = record.sessionId;
    if (isText(record.cwd)) this.cwd ??= record.cwd;
    if (record.type === "custom-title" && isText(record.customTitle))
      this.customTitle = record.customTitle;
    if (record.type === "ai-title" && isText(record.aiTitle))
      this.aiTitle = record.aiTitle;
    if (record.isSidechain === true) return;
    const at = isText(record.timestamp) ? record.timestamp : this.lastAt;
    if (!at) return;
    if (
      isText(record.sessionId) &&
      isText(record.timestamp) &&
      !this.firstAt.has(record.sessionId)
    )
      this.firstAt.set(record.sessionId, record.timestamp);
    this.lastAt = at;
    const uuid = isText(record.uuid) ? record.uuid : undefined;
    const sessionId = this.ownId ?? this.sessionId ?? "";
    switch (record.type) {
      case "user":
        this.user({ record, at, uuid, sessionId });
        return;
      case "attachment":
        this.attachment({ record, at, uuid, sessionId });
        return;
      case "assistant":
        this.assistant({ record, at, sessionId });
        return;
      case "system":
        if (record.subtype === "turn_duration" && this.building)
          this.building.ended = at;
        return;
      default:
        return;
    }
  }

  private user(input: RecordInput): void {
    const { record, at, uuid, sessionId } = input;
    const message = record.message;
    if (record.isCompactSummary === true || !isRecord(message)) return;
    const call = answeredCall(message.content);
    if (call !== undefined) {
      const result = userMessage(record, sessionId);
      if (result) (this.calls.get(call) ?? this.building)?.handle(result, at);
      return;
    }
    const text = contentText(message.content) ?? "";
    if (startedByCli(record, text)) {
      this.notify({ text, uuid, sessionId });
      this.resume();
      return;
    }
    if (record.isMeta === true) return;
    const prompt = promptText(message.content);
    if (prompt === undefined) return;
    if (prompt.startsWith("[Request interrupted by user")) {
      this.building?.interrupt(at);
      return;
    }
    if (uuid) this.ask({ key: uuid, text: prompt, at });
  }

  /**
   * What the CLI attached to a turn while it worked: a message the person
   * sent meanwhile (only ever recorded here), or a task's notification.
   */
  private attachment(input: RecordInput): void {
    const { record, at, uuid, sessionId } = input;
    const attachment = record.attachment;
    if (!isRecord(attachment) || attachment.type !== "queued_command") return;
    const text = contentText(attachment.prompt) ?? "";
    if (attachment.commandMode === "task-notification") {
      this.notify({ text, uuid, sessionId });
      return;
    }
    if (
      attachment.commandMode !== "prompt" ||
      attachment.isMeta === true ||
      startedByCli(attachment, text)
    )
      return;
    const prompt = promptText(attachment.prompt);
    if (prompt !== undefined && uuid) this.ask({ key: uuid, text: prompt, at });
  }

  private assistant(input: Omit<RecordInput, "uuid">): void {
    const { record, at, sessionId } = input;
    const message = assistantMessage(record, sessionId);
    if (!message) return;
    // Work the CLI started without a prompt (a resumed task).
    this.building ??= new BuildingTurn({
      key: message.uuid,
      input: null,
      at,
    });
    const building = this.building;
    if (record.isApiErrorMessage === true) {
      building.fail(at, messageText(message.message.content));
      return;
    }
    if (message.message.model && message.message.model !== "<synthetic>")
      this.model = message.message.model;
    for (const block of message.message.content)
      if (block.type === "tool_use") this.calls.set(block.id, building);
    building.handle(message, at);
    if (message.message.stop_reason === "end_turn") building.ended = at;
  }

  /** The person asked something: the turn before it is over. */
  private ask(input: { key: string; text: string; at: string }): void {
    this.endTurn();
    this.building = new BuildingTurn({
      key: input.key,
      input: { key: input.key, text: input.text, at: input.at },
      at: input.at,
    });
  }

  /**
   * The CLI went back to work by itself: its last turn goes on, as a live
   * Work turn waits for its background work, unless it was cut short;
   * then the work is a turn of its own, without a prompt.
   */
  private resume(): void {
    if (this.building?.status === "completed") this.building.ended = undefined;
    else this.endTurn();
  }

  /** Background tasks' notifications: each ends its subagent, in the turn that started it. */
  private notify(input: {
    text: string;
    uuid: string | undefined;
    sessionId: string;
  }): void {
    const { uuid } = input;
    if (!isUuid(uuid)) return;
    for (const notice of taskNotifications(input.text))
      this.calls
        .get(notice.tool_use_id)
        ?.notify({ ...notice, uuid, session_id: input.sessionId });
  }

  private endTurn(): void {
    const building = this.building;
    if (!building) return;
    building.end();
    this.turns.push(building);
    this.building = undefined;
  }
}

interface RecordInput {
  record: Record<string, unknown>;
  at: string;
  uuid: string | undefined;
  sessionId: string;
}

/** A whole Claude Code transcript at once (see {@link ClaudeCodeTranscriptReader}). */
export function readClaudeCodeTranscript(input: {
  content: string;
  /** The file's own session (see {@link ClaudeCodeTranscriptReader}). */
  sessionId?: string;
  now?: Date;
}): ImportedTranscript | undefined {
  const reader = new ClaudeCodeTranscriptReader(
    input.sessionId ? { sessionId: input.sessionId } : {},
  );
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
  /** Its last record's time. */
  private at: string;
  status: ImportedTurn["status"] = "completed";
  private error: string | null = null;
  /** The CLI said the turn ended (a final answer, or its turn record). */
  ended: string | undefined;
  /** Set once a later turn took over: it ended at its own last record. */
  private completedAt: string | undefined;

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

  /** A background task's notification, as the live SDK sends it: its subagent ends. */
  notify(message: SDKTaskNotificationMessage): void {
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

  /** A later turn took over. */
  end(): void {
    this.completedAt ??= this.ended ?? this.at;
  }

  /**
   * The turn as read now; `endedAt` when it reads as ended before a later
   * turn took over. An ended turn's unfinished calls read as stopped and
   * its plan as done, without closing the translator: a long call's result
   * may still arrive after a quiet spell. A subagent the CLI runs in the
   * background works on past its turn, until its notification or quiet.
   */
  result(input: { quiet: boolean; endedAt?: string }): ImportedTurn {
    const completedAt = this.completedAt ?? input.endedAt ?? null;
    const items = [...this.items.values()];
    return {
      key: this.key,
      input: this.input,
      status: this.status,
      error: this.error,
      startedAt: this.startedAt,
      completedAt,
      items:
        completedAt === null
          ? items
          : items.map((item) => this.settled({ item, quiet: input.quiet })),
    };
  }

  private settled(input: { item: ImportedItem; quiet: boolean }): ImportedItem {
    const { item } = input;
    if (item.status !== "in_progress") return item;
    if (item.item.kind === "plan") return { ...item, status: "completed" };
    if (
      !input.quiet &&
      this.translator.inBackground(item.key.slice(this.key.length + 1))
    )
      return item;
    return { ...item, status: "cancelled" };
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
 * as they typed it. Undefined for the CLI's own output.
 */
function promptText(content: unknown): string | undefined {
  // What the CLI or its host added to the prompt is not what was typed.
  const typed = contentText(content)
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

/** A user message's text: a string, or its text blocks. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && isText(block.text)
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n\n");
}

/** The call a tool-result record answers (its first); undefined for any other user record. */
function answeredCall(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content)
    if (
      isRecord(block) &&
      block.type === "tool_result" &&
      isText(block.tool_use_id)
    )
      return block.tool_use_id;
  return undefined;
}

/** What the CLI writes as the person's words when it goes back to work by itself. */
const CLI_PROMPT =
  /^\s*<(task-notification|ci-monitor-event|cross-session-message)[\s>]/;

/**
 * Whether a user record (or a queued one) is the CLI going back to work
 * by itself rather than the person asking: a background task's
 * notification, a monitor's event, a schedule's or another session's
 * prompt. Current CLIs say who in `origin` or `turnOrigin` (`sdk` is a
 * host's prompt, sent for its person); older ones only in the text.
 */
function startedByCli(record: Record<string, unknown>, text: string): boolean {
  const origin = isRecord(record.origin)
    ? record.origin.kind
    : record.turnOrigin;
  return (
    (typeof origin === "string" && origin !== "human" && origin !== "sdk") ||
    record.promptSource === "system" ||
    CLI_PROMPT.test(text)
  );
}

/**
 * The background tasks' notifications in a CLI prompt, as the system
 * messages the live SDK sends for them. Its words are the task's result
 * when it reported one, else its summary; only a task started by a tool
 * call (a subagent) has an item to end.
 */
function taskNotifications(text: string): (Omit<
  SDKTaskNotificationMessage,
  "uuid" | "session_id"
> & {
  tool_use_id: string;
})[] {
  return [
    ...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g),
  ].flatMap(([, body = ""]) => {
    const field = (tag: string) =>
      new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1]?.trim();
    const toolUseId = field("tool-use-id");
    if (!toolUseId) return [];
    const status = field("status");
    return [
      {
        type: "system",
        subtype: "task_notification",
        task_id: field("task-id") ?? "",
        tool_use_id: toolUseId,
        status:
          status === "completed" || status === "failed" ? status : "stopped",
        output_file: field("output-file") ?? "",
        summary: field("result") ?? field("summary") ?? "",
      },
    ];
  });
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
