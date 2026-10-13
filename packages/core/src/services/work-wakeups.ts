/**
 * What durable work a hint is about: queued jobs, agent turns, project
 * events, session events a live stream may be waiting for, or a change
 * lists of chats show (anything but streamed text and progress on an
 * item: a chat's fields, a turn's status or activity, a step, a request).
 */
export type WorkTopic = "execution" | "agent" | "events" | "sessions" | "chats";

/**
 * In-process hints that durable work may be waiting (ADR 0228). A writer in
 * this process calls {@link notify} once it has queued work in Postgres; a
 * poller pacing itself with {@link PollPacer} looks at once instead of at
 * its next idle poll. A hint is never the record: every poller still reads
 * Postgres on its own schedule, so work another process wrote is found at
 * its next poll whether or not a hint came.
 */
export class WorkWakeups {
  // Replica memory (a): this process's own pollers waiting for a hint;
  // nothing another replica observes.
  private readonly listeners = new Map<WorkTopic, Set<() => void>>();

  notify(topic: WorkTopic): void {
    for (const listener of [...(this.listeners.get(topic) ?? [])]) listener();
  }

  subscribe(topic: WorkTopic, listener: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

/** How long a poller keeps its quick cadence after finding work or a hint. */
export const QUICK_FOR_MS = 2_000;

/**
 * Paces one polling loop (ADR 0228): every `quickMs` while there is work
 * about (the last poll found some, or a hint came in the last
 * {@link QUICK_FOR_MS}), every `idleMs` otherwise. A hint ends an idle
 * wait at once. A hint can arrive before its writer's transaction commits,
 * so a woken poller stays quick long enough to see the commit.
 *
 * Without `idleMs` (or with one no longer than `quickMs`) it polls every
 * `quickMs`, as an unpaced loop does.
 */
export class PollPacer {
  private quickUntil = 0;

  constructor(
    private readonly input: {
      quickMs: number;
      idleMs?: number;
      wakeups?: WorkWakeups;
      topic?: WorkTopic;
      /** The clock, for tests. */
      now?: () => number;
    },
  ) {}

  /** Whether the next wait is a quick one. */
  get quick(): boolean {
    return this.now() < this.quickUntil || !this.paced;
  }

  /** The last poll found work: stay quick a while longer. */
  busy(): void {
    this.quickUntil = this.now() + QUICK_FOR_MS;
  }

  /**
   * Wait before the next poll. Resolves early when `signal` aborts, and,
   * during an idle wait, when a hint for this pacer's topic arrives. An
   * idle wait ends by `until` (epoch milliseconds: when known work falls
   * due), but never sooner than a quick one: work that is due yet not
   * claimable here is polled for as an unpaced loop would.
   */
  wait(signal?: AbortSignal, options: { until?: number } = {}): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    const quick = this.quick;
    const { quickMs } = this.input;
    let milliseconds = quick ? quickMs : (this.input.idleMs ?? quickMs);
    if (!quick && options.until !== undefined)
      milliseconds = Math.min(
        milliseconds,
        Math.max(options.until - this.now(), quickMs),
      );
    const { wakeups, topic } = this.input;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        unsubscribe?.();
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      timer.unref?.();
      signal?.addEventListener("abort", done, { once: true });
      const unsubscribe =
        !quick && wakeups && topic
          ? wakeups.subscribe(topic, () => {
              this.busy();
              done();
            })
          : undefined;
    });
  }

  private get paced(): boolean {
    return (this.input.idleMs ?? 0) > this.input.quickMs;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }
}
