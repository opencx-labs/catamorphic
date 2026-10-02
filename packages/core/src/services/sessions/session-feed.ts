import type {
  SessionStreamMessage,
  StoredSessionEvent,
} from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { SessionLog } from "./session-log.js";
import { readSnapshot } from "./session-reads.js";

/** Events or bytes a subscriber may fall behind before it must resume. */
export const STREAM_MAX_PENDING_EVENTS = 1_000;
export const STREAM_MAX_PENDING_BYTES = 8 * 1024 * 1024;

interface Subscriber {
  sessionId: string;
  after: number;
  push(message: SessionStreamMessage): boolean;
  close(reason: "slow" | "ended"): void;
}

/**
 * Live session streams for this process (ADR 0196). One poller serves
 * every open stream: each tick reads the subscribed sessions' events after
 * their cursors in one query, in Postgres order, with no LISTEN/NOTIFY
 * (ADR 0193). A subscriber that falls behind is closed; its client resumes
 * from its cursor. Replica memory (a): the streams this process serves.
 */
export class SessionFeed {
  private readonly subscribers = new Set<Subscriber>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly log: SessionLog,
    private readonly intervalMs = 150,
  ) {}

  /**
   * Stream a session from `after`: the gap first (or a fresh snapshot when
   * it is too large to replay), then live events. Returns an unsubscribe.
   */
  async subscribe(input: {
    sessionId: string;
    after: number;
    send: (message: SessionStreamMessage) => boolean;
    onClose: (reason: "slow" | "ended") => void;
  }): Promise<() => void> {
    let pendingBytes = 0;
    let pendingEvents = 0;
    const subscriber: Subscriber = {
      sessionId: input.sessionId,
      after: input.after,
      push: (message) => {
        const ok = input.send(message);
        if (ok) {
          pendingBytes = 0;
          pendingEvents = 0;
          return true;
        }
        // The transport is buffering: count what waits, and give up on a
        // reader that cannot keep up rather than hold unbounded memory.
        pendingEvents += message.type === "events" ? message.events.length : 1;
        pendingBytes += JSON.stringify(message).length;
        return (
          pendingEvents <= STREAM_MAX_PENDING_EVENTS &&
          pendingBytes <= STREAM_MAX_PENDING_BYTES
        );
      },
      close: input.onClose,
    };
    // Join the live poll before catching up, so nothing committed between
    // the catch-up and the first tick is missed; overlap is filtered by
    // sequence.
    this.subscribers.add(subscriber);
    this.ensureTimer();
    const gap = await this.log.eventsAfter({
      sessionId: input.sessionId,
      after: input.after,
    });
    if (gap.reset) {
      const snapshot = await readSnapshot({ db: this.db, sessionId: input.sessionId });
      subscriber.after = Math.max(subscriber.after, snapshot.sequence);
      this.deliver(subscriber, { type: "reset", snapshot });
    } else if (gap.events.length > 0) {
      this.deliverEvents(subscriber, gap.events);
    }
    return () => {
      this.subscribers.delete(subscriber);
      this.stopIfIdle();
    };
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  private stopIfIdle(): void {
    if (this.subscribers.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private deliver(subscriber: Subscriber, message: SessionStreamMessage): void {
    if (!subscriber.push(message)) {
      this.subscribers.delete(subscriber);
      subscriber.close("slow");
      this.stopIfIdle();
    }
  }

  private deliverEvents(
    subscriber: Subscriber,
    events: readonly StoredSessionEvent[],
  ): void {
    const fresh = events.filter((event) => event.sequence > subscriber.after);
    if (fresh.length === 0) return;
    subscriber.after = fresh.at(-1)?.sequence ?? subscriber.after;
    this.deliver(subscriber, { type: "events", events: fresh });
  }

  private async tick(): Promise<void> {
    if (this.polling || this.subscribers.size === 0) return;
    this.polling = true;
    try {
      const cursors = new Map<string, number>();
      for (const subscriber of this.subscribers) {
        const current = cursors.get(subscriber.sessionId);
        cursors.set(
          subscriber.sessionId,
          current === undefined ? subscriber.after : Math.min(current, subscriber.after),
        );
      }
      const events = await this.log.eventsAfterMany({
        cursors: [...cursors].map(([sessionId, after]) => ({ sessionId, after })),
        limit: 2_000,
      });
      if (events.length === 0) return;
      const bySession = new Map<string, StoredSessionEvent[]>();
      for (const event of events) {
        const list = bySession.get(event.sessionId) ?? [];
        list.push(event);
        bySession.set(event.sessionId, list);
      }
      for (const subscriber of [...this.subscribers]) {
        const list = bySession.get(subscriber.sessionId);
        if (list) this.deliverEvents(subscriber, list);
      }
    } catch (error) {
      console.warn("[catamorphic] Session feed poll failed", error);
    } finally {
      this.polling = false;
    }
  }

  /** End every stream (the process is stopping). */
  close(): void {
    for (const subscriber of this.subscribers) subscriber.close("ended");
    this.subscribers.clear();
    this.stopIfIdle();
  }
}
