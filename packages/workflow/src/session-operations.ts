import type { JsonValue } from "./json.js";
import type { TransitionCall } from "./workflow.js";

/**
 * Where a chat stands (ADR 0344): `working` while a turn runs or waits to
 * run, `needs_input` while its agent waits on an answer, `failed` when its
 * latest turn failed, `closed` at the end of its life, `idle` otherwise.
 */
export type SessionStateName =
  | "working"
  | "needs_input"
  | "idle"
  | "failed"
  | "closed";

/** What an agent asks and still waits on. */
export interface SessionRequest {
  requestId: string;
  kind: "question" | "approval" | "elicitation";
  title: string;
  description: string | null;
  /** Whether the agent waits on the answer. */
  blocking: boolean;
  turnId: string | null;
  questions: Array<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: Array<{ label: string; description: string }>;
  }> | null;
  approval: {
    action: string;
    details?: string;
    tool?: { server: string | null; name: string; input: JsonValue };
  } | null;
  elicitation: {
    server: string;
    message: string;
    schema?: Record<string, JsonValue>;
    url?: string;
  } | null;
  expiresAt: string | null;
}

/**
 * One chat as every surface reads it (ADR 0344): what every session
 * operation answers with, over REST, MCP, in-product tools and here.
 */
export interface SessionState {
  sessionId: string;
  projectId: string;
  title: string | null;
  /** The agent's id (`project:<projectId>:<slug>` for a project agent). */
  agent: string | null;
  /**
   * The Environment the chat runs in, recorded when it starts: before a
   * machine is placed (a chat waiting for one has no `placement` yet).
   */
  environment: string | null;
  state: SessionStateName;
  /** The chat's log position: pass it to `wait` to hear only what follows. */
  cursor: string;
  /**
   * The turn working now and its progress (ADR 0333); null when no turn
   * works. `progressAt` is when its attempt last made progress (a frame
   * from its harness other than a log line, or a model request);
   * `stalledAt` is set while a silence longer than `stallMinutes` lasts.
   */
  turn: SessionTurnProgress | null;
  /**
   * The chat's turns waiting to run, oldest first (ADR 0337): with `turn`,
   * what tells a turn still to come from one that settled or was withdrawn.
   */
  queued: string[];
  /** What the agent asks and still waits on. */
  requests: SessionRequest[];
  /** The latest turn's last assistant text once it settled, else null. */
  reply: string | null;
  /**
   * The latest accepted result of each name (ADR 0323), or with
   * `include: ["results"]` every result the read's filters keep.
   */
  results: SessionResult[];
  pullRequests: Array<{
    url: string;
    number?: number;
    title?: string;
    state?: "open" | "draft" | "merged" | "closed";
  }>;
  /** Why the latest turn failed. */
  error: { kind: string | null; message: string } | null;
  /** Why its work has not started: it waits for a machine (ADR 0258). */
  waiting: {
    reason: "capacity" | "unavailable";
    message: string;
    environment: string;
    since: string;
    expiresAt: string | null;
  } | null;
  attentionRequired: boolean;
  /** The project's key for this chat (`pr-42`), or null. */
  key: string | null;
  /** A project chat runs as the project; a member's chat as that member. */
  owner: "project" | "member";
  /** Workflows that delivered to this chat by its key. */
  keyWorkflows: string[];
  /** Where the chat runs and why; null before a machine is placed. */
  placement: {
    environment: string;
    reason: string;
    machine: { id: string; label: string };
  } | null;
  /**
   * The base the chat's workspace stands on (ADR 0178): the ref of the
   * project's remote it started at or last moved to, and that ref's commit
   * then. Null for a chat started from the project itself.
   */
  workspace: { ref: string; commit: string } | null;
  parentSessionId: string | null;
  workStatus: "open" | "completed";
  /** ISO timestamps: when the conversation started and last changed. */
  createdAt: string;
  updatedAt: string;
  /** Where a person opens the chat, when the host has a public address. */
  url?: string;
  /**
   * Named values on the chat (ADR 0226), with `include: ["metadata"]`: set
   * by agents, people and workflows. Keys a workflow owns carry its purpose
   * (`review.verdicts`).
   */
  metadata?: Record<string, JsonValue>;
  /** With `include: ["transcript"]`: the conversation, oldest first. */
  transcript?: SessionTranscriptMessage[];
  /** With `include: ["usage"]`: model usage through the gateway. */
  usage?: SessionUsage;
  /** With `include: ["attempts"]` and `turnId`: that turn's attempts. */
  attempts?: SessionTurnAttempt[];
}
/** A working turn's progress (ADR 0333). */
export interface SessionTurnProgress {
  id: string;
  status: "preparing" | "running" | "waiting" | "finalizing";
  /** The line the chat shows while it works. */
  activity: string | null;
  progressAt: string | null;
  stalledAt: string | null;
  ordinal?: number;
  attempt?: {
    id: string;
    ordinal: number;
    /** `initial`, `retry`, `steer_restart`, `recovery` or `restart`. */
    reason: string;
    startedAt: string | null;
  } | null;
  /** Attempts so far, this one included. */
  attempts?: number;
  /** Attempts that ran because someone restarted the one before. */
  restarts?: number;
  /** The agent's stall threshold; null when it sets none. */
  stallMinutes?: number | null;
  /** The tool calls and commands the attempt reported still running. */
  running?: {
    tools: Array<{ name: string; description: string | null; since: string }>;
    commands: Array<{
      command: string;
      description: string | null;
      since: string;
    }>;
  };
}
/** One attempt of a turn, as `read` returns it with `include: ["attempts"]` (ADR 0333). */
export interface SessionTurnAttempt {
  id: string;
  ordinal: number;
  reason: string;
  /** `running`, `completed`, `failed`, `interrupted`, `lost`, `superseded` or `restarted`. */
  status: string;
  error: { message: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  progressAt: string | null;
  stalledAt: string | null;
  /**
   * The last 16 000 characters of the runner's own output that was not a
   * frame and of the harness's own log, masked by the chat's secret values.
   * Null once the attempt completed, or when there was none.
   */
  diagnostics: { runner: string; harness: string } | null;
}
/**
 * Where a chat's workspace starts (ADR 0178): a branch, tag, commit, or
 * full ref (`refs/pull/42/head`) of the project's linked remote, fetched by
 * the host with the remote's own credentials. Delivered again to an open
 * chat, it moves the workspace before the next turn: `rebase` (default)
 * replays the agent's commits onto the new base, `reset` discards them. The
 * agent is told the old and new heads and what changed.
 */
interface WorkspaceRef {
  ref: string;
  update?: "reset" | "rebase";
}
/** One transcript message, as `read` returns it with `include: ["transcript"]`. */
export interface SessionTranscriptMessage {
  id: string;
  role: "user" | "inbound" | "notification" | "assistant" | "system";
  content: string;
  turnId: string | null;
  status: string;
  /** ISO timestamp of the message. */
  createdAt: string;
  author: Record<string, JsonValue> | null;
}
/**
 * A value an agent submitted with `submit_result` and its schema accepted
 * (ADR 0323). Results are never rewritten; `current` says whether it still
 * answers its chat's newest input.
 */
export interface SessionResult {
  id: string;
  /** The name its agent's definition declares, e.g. `review`. */
  name: string;
  /** Null when `truncated`: read it whole with `include: ["results"]`. */
  value: unknown;
  turnId: string | null;
  /**
   * No new request reached the chat after the input it answers: nothing a
   * person, a workflow or a session outside the chat's own subsessions
   * sent. Task notifications and its subsessions' messages are its own
   * work reporting.
   */
  current: boolean;
  truncated?: boolean;
  /** ISO timestamp. */
  recordedAt: string;
  /** The chat that recorded it: the one named, or one of its subsessions. */
  sessionId: string;
  attemptId: string | null;
  /**
   * The newest input (a message id) the chat had taken in when it was
   * submitted, and its kind, for a reader applying a stricter rule.
   */
  input: {
    itemId: string;
    position: number;
    kind: "user_message" | "inbound_message" | "task_notification";
  } | null;
  /** The workspace commit the submitting turn began on, when there is one. */
  commit: string | null;
}
/** Token totals and the cost providers reported for some model calls. */
export interface ModelUsageTotals {
  /** Settled calls counted here. */
  calls: number;
  /** Uncached input tokens (never includes the cached portion). */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Subset of `outputTokens`. */
  reasoningTokens: number;
  /**
   * What providers said these calls cost, in US dollars, summed; null when
   * none said. Never an estimate.
   */
  costUsd: number | null;
  /** Calls whose provider reported no cost: `costUsd` is a lower bound. */
  unpricedCalls: number;
  /**
   * Calls whose usage could not be read (for example a Chat Completions
   * stream without `stream_options.include_usage`): they count zero tokens,
   * so token totals are a lower bound when this is above zero.
   */
  unmeteredCalls: number;
}
/** A chat's model calls through the gateway, as `read` totals them with `include: ["usage"]`. */
export interface SessionUsage extends ModelUsageTotals {
  sessionId: string;
  /** Whether the totals include every subsession below the chat. */
  family: boolean;
  /** The chats counted. */
  sessions: number;
  /** Calls still streaming, not yet in the totals. */
  openCalls: number;
  /** The same totals per model; `model` is null when unknown. */
  models: Array<ModelUsageTotals & { model: string | null }>;
}
/** The authoritative host has accepted delivery, but has not applied this action yet. */
export interface QueuedSessionAction {
  delivery: "queued";
  messageId: string;
  turnId: null;
  created: boolean;
}
/**
 * Whose keyed chat a key names (ADR 0156). A member's automation reaches
 * only that member's; a project automation reaches the project chat, open
 * to everyone whose role reaches the agent, unless it names a member.
 */
type Audience = "project" | { member: string };
/**
 * A chat by id, or by the project's key for it (ADR 0173): any automation
 * in the project reaches the same open chat for `pr-42`.
 */
type Target = (
  | { sessionId: string; key?: never; audience?: never }
  | { key: string; audience?: Audience; sessionId?: never }
) & { expectedStateRevision?: number };
type DeliverTarget =
  | { sessionId: string; key?: never }
  | {
      key: string;
      sessionId?: never;
      audience?: Audience;
      /** The project agent that answers in a new chat. */
      agentSlug?: string;
      title?: string;
      /**
       * The Environment a new chat runs in. Omitted, the agent's preferred
       * Environment, then the project default; never the workflow's own.
       */
      environment?: string;
    };
type Action = Target & { idempotencyKey: string };
type Call<Input, Output = unknown> = TransitionCall<Input, Output>;
/** How a command `exec` ran ended (ADR 0324). */
export interface SessionExecResult {
  /** Null when it was stopped: its timeout, or its sandbox went away. */
  exitCode: number | null;
  /** The last 16 000 characters of each stream. */
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /**
   * Set when it failed and the disk is to blame (ADR 0336): its machine is
   * short of disk, or its output says a write found no room.
   */
  outOfDisk?: string;
}
/** A message a start or a send delivered. */
interface Sent {
  messageId: string;
  turnId: string | null;
  /** False when an earlier call with the same idempotency key delivered it. */
  created: boolean;
}
/**
 * The session operations (ADR 0344): the same ones REST, the MCP endpoints
 * and in-product agents run, under their workflow names (`session_read` is
 * `read`). Host transitions must be returned from a boundary, never
 * awaited as IO.
 */
export interface SessionHostOperations {
  /**
   * Start a chat with one of the project's agents and give it its first
   * message. It answers at once with state `working`; a later step reads
   * or waits on it, or a `session.turn-changed` trigger takes the result.
   * With `key`, the project's open chat for that key is reused.
   */
  start: Call<
    {
      /** The agent's slug or id. Omitted: the project's default agent. */
      agent?: string;
      message: string;
      environment?: string;
      /** Start the workspace at a ref of the project's remote. */
      ref?: WorkspaceRef;
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      title?: string;
      key?: string;
      audience?: Audience;
      idempotencyKey: string;
    },
    SessionState & { sent?: Sent }
  >;
  /**
   * Send a follow-up message to a chat by id or key. `mode`: `queue`
   * (default) runs after the current turn, `steer` joins it, `interrupt`
   * stops it and runs this next, `message_only` only records it.
   * `deliver` also starts keyed chats, names approvers and alerts the
   * chat's people when the turn settles.
   */
  send: Call<
    Action & {
      message: string;
      mode?: "queue" | "steer" | "interrupt" | "message_only";
      /** Flag this message itself for the person's attention. */
      attention?: "required" | "none";
      ref?: WorkspaceRef;
    },
    SessionState & { sent?: Sent }
  >;
  /**
   * Hold until one of the chats needs its caller (its state is no longer
   * `working`) or `timeoutSeconds` pass (default 25, at most 50):
   * `changed: false` means nothing happened yet. A workflow usually binds a
   * session trigger instead of waiting in a step.
   */
  wait: Call<
    { sessionIds: string[]; cursor?: string; timeoutSeconds?: number },
    SessionState & {
      changed: boolean;
      others?: Array<{
        sessionId: string;
        state: SessionStateName;
        cursor: string;
      }>;
    }
  >;
  /**
   * A chat's state. `include` adds sections: `transcript` (the newest
   * `limit` messages, default 30 and at most 100, oldest first, ending at
   * `through` when given: the transcript as of an event, such as a settled
   * turn's `resultMessageId`), `results` (every accepted result, newest
   * first, at most `limit`, default and at most 100; `name` keeps one
   * name, `turnId` one turn's, `family: true` adds its subsessions' at
   * every depth, `afterInput` keeps results that answer that input or a
   * later one, `order: "oldest"` reads the first submitted first), `usage`
   * (tokens per model and the cost providers reported; `family` adds every
   * subsession), `attempts` (with `turnId`: that turn's attempts and their
   * diagnostics, oldest first) and `metadata`.
   */
  read: Call<
    Target & {
      include?: Array<
        "transcript" | "results" | "usage" | "attempts" | "metadata"
      >;
      limit?: number;
      through?: string;
      turnId?: string;
      name?: string;
      family?: boolean;
      afterInput?: string;
      order?: "newest" | "oldest";
    },
    SessionState
  >;
  /** Answer what an agent asked: a question's answers, or an approval. */
  answer: Call<
    Action & {
      requestId: string;
      response:
        | { kind: "question"; answers: string[] }
        | {
            kind: "approval";
            decision: "approved" | "denied";
            remember?: "always";
            reason?: string;
          }
        | {
            kind: "elicitation";
            action: "accept" | "decline" | "cancel";
            content?: JsonValue;
          };
    },
    SessionState
  >;
  /**
   * The caller's newest chats in this project, `limit` at most 100, each
   * with its state; `state` keeps one state of the page. With `key`: the
   * open chat for that key, or none. Never starts one.
   */
  list: Call<
    {
      state?: SessionStateName;
      key?: string;
      audience?: Audience;
      limit?: number;
      cursor?: string;
    },
    { sessions: SessionState[]; total: number; nextCursor: string | null }
  >;
  /**
   * Send a message to a chat. Name it by `sessionId`, or by `key`: the
   * project's chat for that key, started on first use and reused by every
   * automation after (one per pull request, one per day). A chat someone
   * archived comes back and runs; after `close`, the key starts a new chat.
   * `mode` decides what the agent does:
   * `queue` (default) starts or queues its work, `steer` joins the work in
   * progress, `interrupt` stops it and runs next, `message_only` only
   * records the message.
   */
  deliver: Call<
    DeliverTarget & {
      content: string;
      mode?: "queue" | "steer" | "interrupt" | "message_only";
      /** Flag this message itself for the person's attention. */
      attention?: "required" | "none";
      /**
       * Alert the chat's people when the agent's turn settles. A chat named
       * by `key` always does; pass this to customize it, or to alert on a
       * chat named by `sessionId`.
       */
      notification?: { title?: string; body?: string };
      /**
       * Who answers the chat's approvals while no one watches it (a
       * project chat): members by id and holders of project roles. The
       * latest delivery naming approvers replaces them.
       */
      approvers?: { members?: string[]; roles?: string[] };
      /** Defaults to one delivery per run, chat and content. */
      idempotencyKey?: string;
      /** Start, or move, the chat's workspace at a ref of the project's remote. */
      workspace?: WorkspaceRef;
    },
    {
      sessionId: string;
      /** A chat named by `key` was started by this delivery. */
      sessionCreated: boolean;
      messageId: string;
      turnId: string | null;
      /** False when an earlier delivery with the same idempotency key won. */
      created: boolean;
    }
  >;
  fork: Call<
    Action & { messageId?: string },
    { id: string; projectId: string } | QueuedSessionAction
  >;
  /**
   * Start a subsession of the chat through its agent's grants (ADR 0271): a
   * copy of its agent unless `agentId` names another, with the model and
   * effort a grant allows; `readOnly` and `delegate: false` only narrow.
   * It works in the chat's workspace unless `workspace` is `"own"`, a
   * workspace of its own started at the chat's base (ADR 0322).
   */
  spawn: Call<
    Action & {
      task: string;
      agentId?: string;
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      readOnly?: boolean;
      delegate?: boolean;
      workspace?: "shared" | "own";
      title?: string;
      contextMode?: "fresh" | "inherit";
    },
    { session: { id: string; projectId: string } } | QueuedSessionAction
  >;
  /** Hide the chat for the caller and stop its work; deliveries bring it back. */
  archive: Call<Action & { confirmStop?: boolean }>;
  unarchive: Call<Action>;
  /**
   * End the chat's life: stop its work, release its workspace, delete its
   * session branch, and free its key. The transcript stays readable. A chat
   * that is not open answers `{ sessionId: null, closed: false }`; one it
   * closed answers with the chat's state as well.
   */
  close: Call<
    Action,
    Partial<SessionState> & { sessionId: string | null; closed: boolean }
  >;
  /** `turnId`: only that turn, and nothing when it no longer works. */
  interrupt: Call<
    Action & { turnId?: string },
    SessionState & { interrupted: boolean }
  >;
  /**
   * End a running turn's attempt without asking its harness (it is killed,
   * its model grants revoked) and run the same turn again on a new attempt,
   * told it was restarted and why (ADR 0333). Name the attempt to end (a
   * stall event's `detail.attemptId`): one that is no longer the turn's
   * running attempt, or with `onlyIfStalled` no longer stalled, is not
   * ended, and the answer says why (`restarted: false`), so treat that as
   * nothing to do. Needs the authority that interrupts the chat. Bound your
   * restarts with `restarts`.
   */
  restart: Call<
    Action & {
      turnId: string;
      attemptId: string;
      reason: string;
      onlyIfStalled?: boolean;
    },
    | {
        restarted: true;
        turnId: string;
        attemptId: string;
        attempt: number;
        attempts: number;
        restarts: number;
      }
    | {
        restarted: false;
        turnId: string;
        attemptId: string;
        refused: "not_running" | "not_current" | "not_stalled";
        message: string;
      }
  >;
  complete: Call<Action & { content: string }>;
  reopen: Call<Action>;
  stopWatcher: Call<Action & { watcherId: string }>;
  /**
   * Run a shell command in the chat's workspace (ADR 0324), from its
   * checkout or `cwd` beneath it. `in: "session"` runs as the agent's
   * commands do, with the chat's network, grants and secrets, starting its
   * workspace if it has none. `in: "setup"` runs as the Environment's setup
   * does, on the setup's network without grants or secrets, and only from
   * the chat's setup workflow while its workspace is built. `$WORK_PROGRAM`
   * names a read-only copy of this run's `.work/` folder at its deployed
   * commit: copy trusted files from there. A command longer than the
   * boundary's attempt parks the run until it ends; a retry with the same
   * key answers with the same execution.
   */
  exec: Call<
    Action & {
      command: string;
      in: "session" | "setup";
      cwd?: string;
      env?: Record<string, string>;
      /** Default 600, at most 14 400 (four hours). */
      timeoutSeconds?: number;
    },
    SessionExecResult
  >;
  /**
   * Set named values on the chat (ADR 0226, 0325): each key of `set` takes
   * its value whole, and null removes it. Keys are lowercase words joined
   * by `_`, `-` or `.`; at most 32 keys, 16 KB a value and 64 KB in all.
   * Closed and archived chats still take writes. Only the host holding the
   * chat's authority writes it; elsewhere the call fails and retries. The
   * same write twice changes nothing, so there is no idempotency key.
   */
  setMetadata: Call<
    Target & { set: Record<string, JsonValue | null> },
    { sessionId: string; metadata: Record<string, JsonValue> }
  >;
  /** Stop this workflow's temporary activation, retaining its source and runs. */
  stop: Call<{ idempotencyKey: string }, { stopped: boolean }>;
}
