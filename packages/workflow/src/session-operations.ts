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
type Action = Target & { idempotencyKey: string };
type Call<Input, Output = unknown> = (
  input: Input,
) => WorkflowTransition<Output>;
/** Host transitions must be returned from a boundary, never awaited as IO. */
export interface SessionHostOperations {
  inspect: Call<Target, SessionSnapshot>;
  list: Call<{ limit?: number }, { items: SessionSnapshot[]; total: number }>;
  /** The newest `limit` messages (default 30, max 100), oldest first. */
  history: Call<
    Target & { limit?: number },
    { sessionId: string; messages: SessionHistoryMessage[] }
  >;
  deliver: Call<
    {
      sessionId: string;
      content: string;
      mode: "message_only" | "next_turn" | "interrupt";
      attention?: "required" | "none";
      idempotencyKey: string;
    },
    { messageId: string; turnId: string | null; created: boolean }
  >;
  wake: Call<
    {
      key: string;
      agentSlug?: string;
      mode?: "next_turn" | "interrupt";
      notification?: { title?: string; body?: string };
      content: string;
      environment?: string;
      title?: string;
    },
    { sessionId: string }
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
