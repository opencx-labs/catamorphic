import type { CatamorphicCore } from "./core.js";
import { PollPacer } from "./services/work-wakeups.js";

/**
 * Deliver Project Events on a timer: webhooks, chat events and polled
 * events start the workflows bound to them within about a second. Every
 * host that runs workflows starts one. With the host's `idlePollMs` it
 * slows down while nothing arrives, and an event recorded in this process
 * wakes it at once (ADR 0228).
 */
export function startEventDispatcher(input: {
  core: Pick<CatamorphicCore, "dispatchEvents"> &
    Partial<Pick<CatamorphicCore, "wakeups" | "idlePollMs">>;
  pollEveryMs?: number;
  idlePollMs?: number;
}): { stop: () => Promise<void> } {
  const stop = new AbortController();
  const pacer = new PollPacer({
    quickMs: input.pollEveryMs ?? 1_000,
    idleMs: input.idlePollMs ?? input.core.idlePollMs,
    wakeups: input.core.wakeups,
    topic: "events",
  });
  const loop = async () => {
    while (!stop.signal.aborted) {
      const dispatched = await input.core.dispatchEvents().catch((error) => {
        console.warn("[catamorphic] Event dispatch failed", error);
        return 0;
      });
      if (dispatched > 0) pacer.busy();
      if (stop.signal.aborted) return;
      await pacer.wait(stop.signal);
    }
  };
  const pending = loop();
  return {
    stop: async () => {
      stop.abort();
      await pending;
    },
  };
}
