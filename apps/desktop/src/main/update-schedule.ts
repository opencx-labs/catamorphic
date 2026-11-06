/**
 * When Work looks for an update of itself. Due times are wall-clock times:
 * timers stop while a Mac sleeps, so "every six hours" measured by an
 * interval timer stretched to days on a laptop that sleeps at night. A
 * short tick compares the clock instead, a wake checks once the network has
 * had a minute to return, and a failed check is retried soon rather than
 * waiting for the next six hours.
 */
export interface UpdateScheduleOptions {
  /** Look for an update; resolves whether the update feed answered. */
  check: () => Promise<boolean>;
  initialDelayMs?: number;
  intervalMs?: number;
  retryMs?: number;
  resumeDelayMs?: number;
  tickMs?: number;
}

export class UpdateSchedule {
  private readonly intervalMs: number;
  private readonly retryMs: number;
  private readonly resumeDelayMs: number;
  private readonly tickMs: number;
  private readonly initialDelayMs: number;
  /** When the next check is due, on the wall clock. */
  private dueAt: number;
  private running = false;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private resumeTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: UpdateScheduleOptions) {
    this.initialDelayMs = options.initialDelayMs ?? 30_000;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60_000;
    this.retryMs = options.retryMs ?? 15 * 60_000;
    this.resumeDelayMs = options.resumeDelayMs ?? 60_000;
    this.tickMs = options.tickMs ?? 5 * 60_000;
    this.dueAt = Date.now() + this.initialDelayMs;
  }

  start(): void {
    this.arm(Math.min(this.initialDelayMs, this.tickMs));
  }

  /** After sleep: check once the network is likely back, if one is due. */
  resumed(): void {
    if (this.disposed) return;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      void this.tick();
    }, this.resumeDelayMs);
    this.resumeTimer.unref?.();
  }

  /** A check made elsewhere (from the menu) counts toward the schedule. */
  checked(answered: boolean): void {
    this.dueAt = Date.now() + (answered ? this.intervalMs : this.retryMs);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.tickTimer);
    clearTimeout(this.resumeTimer);
  }

  private arm(ms: number): void {
    if (this.disposed) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      void this.tick().finally(() => this.arm(this.tickMs));
    }, ms);
    this.tickTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.running || Date.now() < this.dueAt) return;
    this.running = true;
    try {
      this.checked(await this.options.check().catch(() => false));
    } finally {
      this.running = false;
    }
  }
}
