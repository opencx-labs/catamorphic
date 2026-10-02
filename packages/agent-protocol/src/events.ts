import type {
  Attempt,
  Item,
  JsonObject,
  ProviderThread,
  RuntimeRequest,
  SessionFields,
  Turn,
} from "./model.js";

/**
 * One change to a session (ADR 0197). Events carry the changed entity
 * whole, so applying one never needs the entity's history; streamed text
 * is the exception and arrives as appends.
 */
export type SessionEvent =
  | { type: "session.changed"; session: Partial<SessionFields> }
  | { type: "turn.changed"; turn: Turn }
  | { type: "attempt.changed"; attempt: Attempt }
  | { type: "item.added"; item: Item }
  | { type: "item.changed"; item: Item }
  | {
      type: "item.text_appended";
      itemId: string;
      /** `text` of messages and reasoning, `output` of commands. */
      field: "text" | "output";
      text: string;
      at: string;
    }
  | { type: "request.changed"; request: RuntimeRequest }
  | { type: "provider_thread.changed"; thread: ProviderThread };

export type SessionEventType = SessionEvent["type"];

/** An event as the log stores and streams it. */
export interface StoredSessionEvent {
  sessionId: string;
  /** Per-session, gapless, starting at 1. */
  sequence: number;
  at: string;
  /** The command that committed it, when one did. */
  commandId: string | null;
  event: SessionEvent;
}

/**
 * A bounded view of a session at one sequence. Apply events with a greater
 * sequence to keep it current. Older items page by `position`.
 */
export interface SessionSnapshot {
  sequence: number;
  session: SessionFields;
  turns: Turn[];
  attempts: Attempt[];
  items: Item[];
  requests: RuntimeRequest[];
  providerThreads: ProviderThread[];
  /** The earliest item position in this snapshot, when older items exist. */
  olderBefore: number | null;
}

/**
 * What a session event stream sends: events in order, or `reset` with a
 * fresh snapshot when the gap was too large to replay.
 */
export type SessionStreamMessage =
  | { type: "events"; events: StoredSessionEvent[] }
  | { type: "reset"; snapshot: SessionSnapshot }
  | { type: "heartbeat"; sequence: number };

/** A command's durable receipt (ADR 0197). */
export interface CommandReceipt {
  commandId: string;
  status: "accepted" | "rejected";
  /** The last event sequence the command committed (or the log's, if none). */
  sequence: number;
  result: JsonObject | null;
  error: { code: string; message: string } | null;
}
