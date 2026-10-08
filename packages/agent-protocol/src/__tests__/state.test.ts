import { describe, expect, it } from "vitest";
import type { SessionSnapshot, StoredSessionEvent } from "../events.js";
import type { AssistantMessageItem, SessionFields, Turn } from "../model.js";
import {
  activeTurn,
  applySessionEvents,
  itemsOfTurn,
  queuedTurns,
  sessionStateFromSnapshot,
} from "../state.js";

const at = "2026-10-02T00:00:00.000Z";

const session: SessionFields = {
  id: "s",
  projectId: "p",
  title: null,
  icon: null,
  agentId: null,
  harness: null,
  model: null,
  modelEffort: null,
  status: "active",
  workStatus: "open",
  activity: null,
  todos: [],
  parentSessionId: null,
  forkedFromSessionId: null,
  attentionRevision: 0,
  environment: null,
  authorityHostId: "h",
  authorityRevision: 1,
  handoffStatus: "none",
  updatedAt: at,
};

function turn(id: string, ordinal: number, status: Turn["status"]): Turn {
  return {
    id,
    sessionId: "s",
    ordinal,
    status,
    inputItemId: null,
    dispatch: "queue",
    priority: 0,
    activity: null,
    activityAt: null,
    attemptCount: 0,
    activeAttemptId: null,
    providerThreadId: null,
    retryAt: null,
    cancellationRequested: false,
    error: null,
    outcome: null,
    checkpoint: { before: null, after: null },
    continuationOf: null,
    createdAt: at,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
  };
}

function reply(position: number, text: string): AssistantMessageItem {
  return {
    id: `item-${position}`,
    sessionId: "s",
    turnId: "t1",
    attemptId: "a1",
    parentItemId: null,
    position,
    status: "in_progress",
    nativeRef: null,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    endedAt: null,
    kind: "assistant_message",
    text,
    agentId: null,
  };
}

function stored(
  sequence: number,
  event: StoredSessionEvent["event"],
): StoredSessionEvent {
  return { sessionId: "s", sequence, at, commandId: null, event };
}

const empty: SessionSnapshot = {
  sequence: 0,
  session,
  turns: [],
  attempts: [],
  items: [],
  requests: [],
  providerThreads: [],
  olderBefore: null,
};

describe("session reducer", () => {
  it("applies events in order and skips ones the snapshot covered", () => {
    let state = sessionStateFromSnapshot(empty);
    state = applySessionEvents(state, [
      stored(1, { type: "turn.changed", turn: turn("t1", 1, "running") }),
      stored(2, { type: "item.added", item: reply(2, "") }),
      stored(3, {
        type: "item.text_appended",
        itemId: "item-2",
        field: "text",
        text: "Hel",
        at,
      }),
      stored(4, {
        type: "item.text_appended",
        itemId: "item-2",
        field: "text",
        text: "lo",
        at,
      }),
    ]);
    // A replay overlapping what was applied changes nothing.
    state = applySessionEvents(state, [
      stored(3, {
        type: "item.text_appended",
        itemId: "item-2",
        field: "text",
        text: "Hel",
        at,
      }),
    ]);
    expect(state.sequence).toBe(4);
    expect(activeTurn(state)?.id).toBe("t1");
    expect(itemsOfTurn(state, "t1").map((item) => item.kind)).toEqual([
      "assistant_message",
    ]);
    expect((state.items[0] as AssistantMessageItem).text).toBe("Hello");
  });

  it("marks a gap stale instead of applying past it", () => {
    const state = applySessionEvents(sessionStateFromSnapshot(empty), [
      stored(2, { type: "turn.changed", turn: turn("t1", 1, "queued") }),
    ]);
    expect(state.stale).toBe(true);
    expect(state.sequence).toBe(0);
    expect(Object.keys(state.turns)).toEqual([]);
  });

  it("keeps items in position order whatever order they arrive in", () => {
    const state = applySessionEvents(sessionStateFromSnapshot(empty), [
      stored(1, { type: "item.added", item: reply(5, "later") }),
      stored(2, { type: "item.added", item: reply(3, "earlier") }),
    ]);
    expect(state.items.map((item) => item.position)).toEqual([3, 5]);
  });

  it("orders the queue by priority, then arrival", () => {
    const state = applySessionEvents(sessionStateFromSnapshot(empty), [
      stored(1, { type: "turn.changed", turn: turn("a", 1, "queued") }),
      stored(2, {
        type: "turn.changed",
        turn: { ...turn("b", 2, "queued"), priority: 100 },
      }),
      stored(3, { type: "turn.changed", turn: turn("c", 3, "held") }),
    ]);
    expect(queuedTurns(state).map((queued) => queued.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});
