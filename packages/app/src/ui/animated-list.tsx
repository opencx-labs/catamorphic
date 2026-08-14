import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx.js";

/** How long the exit animation runs; the clock fallback for removal. */
const EXIT_MS = 180;

type Entry<T> = {
  key: string;
  item: T;
  /** Newly added since the initial render — gets the enter animation. */
  entering: boolean;
  /** Gone from `items` — plays the exit animation, then leaves the DOM. */
  exiting: boolean;
};

/**
 * Rebuild the rendered entries from the new `items`: live rows take their
 * new order and fresh data, rows gone from `items` stay rendered at their
 * old index — flagged `exiting` so they collapse in place before removal.
 */
function reconcile<T>(
  prev: Entry<T>[],
  items: readonly T[],
  keyOf: (item: T) => string,
): Entry<T>[] {
  const known = new Map(prev.map((entry) => [entry.key, entry]));
  const live = new Set(items.map(keyOf));
  const next: Entry<T>[] = items.map((item) => {
    const key = keyOf(item);
    return { key, item, entering: !known.has(key), exiting: false };
  });
  prev.forEach((entry, index) => {
    if (live.has(entry.key)) return;
    next.splice(Math.min(index, next.length), 0, { ...entry, exiting: true });
  });
  return next;
}

/**
 * Keyed list whose rows follow the host's motion contract: rows added to
 * `items` animate in (fade + rise + height reveal, `cat-row-enter`), and
 * rows removed from `items` animate OUT BEFORE unmount — the departing row
 * stays rendered with `cat-row-exit` (which holds the collapsed frame via
 * `forwards`) and leaves the DOM on `animationend`, with a clock fallback
 * since occluded windows throttle animation events. Rows present on the
 * first render appear without animation — nothing animates on load.
 *
 * The row animations suit one-line rows (~30-50px tall); for larger blocks
 * apply `cat-anim-enter`/`cat-anim-exit` yourself.
 */
export function AnimatedList<T>({
  items,
  getKey,
  renderItem,
  className,
  itemClassName,
}: {
  items: readonly T[];
  /** Stable identity per item — index-derived keys defeat the animations. */
  getKey: (item: T) => string | number;
  renderItem: (item: T) => ReactNode;
  /** Class for the list container (a bare `<ul>`, UA chrome removed). */
  className?: string;
  /** Class for every row wrapper (`<li>`). */
  itemClassName?: string;
}) {
  const keyOf = (item: T) => String(getKey(item));
  const listRef = useRef<HTMLUListElement>(null);
  const [entries, setEntries] = useState<Entry<T>[]>(() =>
    items.map((item) => ({
      key: keyOf(item),
      item,
      entering: false,
      exiting: false,
    })),
  );
  // Adjust rendered entries when `items` changes — during render, so live
  // rows never show a stale frame and departing rows never blink out.
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    setEntries((prev) => reconcile(prev, items, keyOf));
  }

  // One delegated NATIVE animationend listener removes exited rows (React's
  // synthetic animation events don't fire everywhere; same reason Dialog
  // listens natively). Only direct children count — an animation ending
  // inside a row's own content must not unmount the row.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onAnimationEnd = (event: AnimationEvent) => {
      const row = event.target;
      if (!(row instanceof HTMLElement) || row.parentElement !== list) return;
      const key = row.dataset.key;
      if (row.dataset.exiting !== "true" || key === undefined) return;
      setEntries((prev) => prev.filter((entry) => entry.key !== key));
    };
    list.addEventListener("animationend", onAnimationEnd);
    return () => list.removeEventListener("animationend", onAnimationEnd);
  }, []);

  // Clock fallback: drop every exiting row if animationend never arrives
  // (occluded windows throttle animation events).
  useEffect(() => {
    if (!entries.some((entry) => entry.exiting)) return;
    const timer = setTimeout(
      () => setEntries((prev) => prev.filter((entry) => !entry.exiting)),
      EXIT_MS + 70,
    );
    return () => clearTimeout(timer);
  }, [entries]);

  return (
    <ul ref={listRef} className={cx("cat-anim-list", className)}>
      {entries.map((entry) => (
        <li
          key={entry.key}
          data-key={entry.key}
          data-exiting={entry.exiting || undefined}
          className={cx(
            itemClassName,
            entry.exiting
              ? "cat-row-exit"
              : entry.entering
                ? "cat-row-enter"
                : false,
          )}
          aria-hidden={entry.exiting || undefined}
        >
          {renderItem(entry.item)}
        </li>
      ))}
    </ul>
  );
}
