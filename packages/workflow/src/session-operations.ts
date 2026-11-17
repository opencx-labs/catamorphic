import type { TransitionCall } from "./workflow.js";

/** Current host snapshot; authority fields identify its owner. Mirrors may lag. */
export interface SessionSnapshot {
  id: string;
  projectId: string;
  title: string | null;
  agentId: string | null;
  parentSessionId: string | null;
  status: "active" | "closed";
  visibility: "latent" | "promoted" | "archived";
  running: boolean;
  activity: string | null;
  workStatus: "open" | "completed";
  stateRevision: number;
  authorityHostId: string;
  authorityRevision: number;
  /** ISO timestamps: when the conversation started and last changed. */
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Agent-chosen conversation icon ("<name>:<color>"); null = default. */
  icon: string | null;
  /** The project's key for this chat (`pr-42`), or null. */
  key: string | null;
  /** A project chat runs as the project; a member's chat as that member. */
  owner: "project" | "member";
  /** Workflows that delivered to this chat by its key. */
  keyWorkflows: string[];
  /** Where the chat runs and why; null for chats from before placement was recorded. */
  placement: {
    environment: string;
    reason: "requested" | "agent_preferred" | "project_default" | "available";
    machine: { id: string; label: string };
  } | null;
  /**
   * The base the chat's workspace stands on (ADR 0178): the ref of the
   * project's remote it started at or last moved to, and that ref's commit
   * then. Null for a chat started from the project itself.
   */
  workspace: { ref: string; commit: string } | null;
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
/** One transcript message as `history` returns it. */
export interface SessionHistoryMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** ISO timestamp of the message. */
  createdAt: string;
}
/**
 * A value an agent submitted with `submit_result` and its schema accepted
 * (ADR 0323). Results are never rewritten; `current` says whether it still
 * answers its chat's newest input.
 */
export interface SessionResult {
  id: string;
  /** The chat that recorded it: the one named, or one of its subsessions. */
  sessionId: string;
  turnId: string | null;
  attemptId: string | null;
  /** The name its agent's definition declares, e.g. `review`. */
  name: string;
  value: unknown;
  /**
   * The newest input (a message id) the chat had taken in when it was
   * submitted, and its kind, for a reader applying a stricter rule.
   */
  input: {
    itemId: string;
    position: number;
    kind: "user_message" | "inbound_message" | "task_notification";
  } | null;
  /**
   * No new request reached the chat after that input: nothing a person, a
   * workflow or a session outside the chat's own subsessions sent. Task
   * notifications and its subsessions' messages are its own work reporting.
   */
  current: boolean;
  /** The workspace commit the submitting turn began on, when there is one. */
  commit: string | null;
  /** ISO timestamp. */
  recordedAt: string;
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
}
/** Host transitions must be returned from a boundary, never awaited as IO. */
export interface SessionHostOperations {
  inspect: Call<Target, SessionSnapshot>;
  /** The caller's newest sessions in this project, `limit` at most 100. */
  list: Call<{ limit?: number }, { items: SessionSnapshot[]; total: number }>;
  /** The open chat for a key, or null. Never starts one. */
  find: Call<{ key: string; audience?: Audience }, SessionSnapshot | null>;
  /**
   * The newest `limit` messages (default 30, max 100), oldest first, and the
   * chat's key. `through` ends at that message instead: the transcript as
   * of an event, such as a settled turn's `resultMessageId`.
   */
  history: Call<
    Target & { limit?: number; through?: string },
    {
      sessionId: string;
      key: string | null;
      messages: SessionHistoryMessage[];
    }
  >;
  /**
   * The chat's accepted results, newest first, at most `limit` (default and
   * max 100). `name` keeps one result name; `family: true` adds its
   * subsessions' results at every depth, each naming its chat;
   * `afterInput` (an input's message id, such as a delivery's `messageId`)
   * keeps results that answer that input or a later one.
   */
  results: Call<
    Target & {
      name?: string;
      family?: boolean;
      afterInput?: string;
      limit?: number;
    },
    { sessionId: string; key: string | null; results: SessionResult[] }
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
  create: Call<
    Action & { agentId?: string; title?: string; workspace?: WorkspaceRef },
    SessionSnapshot | QueuedSessionAction
  >;
  fork: Call<
    Action & { messageId?: string },
    SessionSnapshot | QueuedSessionAction
  >;
  /**
   * Start a subsession of the chat through its agent's grants (ADR 0271): a
   * copy of its agent unless `agentId` names another, with the model and
   * effort a grant allows; `readOnly` and `delegate: false` only narrow.
   */
  spawn: Call<
    Action & {
      task: string;
      agentId?: string;
      model?: string;
      effort?: "low" | "medium" | "high" | "xhigh" | "max";
      readOnly?: boolean;
      delegate?: boolean;
      title?: string;
      contextMode?: "fresh" | "inherit";
    },
    { session: SessionSnapshot } | QueuedSessionAction
  >;
  /** Hide the chat for the caller and stop its work; deliveries bring it back. */
  archive: Call<Action & { confirmStop?: boolean }>;
  unarchive: Call<Action>;
  /**
   * End the chat's life: stop its work, release its workspace, delete its
   * session branch, and free its key. The transcript stays readable. A chat
   * that is not open answers `{ closed: false }`.
   */
  close: Call<Action, { sessionId: string | null; closed: boolean }>;
  interrupt: Call<Action>;
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
  /** Stop this workflow's temporary activation, retaining its source and runs. */
  stop: Call<{ idempotencyKey: string }, { stopped: boolean }>;
}
