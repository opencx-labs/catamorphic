import type {
  AgentRuntimeEvent,
  SubscribeToAgentEvents,
} from "./runtime-types.js";

export interface AgentEventBufferOptions {
  maxEvents?: number;
  maxBytes?: number;
}

/** The host persists events. This bounded window only supports transport replay. */
export class AgentEventBuffer {
  private readonly events: Array<{ event: AgentRuntimeEvent; bytes: number }> =
    [];
  private readonly waiters = new Set<() => void>();
  private bytes = 0;
  private discardedThrough = 0;
  private closed = false;

  constructor(private readonly options: AgentEventBufferOptions = {}) {
    for (const value of [options.maxEvents, options.maxBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new Error("Agent event buffer limits must be positive integers");
    }
  }

  push(event: AgentRuntimeEvent): void {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    this.events.push({ event, bytes });
    this.bytes += bytes;
    while (
      this.events.length > (this.options.maxEvents ?? 2048) ||
      this.bytes > (this.options.maxBytes ?? 2 * 1024 * 1024)
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= removed.bytes;
      this.discardedThrough = removed.event.sequence;
    }
    for (const wake of this.waiters) wake();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  subscribe(
    args: SubscribeToAgentEvents,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    let after = args.after?.sequence ?? 0;
    let finished = false;
    let reading = false;
    let wake: (() => void) | undefined;
    const finish = () => {
      finished = true;
      if (wake) this.waiters.delete(wake);
      wake?.();
      args.signal?.removeEventListener("abort", finish);
    };
    // Register only while next() is waiting; an abandoned, idle iterator does
    // not install a permanent runtime-owned subscription or a per-client queue.
    const next = async (): Promise<IteratorResult<AgentRuntimeEvent>> => {
      try {
        while (!finished && !args.signal?.aborted) {
          if (after < this.discardedThrough)
            throw new Error(
              `Agent event cursor ${after} expired; replay persisted events through sequence ${this.discardedThrough} before subscribing again`,
            );
          const item = this.events.find(({ event }) => event.sequence > after);
          if (item) {
            after = item.event.sequence;
            return { done: false, value: item.event };
          }
          if (this.closed) break;
          if (this.waiters.size >= 64)
            throw new Error("Too many agent event subscribers");
          await new Promise<void>((resolve) => {
            wake = resolve;
            this.waiters.add(resolve);
            args.signal?.addEventListener("abort", finish, { once: true });
          });
          if (wake) this.waiters.delete(wake);
          wake = undefined;
          args.signal?.removeEventListener("abort", finish);
        }
        finish();
        return { done: true, value: undefined };
      } catch (error) {
        finish();
        throw error;
      }
    };
    return {
      next: () => {
        if (reading)
          return Promise.reject(
            new Error(
              "Only one pending next() is allowed per event subscription",
            ),
          );
        reading = true;
        return next().finally(() => {
          reading = false;
        });
      },
      return: async () => {
        finish();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}
