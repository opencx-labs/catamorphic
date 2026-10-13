/**
 * What durable work a hint is about: queued jobs, agent turns, project
 * events, session events a live stream may be waiting for, or a change
 * lists of chats show (anything but streamed text and progress on an
 * item: a chat's fields, its attention or visibility, a turn's status or
 * activity, a step, a request, a watcher).
 */
export type WorkTopic = "execution" | "agent" | "events" | "sessions" | "chats";

/** One wait for the next hint on a key; cancelled once it no longer waits. */
export interface Wakeup {
  readonly woken: Promise<void>;
  cancel(): void;
}

/**
 * In-process hints that durable work may be waiting (ADRs 0207, 0228). A
 * writer in this process calls {@link notify} once it has queued work in
 * Postgres; whoever waits for that key looks at once instead of at its
 * next poll. Pollers key it by {@link WorkTopic}; remote operations by
 * executor and by operation (`OperationWakeups`). A hint is never the
 * record: every waiter still reads Postgres on its own schedule, so work
 * another process wrote is found at its next poll whether or not a hint
 * came. A waiter subscribes before it reads Postgres (a {@link PollPacer}
 * for its loop's lifetime), so a hint between its read and its wait is
 * not missed.
 */
export class WorkWakeups<Key extends string = WorkTopic> {
  // Replica memory (a): this process's own waiters for a hint; nothing
  // another replica observes.
  private readonly listeners = new Map<Key, Set<() => void>>();

  /** Hint `key`; returns how many waiters heard it. */
  notify(key: Key): number {
    const heard = [...(this.listeners.get(key) ?? [])];
    for (const listener of heard) listener();
    return heard.length;
  }

  subscribe(key: Key, listener: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set)
        this.listeners.delete(key);
    };
  }

  /** The next hint for `key`, once. */
  next(key: Key): Wakeup {
    let cancel = () => {};
    const woken = new Promise<void>((resolve) => {
      cancel = this.subscribe(key, () => {
        cancel();
        resolve();
      });
    });
    return { woken, cancel };
  }
}

/** How long a poller keeps its quick cadence after finding work or a hint. */
export const QUICK_FOR_MS = 2_000;

/**
 * Paces one polling loop (ADR 0228): every `quickMs` while there is work
 * about (the last poll found some, or a hint came in the last
 * {@link QUICK_FOR_MS}), every `idleMs` otherwise. Each wait runs after a
 * poll ends, so a slow poll delays the next one rather than overlapping
 * it.
 *
 * It hears its topic's hints from construction until `signal` aborts,
 * not only while it waits: a hint makes it quick, and ends an idle wait at
 * once. A hint can arrive while a poll is in flight, or before its
 * writer's transaction commits; the next wait is then a quick one, and
 * the pacer stays quick long enough to see the commit. A hint never ends
 * a quick wait, so a run of hints polls no faster than `quickMs`.
 *
 * Without `idleMs` (or with one no longer than `quickMs`) it waits
 * `quickMs` between polls.
 */
export class PollPacer {
  private quickUntil = 0;
  /** Ends the idle wait in progress, if one is. */
  private wake: (() => void) | undefined;

  constructor(
    private readonly input: {
      quickMs: number;
      idleMs?: number;
      /** The loop's stop: ends a wait, and the pacer's hints. */
      signal: AbortSignal;
      wakeups?: WorkWakeups;
      topic?: WorkTopic;
      /** The clock, for tests. */
      now?: () => number;
    },
  ) {
    const { wakeups, topic, signal } = input;
    if (!wakeups || !topic || signal.aborted) return;
    const unsubscribe = wakeups.subscribe(topic, () => {
      this.busy();
      this.wake?.();
    });
    signal.addEventListener("abort", unsubscribe, { once: true });
  }

  /** Whether the next wait is a quick one. */
  get quick(): boolean {
    return this.now() < this.quickUntil || !this.paced;
  }

  /** The last poll found work, or a hint came: stay quick a while longer. */
  busy(): void {
    this.quickUntil = this.now() + QUICK_FOR_MS;
  }

  /**
   * Wait before the next poll. Resolves early when the signal aborts or,
   * during an idle wait, when a hint for this pacer's topic arrives. An
   * idle wait ends by `until` (epoch milliseconds: when known work falls
   * due), but never sooner than a quick one: work that is due yet not
   * claimable here is polled for as an unpaced loop would.
   */
  wait(options: { until?: number } = {}): Promise<void> {
    const { signal, quickMs } = this.input;
    if (signal.aborted) return Promise.resolve();
    const quick = this.quick;
    let milliseconds = quick ? quickMs : (this.input.idleMs ?? quickMs);
    if (!quick && options.until !== undefined)
      milliseconds = Math.min(
        milliseconds,
        Math.max(options.until - this.now(), quickMs),
      );
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      if (!quick) this.wake = done;
    });
  }

  private get paced(): boolean {
    return (this.input.idleMs ?? 0) > this.input.quickMs;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }
}
