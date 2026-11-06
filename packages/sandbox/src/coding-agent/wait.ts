/** What a tool's result says when a wait in it was ended early (ADR 0264). */
export const STOPPED_WAITING_NOTE =
  "Work ended any wait here early because something reached you in this chat (a message or a task's notification, which follows this result) or your turn is stopping. Wait again afterwards if you still need to.";

/** How a {@link waitUntil} ended. */
export type WaitOutcome = "ready" | "timeout" | "stopped";

/**
 * The one way an agent's tool waits (ADR 0264): until `ready` holds, the
 * time runs out, or `stopWaiting` fires because something reached the
 * agent that it reads only once the tool returns. `ready` is checked at
 * once, then every `pollMs`, and wins over the other two.
 */
export async function waitUntil(input: {
  ready: () => boolean | Promise<boolean>;
  timeoutMs: number;
  stopWaiting: AbortSignal;
  pollMs?: number;
}): Promise<WaitOutcome> {
  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  const pollMs = Math.max(1, input.pollMs ?? 250);
  for (;;) {
    if (await input.ready()) return "ready";
    if (input.stopWaiting.aborted) return "stopped";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        input.stopWaiting.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(pollMs, remaining));
      input.stopWaiting.addEventListener("abort", done, { once: true });
    });
  }
}
