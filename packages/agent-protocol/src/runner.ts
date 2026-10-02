/**
 * The agent runner protocol (ADR 0196): how the control plane drives one
 * attempt of a turn on a harness adapter running beside its workspace.
 *
 * The runner writes NDJSON frames, each with a gapless `seq`, and reads
 * NDJSON commands, each with an id it acknowledges once. A sandbox
 * runner's output is addressed by byte cursor, so any replica can read on
 * from where the last one stopped and resend unacknowledged commands; the
 * runner ignores a command id it has already taken.
 */
import type {
  AgentAttachment,
  AgentEffort,
  AgentErrorKind,
  AgentQuestion,
  AgentTurnUsage,
  AttemptReason,
  ItemPayload,
  JsonObject,
  JsonValue,
  NativeRef,
  RefStrength,
  RuntimeRequestResponse,
  TurnError,
} from "./model.js";

/** Bumped on any incompatible change to frames, commands or {@link AttemptStart}. */
export const RUNNER_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Capabilities

/**
 * What a harness can do natively. Core picks the fallback for anything
 * missing by these flags, never by harness name (ADR 0196).
 */
export interface HarnessCapabilities {
  /** Add input to a running turn without restarting it. */
  steer: boolean;
  /** Stop a running turn and keep the thread usable. */
  interrupt: boolean;
  /** Re-run the last turn without a new user message. */
  retry: boolean;
  /** Fork a native thread, optionally through a given turn. */
  fork: boolean;
  /** Drop the last turns from a native thread. */
  rollback: boolean;
  /** Ask the person structured questions and wait for the answer. */
  questions: boolean;
  /** Ask the person to approve a tool call. */
  approvals: boolean;
  /** Pass MCP elicitations through. */
  elicitations: boolean;
  /** Run private subagents whose activity it reports. */
  subagents: boolean;
  /** Stream assistant text as it is written. */
  streamsText: boolean;
  streamsReasoning: boolean;
  /**
   * How the native thread's state can be stored with Work so it resumes
   * anywhere: `store` (entries through host calls), `file` (an append-only
   * file the runner mirrors), `none` (it stays where it was made).
   */
  nativeState: "store" | "file" | "none";
  ids: { thread: RefStrength; turn: RefStrength; item: RefStrength };
}

export const NO_CAPABILITIES: HarnessCapabilities = {
  steer: false,
  interrupt: false,
  retry: false,
  fork: false,
  rollback: false,
  questions: false,
  approvals: false,
  elicitations: false,
  subagents: false,
  streamsText: false,
  streamsReasoning: false,
  nativeState: "none",
  ids: { thread: "none", turn: "none", item: "none" },
};

// ---------------------------------------------------------------------------
// Starting an attempt

/** A tool the host serves; the runner offers it and calls the host to run it. */
export interface HostToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema of the tool's input object. */
  inputSchema: JsonObject;
  /** Server key the tool is offered under (`workspace` unless set). */
  server?: string;
}

/** Per-tool permission rules for one MCP server; see `@catamorphic/sandbox`. */
export interface PolicyLayer {
  default?: "allow" | "ask" | "deny" | "auto";
  tools?: Record<string, "allow" | "ask" | "deny">;
}

export type McpServerSpec =
  | {
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
    }
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/** How the harness reaches its model. */
export type ModelAccess =
  /** Through the gateway with the session's grant, read from `keyFile` (ADR 0180). */
  | {
      kind: "gateway";
      api: "anthropic" | "openai";
      baseUrl: string;
      keyFile: string;
    }
  /**
   * The chat owner's own sign-in on this machine, in the harness's own
   * home (ADR 0197). Work never reads it.
   */
  | { kind: "sign_in"; home: string }
  /** The harness's own configuration on the host (desktop, single-tenant hosts). */
  | { kind: "host" };

/**
 * Which native thread an attempt runs on. `fresh` starts one; `resume`
 * continues the thread where its state already is; `restore` writes its
 * stored state first (a new sandbox or machine) and then resumes.
 */
export type ThreadBinding =
  | { mode: "fresh"; providerThreadId: string }
  | {
      mode: "resume" | "restore";
      providerThreadId: string;
      nativeRef: NativeRef;
      /** For `file` state: where the native file lives, relative to the harness home. */
      statePath?: string;
    }
  | {
      /** Fork the source thread natively, through `throughTurnRef` when set. */
      mode: "fork";
      providerThreadId: string;
      source: NativeRef;
      throughTurnRef?: NativeRef;
      statePath?: string;
    };

export interface AttemptStart {
  protocol: typeof RUNNER_PROTOCOL_VERSION;
  sessionId: string;
  projectId: string;
  turnId: string;
  attemptId: string;
  reason: AttemptReason;
  /** The adapter to run, e.g. `claude-code`, `codex`. */
  harness: string;
  workingDirectory: string;
  /** Directory the runner may use for its own and the harness's state. */
  stateDirectory: string;
  thread: ThreadBinding;
  /**
   * The input. Null for a native retry of the thread's last turn
   * (requires `capabilities.retry`).
   */
  input: {
    itemId: string;
    text: string;
    attachments: AgentAttachment[];
  } | null;
  /** Instructions appended to the harness's own system prompt. */
  systemPrompt: string;
  /** Fresh facts for this turn, already rendered (ADR 0152). */
  context: string;
  model?: string;
  effort?: AgentEffort;
  /** Harness-native permission settings (ADR 0182). */
  permissions: JsonObject;
  modelAccess: ModelAccess;
  /** Tool policy per MCP server key, decided in the runner; only `ask` leaves it. */
  toolPolicies: Record<string, PolicyLayer[]>;
  /** Tool annotations per server, for `auto` policies. */
  toolAnnotations: Record<
    string,
    Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean }>
  >;
  mcpServers: Record<string, McpServerSpec>;
  hostTools: HostToolDescriptor[];
  /** Locally installed plugin directories the harness may load natively. */
  plugins: Array<{ name: string; path: string }>;
  /** Extra environment for the harness process (no credentials unless the host's own). */
  env: Record<string, string>;
  /** Adapter-specific settings the host configured for this agent. */
  options: JsonObject;
}

// ---------------------------------------------------------------------------
// Commands (host → runner)

export type RunnerCommand =
  | { kind: "start"; attempt: AttemptStart }
  | {
      kind: "steer";
      input: { itemId: string; text: string; attachments: AgentAttachment[] };
    }
  | { kind: "interrupt"; reason?: string }
  | { kind: "respond"; requestKey: string; response: RuntimeRequestResponse }
  | {
      kind: "host_result";
      callId: string;
      result?: JsonValue;
      error?: { message: string };
    }
  /** End the runner: interrupt what runs, then exit. */
  | { kind: "stop" };

export interface RunnerCommandFrame {
  id: string;
  command: RunnerCommand;
}

// ---------------------------------------------------------------------------
// Harness events (runner → host, inside `event` frames)

/** An item as an adapter first describes it. `parentKey` nests it under a subagent. */
export type ItemDraft = ItemPayload & { parentKey?: string };

export type HarnessEvent =
  /** The native thread's identity, as soon as the harness knows it. */
  | { type: "thread"; ref: NativeRef; statePath?: string }
  | { type: "turn.started"; ref?: NativeRef }
  | {
      type: "item.started";
      /** Adapter-stable key, unique within the attempt (a native item id). */
      key: string;
      ref?: NativeRef;
      item: ItemDraft;
      /** Already finished when first reported. */
      status?: "in_progress" | "completed" | "failed";
    }
  | { type: "item.delta"; key: string; field: "text" | "output"; text: string }
  | { type: "item.updated"; key: string; item: Partial<ItemPayload> }
  | {
      type: "item.completed";
      key: string;
      status: "completed" | "failed" | "cancelled";
      item?: Partial<ItemPayload>;
    }
  | {
      type: "request.opened";
      key: string;
      request: {
        kind: "question" | "approval" | "elicitation";
        blocking: boolean;
        title: string;
        description?: string;
        origin: {
          kind: "tool" | "provider" | "mcp" | "host";
          id: string;
          displayName?: string;
        };
        questions?: AgentQuestion[];
        approval?: {
          action: string;
          details?: string;
          tool?: { server: string | null; name: string; input: JsonValue };
        };
        elicitation?: {
          server: string;
          message: string;
          schema?: JsonObject;
          url?: string;
        };
      };
    }
  | { type: "request.closed"; key: string; reason: string }
  /** Steered inputs the harness has taken into its context. */
  | { type: "input.consumed"; itemIds: string[] }
  /** The agent's live line ("Reviewing migrations"), never transcript. */
  | { type: "status"; text: string }
  | { type: "title"; text: string }
  | { type: "usage"; usage: AgentTurnUsage }
  | { type: "diagnostic"; level: "info" | "warn" | "error"; message: string }
  | {
      type: "turn.completed";
      status: "completed" | "failed" | "interrupted";
      error?: TurnError;
      /**
       * Where the native thread stood at the end of the turn (Codex's turn
       * id, Claude Code's last message id): a later fork or rollback
       * through this turn names it.
       */
      ref?: NativeRef;
    };

// ---------------------------------------------------------------------------
// Host calls (runner → host, answered by `host_result`)

export type HostCall =
  | { kind: "tool"; name: string; input: JsonValue; itemKey?: string }
  /**
   * Append native state entries (Claude SessionStore, a rollout file's
   * lines). `thread` names the native thread by its native id; absent, the
   * attempt's own. A fork may read its source thread's.
   */
  | {
      kind: "native_state.append";
      thread?: string;
      subpath?: string;
      entries: JsonValue[];
    }
  | { kind: "native_state.load"; thread?: string; subpath?: string }
  | { kind: "native_state.subpaths"; thread?: string };

// ---------------------------------------------------------------------------
// Frames (runner → host)

export type RunnerFrame = { seq: number } & (
  | {
      type: "hello";
      protocol: number;
      runner: { version: string };
      harness: { id: string; capabilities: HarnessCapabilities };
    }
  | { type: "ack"; commandId: string; error?: string }
  | { type: "event"; event: HarnessEvent }
  | { type: "call"; callId: string; call: HostCall }
  | {
      type: "exit";
      /** Present when the attempt ended normally; absent on a crash report. */
      error?: { message: string; kind?: AgentErrorKind };
    }
);

/**
 * Frames start with an ASCII record separator: a sandbox process's output
 * combines stdout and stderr, so anything else on it (a harness's warning,
 * a crash trace) is a diagnostic line, never mistaken for a frame.
 */
export const FRAME_MARK = "\u001e";

/** Encode a frame or command as one marked NDJSON line. */
export function encodeLine(value: RunnerFrame | RunnerCommandFrame): string {
  return `${FRAME_MARK}${JSON.stringify(value)}\n`;
}

/**
 * Split NDJSON into complete lines and the incomplete rest. Bytes after the
 * last newline are a partial line: callers keep them for the next chunk and
 * never advance a persisted cursor past them.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const end = buffer.indexOf("\n", start);
    if (end < 0) break;
    lines.push(buffer.slice(start, end));
    start = end + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/** A line that carries a frame, without its mark; undefined for diagnostics. */
export function framePayload(line: string): string | undefined {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  return trimmed.startsWith(FRAME_MARK) ? trimmed.slice(1) : undefined;
}

export function parseFrame(payload: string): RunnerFrame {
  const value: unknown = JSON.parse(payload);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { seq?: unknown }).seq !== "number" ||
    typeof (value as { type?: unknown }).type !== "string"
  )
    throw new Error("Malformed runner frame");
  return value as RunnerFrame;
}

export function parseCommandFrame(payload: string): RunnerCommandFrame {
  const value: unknown = JSON.parse(payload);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { command?: { kind?: unknown } }).command?.kind !==
      "string"
  )
    throw new Error("Malformed runner command");
  return value as RunnerCommandFrame;
}

// ---------------------------------------------------------------------------
// Harness adapters (implemented by @catamorphic/claude-code, codex, ai-sdk)

/** What a host tool call returned, as MCP content the harness passes on. */
export interface HostToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  /** Structured result, for MCP Apps views and tools that return data. */
  structured?: JsonValue;
  isError?: boolean;
}

export type AuthorizeResult =
  | { allowed: true }
  | { allowed: false; message: string };

/** A request the person answers; resolves with their response. */
export type RequestDraft = Extract<
  HarnessEvent,
  { type: "request.opened" }
>["request"];

/** Raised by {@link AttemptHost.request} when the request ends unanswered. */
export class RequestClosedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RequestClosedError";
  }
}

/**
 * What the runner gives an adapter for one attempt. Every method is safe
 * to call from harness callbacks; events are sequenced in call order.
 */
export interface AttemptHost {
  emit(event: HarnessEvent): void;
  /** Run a tool the host serves (see {@link AttemptStart.hostTools}). */
  callTool(input: {
    name: string;
    input: JsonValue;
    itemKey?: string;
  }): Promise<HostToolResult>;
  /**
   * Decide a tool call by the attempt's policy (ADR 0054): allow and deny
   * answer at once; ask opens an approval and waits for the person.
   */
  authorize(input: {
    server: string;
    tool: string;
    input: JsonValue;
    itemKey?: string;
    /** What the server says about the tool, for `auto` policies. */
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    description?: string;
  }): Promise<AuthorizeResult>;
  /** Open a question, approval or elicitation and wait for its answer. */
  request(key: string, request: RequestDraft): Promise<RuntimeRequestResponse>;
  /** The native thread's state, stored with Work (capabilities.nativeState). */
  nativeState: {
    append(input: {
      thread?: string;
      subpath?: string;
      entries: JsonValue[];
    }): Promise<void>;
    load(input: {
      thread?: string;
      subpath?: string;
    }): Promise<JsonValue[] | null>;
    subpaths(input?: { thread?: string }): Promise<string[]>;
  };
  /** Aborted when the runner stops: end the harness promptly. */
  signal: AbortSignal;
}

export interface AttemptControl {
  /**
   * Add input to the running turn. Resolves false when the harness cannot
   * take it now; the host then restarts the attempt with it.
   */
  steer(input: {
    itemId: string;
    text: string;
    attachments: AgentAttachment[];
  }): Promise<boolean>;
  /** Ask the harness to stop; it still reports `turn.completed`. */
  interrupt(reason?: string): void;
  /** Settles once `turn.completed` was emitted and the harness has let go. */
  finished: Promise<void>;
}

export interface HarnessAdapter {
  readonly id: string;
  capabilities(): HarnessCapabilities;
  /**
   * Start one attempt. The adapter emits `thread` as soon as it knows the
   * native thread, items as they happen, and exactly one `turn.completed`.
   * `local` carries host objects for in-process runners (never serialized).
   */
  start(
    attempt: AttemptStart,
    host: AttemptHost,
    local?: Record<string, unknown>,
  ): AttemptControl;
}
