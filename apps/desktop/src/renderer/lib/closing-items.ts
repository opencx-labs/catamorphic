import { useEffect, useReducer, useRef } from "react";

/** How long an item that left stays mounted, closing: past any close tween. */
export const CLOSING_MS = 400;

/**
 * The items to show, each with whether it is still there: one that left
 * stays, in its place and unchanged, for `closingMs`, so its card closes
 * instead of vanishing (a question answered, its panel shrinking away
 * while the answer arrives in the conversation). It comes back at once if
 * it returns meanwhile.
 */
export function useClosingItems<T extends { id: string }>(
  items: readonly T[],
  closingMs = CLOSING_MS,
  playing?: (id: string) => boolean,
): Array<{ item: T; present: boolean }> {
  /** The latest version of every item shown, in the order they show. */
  const shown = useRef(new Map<string, T>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const motion = useRef(playing);
  motion.current = playing;
  const [, removed] = useReducer((count: number) => count + 1, 0);
  const present = new Set(items.map((item) => item.id));
  for (const item of items) shown.current.set(item.id, item);

  useEffect(() => {
    for (const id of shown.current.keys()) {
      const timer = timers.current.get(id);
      if (present.has(id)) {
        if (timer !== undefined) clearTimeout(timer);
        timers.current.delete(id);
      } else if (timer === undefined) {
        // A busy renderer may only start the transition after this timer.
        // Keep the snapshot until its actual exit settles, with a bound
        // for a surface that stays hidden or never reports completion.
        const deadline = performance.now() + closingMs + 2_000;
        const finish = () => {
          if (motion.current?.(id) && performance.now() < deadline) {
            timers.current.set(id, setTimeout(finish, 50));
            return;
          }
          timers.current.delete(id);
          shown.current.delete(id);
          removed();
        };
        timers.current.set(id, setTimeout(finish, closingMs));
      }
    }
  });
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  return [...shown.current.values()].map((item) => ({
    item,
    present: present.has(item.id),
  }));
}
