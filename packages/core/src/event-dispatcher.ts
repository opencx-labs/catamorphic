import type { CatamorphicCore } from "./core.js";

/**
 * Deliver Project Events on a timer: webhooks, chat events and GitHub
 * events start the workflows bound to them within about a second. Every
 * host that runs workflows starts one.
 */
export function startEventDispatcher(input: {
  core: Pick<CatamorphicCore, "dispatchEvents">;
  pollEveryMs?: number;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await input.core.dispatchEvents().catch((error) => {
      console.warn("[catamorphic] Event dispatch failed", error);
    });
    if (stopped) return;
    timer = setTimeout(() => {
      pending = tick();
    }, input.pollEveryMs ?? 1_000);
    timer.unref?.();
  };
  let pending = tick();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}
