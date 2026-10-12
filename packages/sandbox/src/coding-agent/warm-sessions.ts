/**
 * How a host lets an adapter keep its harness up between attempts (ADR
 * 0222): how long an idle one stays, and how many at once.
 */
export interface WarmSessionsOptions {
  /** How long a session nobody uses stays up. */
  idleMs: number;
  /** Idle sessions kept at once; the least recently used ends first. */
  max: number;
}

/** A harness session an adapter keeps between attempts. */
export interface WarmSession {
  /** Its process is still up and can take another turn. */
  readonly alive: boolean;
  /** End it: stop its process, letting it finish what it writes on exit. */
  close(): Promise<void>;
}

/**
 * The idle harness sessions an adapter keeps, by native thread (ADR 0222).
 * A session is taken out while an attempt uses it and put back when the
 * attempt settles; one left idle past `idleMs`, or pushed out by newer
 * ones past `max`, is closed. The sessions are this process's own
 * children: nothing outside it could reach them.
 */
export class WarmSessions<S extends WarmSession> {
  private readonly idle = new Map<
    string,
    { session: S; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;

  constructor(private readonly options: WarmSessionsOptions) {}

  /**
   * The idle session of `thread`, when `accept` takes it. One it refuses
   * (another configuration, a history that moved on) is closed first, so
   * no two processes ever hold the same native thread.
   */
  async take(
    thread: string,
    accept: (session: S) => boolean,
  ): Promise<S | undefined> {
    const entry = this.idle.get(thread);
    if (!entry) return undefined;
    this.idle.delete(thread);
    clearTimeout(entry.timer);
    if (entry.session.alive && accept(entry.session)) return entry.session;
    await entry.session.close();
    return undefined;
  }

  /** Keep a session whose attempt settled, for the thread's next one. */
  release(thread: string, session: S): void {
    if (this.disposed || !session.alive) {
      void session.close();
      return;
    }
    const previous = this.idle.get(thread);
    if (previous && previous.session !== session) {
      clearTimeout(previous.timer);
      void previous.session.close();
    }
    this.idle.delete(thread);
    const timer = setTimeout(() => {
      if (this.idle.get(thread)?.session !== session) return;
      this.idle.delete(thread);
      void session.close();
    }, this.options.idleMs);
    timer.unref?.();
    // Insertion order is recency: the first entry is the least recently used.
    this.idle.set(thread, { session, timer });
    while (this.idle.size > Math.max(0, this.options.max)) {
      const [oldest, entry] = this.idle.entries().next().value ?? [];
      if (oldest === undefined || !entry) break;
      this.idle.delete(oldest);
      clearTimeout(entry.timer);
      void entry.session.close();
    }
  }

  /** Forget a session that ended by itself (its process exited). */
  forget(thread: string, session: S): void {
    const entry = this.idle.get(thread);
    if (entry?.session !== session) return;
    this.idle.delete(thread);
    clearTimeout(entry.timer);
  }

  /** How many sessions are idle now. */
  get size(): number {
    return this.idle.size;
  }

  /** End every idle session; later releases close at once. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.idle.values()];
    this.idle.clear();
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map((entry) => entry.session.close()));
  }
}
