import type { WorkflowTransition } from "./workflow.js";

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
}
/** One transcript message as `history` returns it. */
export interface SessionHistoryMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** ISO timestamp of the message. */
  createdAt: string;
}
/** The authoritative host has accepted delivery, but has not applied this action yet. */
export interface QueuedSessionAction {
  delivery: "queued";
  messageId: string;
  turnId: null;
  created: boolean;
}
type Target = { sessionId: string; expectedStateRevision?: number };
/** A chat by id, or the chat this workflow keeps for a key. */
type DeliverTarget =
  | { sessionId: string; key?: never }
  | {
      key: string;
      sessionId?: never;
      /**
       * Whose chat a keyed chat is (ADR 0156). A member's automation reaches
       * only that member; a project automation reaches the project chat,
       * open to everyone whose role reaches the agent, unless it names a
       * member.
       */
      audience?: "project" | { member: string };
      /** The project agent that answers in a new chat. */
      agentSlug?: string;
      title?: string;
      environment?: string;
    };
type Action = Target & { idempotencyKey: string };
type Call<Input, Output = unknown> = (
  input: Input,
) => WorkflowTransition<Output>;
/** Host transitions must be returned from a boundary, never awaited as IO. */
export interface SessionHostOperations {
  inspect: Call<Target, SessionSnapshot>;
  /** The caller's newest sessions in this project, `limit` at most 100. */
  list: Call<{ limit?: number }, { items: SessionSnapshot[]; total: number }>;
  /** The newest `limit` messages (default 30, max 100), oldest first. */
  history: Call<
    Target & { limit?: number },
    { sessionId: string; messages: SessionHistoryMessage[] }
  >;
  /**
   * Send a message to a chat. Name it by `sessionId`, or by `key`: the chat
   * this workflow keeps for that key, started on first use and reused after
   * (one per pull request, one per day). `mode` decides what the agent does:
   * `next_turn` (default) starts or queues its work, `message_only` only
   * records the message, `interrupt` redirects work in progress.
   */
  deliver: Call<
    DeliverTarget & {
      content: string;
      mode?: "message_only" | "next_turn" | "interrupt";
      /** Flag this message itself for the person's attention. */
      attention?: "required" | "none";
      /**
       * Alert the chat's people when the agent's turn settles. A chat named
       * by `key` always does; pass this to customize it, or to alert on a
       * chat named by `sessionId`.
       */
      notification?: { title?: string; body?: string };
      /** Defaults to one delivery per run, chat and content. */
      idempotencyKey?: string;
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
    Action & { agentId?: string; title?: string },
    SessionSnapshot | QueuedSessionAction
  >;
  fork: Call<
    Action & { messageId?: string },
    SessionSnapshot | QueuedSessionAction
  >;
  spawn: Call<
    Action & {
      task: string;
      routeId?: string;
      agentId?: string;
      title?: string;
      contextMode?: "fresh" | "inherit";
    },
    { session: SessionSnapshot } | QueuedSessionAction
  >;
  archive: Call<Action & { confirmStop?: boolean }>;
  unarchive: Call<Action>;
  interrupt: Call<Action>;
  complete: Call<Action & { content: string }>;
  reopen: Call<Action>;
  stopWatcher: Call<Action & { watcherId: string }>;
  /** Stop this workflow's temporary activation, retaining its source and runs. */
  stop: Call<{ idempotencyKey: string }, { stopped: boolean }>;
}
