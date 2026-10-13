import type {
  SessionStreamMessage,
  StoredSessionEvent,
} from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect } from "kysely";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { SessionFeed } from "../services/sessions/session-feed.js";
import { QUICK_FOR_MS, WorkWakeups } from "../services/work-wakeups.js";

// Never queried: a stream resets from a snapshot only when its gap is too large.
const pglite = new PGlite();
const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) });

afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await db.destroy();
});

function logOf(events: StoredSessionEvent[]) {
  return {
    eventsAfter: vi.fn(async () => ({ reset: false as const, events: [] })),
    eventsAfterMany: vi.fn(
      async (input: {
        cursors: ReadonlyArray<{ sessionId: string; after: number }>;
      }) =>
        events.filter((event) =>
          input.cursors.some(
            (cursor) =>
              cursor.sessionId === event.sessionId &&
              event.sequence > cursor.after,
          ),
        ),
    ),
  };
}

const AT = "2026-10-13T00:00:00.000Z";
function event(sequence: number): StoredSessionEvent {
  return {
    sessionId: "session",
    sequence,
    at: AT,
    commandId: null,
    event: {
      type: "item.text_appended",
      itemId: "item",
      field: "text",
      text: `part ${sequence}`,
      at: AT,
    },
  };
}

it("polls quickly while events arrive and rarely once they stop, waking for this process's writes", async () => {
  vi.useFakeTimers();
  const events: StoredSessionEvent[] = [];
  const log = logOf(events);
  const wakeups = new WorkWakeups();
  const feed = new SessionFeed(db, log, { idleMs: 5_000, wakeups });
  const received: SessionStreamMessage[] = [];
  const unsubscribe = await feed.subscribe({
    sessionId: "session",
    after: 0,
    send: (message) => {
      received.push(message);
      return true;
    },
    onClose: () => {},
  });
  // Quick right after the stream opens, then idle.
  await vi.advanceTimersByTimeAsync(QUICK_FOR_MS + 200);
  const quickPolls = log.eventsAfterMany.mock.calls.length;
  expect(quickPolls).toBeGreaterThanOrEqual(10);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(
    log.eventsAfterMany.mock.calls.length - quickPolls,
  ).toBeLessThanOrEqual(5);

  // A write in this process is delivered without waiting for the idle poll.
  events.push(event(1));
  wakeups.notify("sessions");
  await vi.advanceTimersByTimeAsync(0);
  expect(received).toEqual([{ type: "events", events: [event(1)] }]);

  // The hint can precede its commit: the poller stays quick and finds it.
  wakeups.notify("sessions");
  await vi.advanceTimersByTimeAsync(0);
  events.push(event(2));
  await vi.advanceTimersByTimeAsync(150);
  expect(received.at(-1)).toEqual({ type: "events", events: [event(2)] });

  unsubscribe();
  const stopped = log.eventsAfterMany.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(log.eventsAfterMany.mock.calls.length).toBe(stopped);
});

it("polls at its quick cadence when the host sets no idle cadence", async () => {
  vi.useFakeTimers();
  const log = logOf([]);
  const feed = new SessionFeed(db, log);
  const unsubscribe = await feed.subscribe({
    sessionId: "session",
    after: 0,
    send: () => true,
    onClose: () => {},
  });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(log.eventsAfterMany.mock.calls.length).toBeGreaterThanOrEqual(90);
  unsubscribe();
});
