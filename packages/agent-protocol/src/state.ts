import type { SessionSnapshot, StoredSessionEvent } from "./events.js";
import {
  type Attempt,
  type Item,
  isActiveTurnStatus,
  type ProviderThread,
  type RuntimeRequest,
  type SessionFields,
  type Turn,
} from "./model.js";

/**
 * A client's view of one session: a snapshot with every later event
 * applied. The same reducer runs in every client and in the server's tests,
 * which fold the log and compare it with the projections (ADR 0195).
 */
export interface SessionState {
  sequence: number;
  session: SessionFields;
  turns: Readonly<Record<string, Turn>>;
  attempts: Readonly<Record<string, Attempt>>;
  /** In transcript order (`position`). */
  items: readonly Item[];
  requests: Readonly<Record<string, RuntimeRequest>>;
  providerThreads: Readonly<Record<string, ProviderThread>>;
  olderBefore: number | null;
  /**
   * An event arrived out of order: something between was missed. The
   * client should load a fresh snapshot; the state stays as it was.
   */
  stale: boolean;
}

function byId<T extends { id: string }>(
  values: readonly T[],
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const value of values) out[value.id] = value;
  return out;
}

export function sessionStateFromSnapshot(
  snapshot: SessionSnapshot,
): SessionState {
  return {
    sequence: snapshot.sequence,
    session: snapshot.session,
    turns: byId(snapshot.turns),
    attempts: byId(snapshot.attempts),
    items: [...snapshot.items].sort(compareItems),
    requests: byId(snapshot.requests),
    providerThreads: byId(snapshot.providerThreads),
    olderBefore: snapshot.olderBefore,
    stale: false,
  };
}

function compareItems(a: Item, b: Item): number {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Put an item in place: replace it by id, or insert it in position order. */
function upsertItem(items: readonly Item[], item: Item): Item[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) {
    const next = items.slice();
    next[index] = item;
    return next;
  }
  const next = items.slice();
  let at = next.length;
  while (at > 0 && compareItems(next[at - 1] as Item, item) > 0) at -= 1;
  next.splice(at, 0, item);
  return next;
}

/**
 * Apply stored events in order. Events at or below the state's sequence
 * are skipped (a replay overlapping what the snapshot covered); an event
 * after a gap marks the state `stale` and is not applied.
 */
export function applySessionEvents(
  state: SessionState,
  events: readonly StoredSessionEvent[],
): SessionState {
  let next = state;
  for (const stored of events) {
    if (next.stale) return next;
    if (stored.sequence <= next.sequence) continue;
    if (stored.sequence !== next.sequence + 1) return { ...next, stale: true };
    next = applyOne(next, stored);
  }
  return next;
}

function applyOne(
  state: SessionState,
  stored: StoredSessionEvent,
): SessionState {
  const base = { ...state, sequence: stored.sequence };
  const event = stored.event;
  switch (event.type) {
    case "session.changed":
      return { ...base, session: { ...state.session, ...event.session } };
    case "turn.changed":
      return {
        ...base,
        turns: { ...state.turns, [event.turn.id]: event.turn },
      };
    case "attempt.changed":
      return {
        ...base,
        attempts: { ...state.attempts, [event.attempt.id]: event.attempt },
      };
    case "item.added":
    case "item.changed":
      return { ...base, items: upsertItem(state.items, event.item) };
    case "item.text_appended": {
      const index = state.items.findIndex((item) => item.id === event.itemId);
      if (index < 0) return base;
      const item = state.items[index] as Item;
      const appended = appendText(item, event.field, event.text, event.at);
      if (appended === item) return base;
      const items = state.items.slice();
      items[index] = appended;
      return { ...base, items };
    }
    case "request.changed":
      return {
        ...base,
        requests: { ...state.requests, [event.request.id]: event.request },
      };
    case "provider_thread.changed":
      return {
        ...base,
        providerThreads: {
          ...state.providerThreads,
          [event.thread.id]: event.thread,
        },
      };
  }
}

/** The item with `text` appended to its streamed field, or itself. */
export function appendText(
  item: Item,
  field: "text" | "output",
  text: string,
  at: string,
): Item {
  if (field === "output") {
    return item.kind === "command"
      ? { ...item, output: item.output + text, updatedAt: at }
      : item;
  }
  switch (item.kind) {
    case "assistant_message":
    case "reasoning":
      return { ...item, text: item.text + text, updatedAt: at };
    default:
      return item;
  }
}

/** Older items loaded on scroll, merged in position order. */
export function withOlderItems(
  state: SessionState,
  page: { items: readonly Item[]; olderBefore: number | null },
): SessionState {
  let items: Item[] = state.items.slice();
  for (const item of page.items) items = upsertItem(items, item);
  return { ...state, items, olderBefore: page.olderBefore };
}

// ---------------------------------------------------------------------------
// Selectors

export function orderedTurns(state: SessionState): Turn[] {
  return Object.values(state.turns).sort((a, b) => a.ordinal - b.ordinal);
}

/** The turn the harness works on now, if any. */
export function activeTurn(state: SessionState): Turn | undefined {
  return orderedTurns(state).find((turn) => isActiveTurnStatus(turn.status));
}

/** Turns waiting to run, in the order they will run. */
export function queuedTurns(state: SessionState): Turn[] {
  return Object.values(state.turns)
    .filter((turn) => turn.status === "queued" || turn.status === "held")
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.ordinal - b.ordinal,
    );
}

export function itemsOfTurn(state: SessionState, turnId: string): Item[] {
  return state.items.filter((item) => item.turnId === turnId);
}

export function pendingRequests(state: SessionState): RuntimeRequest[] {
  return Object.values(state.requests)
    .filter((request) => request.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Whether the session has work in flight: a turn running or waiting. */
export function isWorking(state: SessionState): boolean {
  return activeTurn(state) !== undefined;
}
