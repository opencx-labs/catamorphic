import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Fixed-height rows keep large file lists bounded without measuring each file. */
export function LazyList<T>({
  items,
  itemKey,
  renderItem,
  label,
  rowHeight = 28,
  maxHeight = 336,
  overscan = 5,
  className = "",
  scrollToIndex,
}: {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  label: string;
  rowHeight?: number;
  maxHeight?: number;
  overscan?: number;
  className?: string;
  /** Reveal an externally selected row without moving keyboard focus. */
  scrollToIndex?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (focusIndex === null) return;
    viewport.current
      ?.querySelector<HTMLElement>(
        `[data-windowed-index="${focusIndex}"] button, [data-windowed-index="${focusIndex}"] a`,
      )
      ?.focus({ preventScroll: true });
  }, [focusIndex]);
  const height = Math.min(items.length * rowHeight, maxHeight);
  const visibleCount = Math.ceil(height / rowHeight);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (
      node &&
      node.scrollTop > Math.max(0, items.length * rowHeight - height)
    ) {
      node.scrollTop = Math.max(0, items.length * rowHeight - height);
      setScrollTop(node.scrollTop);
    }
  }, [items.length, rowHeight, height]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (
      !node ||
      scrollToIndex === undefined ||
      scrollToIndex < 0 ||
      scrollToIndex >= items.length
    )
      return;
    const top = scrollToIndex * rowHeight;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowHeight > node.scrollTop + height)
      node.scrollTop = top + rowHeight - height;
    setScrollTop(node.scrollTop);
  }, [scrollToIndex, rowHeight, height, items.length]);
  const start = Math.max(
    0,
    Math.min(
      Math.floor(scrollTop / rowHeight) - overscan,
      Math.max(0, items.length - visibleCount - overscan * 2),
    ),
  );
  const end = Math.min(items.length, start + visibleCount + overscan * 2);
  return (
    <section
      ref={viewport}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll regions need keyboard access even when rows are read-only.
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          ![
            "ArrowDown",
            "ArrowUp",
            "Home",
            "End",
            "PageDown",
            "PageUp",
          ].includes(event.key)
        )
          return;
        if (!(event.target instanceof HTMLElement)) return;
        const row = event.target.closest<HTMLElement>("[data-windowed-index]");
        if (!row) return;
        const current = Number(row.dataset.windowedIndex);
        const proposed =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : current +
                (event.key === "ArrowUp"
                  ? -1
                  : event.key === "ArrowDown"
                    ? 1
                    : event.key === "PageUp"
                      ? -visibleCount
                      : visibleCount);
        const next = Math.max(0, Math.min(items.length - 1, proposed));
        event.preventDefault();
        event.stopPropagation();
        const top = next * rowHeight;
        if (top < event.currentTarget.scrollTop)
          event.currentTarget.scrollTop = top;
        else if (top + rowHeight > event.currentTarget.scrollTop + height)
          event.currentTarget.scrollTop = top + rowHeight - height;
        setScrollTop(event.currentTarget.scrollTop);
        setFocusIndex(next);
      }}
      className={`overflow-auto overscroll-contain focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${className}`}
      data-lazy-list
      style={{ maxHeight, height }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: items.length * rowHeight, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: start * rowHeight,
            left: 0,
            right: 0,
          }}
        >
          {items.slice(start, end).map((item, index) => (
            <div
              key={itemKey(item)}
              data-windowed-index={start + index}
              style={{ height: rowHeight }}
            >
              {renderItem(item, start + index)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
