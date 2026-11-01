"use client";

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

interface WindowRow {
  key: string;
  kind: string;
  focused?: boolean;
}
const MIN_OVERSCAN = 1600;
const WINDOW_AFTER = 96;
const VIEWPORT_STEP = 200;

/**
 * Steps share the conversation's scroller. Distant closed headers leave their
 * measured space behind; opened details and interaction stay mounted. Rows are
 * direct keyed siblings, so inserting earlier work never reparents a live row.
 */
export function StepWindow<T extends WindowRow>({
  rows,
  opened,
  sizes,
  active,
  className,
  render,
}: {
  rows: T[];
  opened: ReadonlySet<string>;
  sizes: RefObject<Map<string, number>>;
  active: boolean;
  className: string;
  render: (row: T) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [viewportState] = useState(stepViewport);
  const viewport = useSyncExternalStore(
    viewportState.subscribe,
    viewportState.read,
    viewportState.read,
  );
  const setViewport = viewportState.update;
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [destination, setDestination] = useState<{
    key: string;
    last: boolean;
  }>();
  const update = useRef(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const windowed = rows.length > WINDOW_AFTER;
  const pressed = useRef<Element | null>(null);
  const pointerCleanup = useRef<(() => void) | undefined>(undefined);
  const focusedKey = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!active || !windowed) return () => {};
        document.addEventListener("focusin", listener);
        document.addEventListener("focusout", listener);
        return () => {
          document.removeEventListener("focusin", listener);
          document.removeEventListener("focusout", listener);
        };
      },
      [active, windowed],
    ),
    useCallback(() => {
      if (
        !active ||
        !windowed ||
        !box.current?.contains(document.activeElement)
      )
        return undefined;
      return document.activeElement
        ?.closest("[data-step-key]")
        ?.getAttribute("data-step-key");
    }, [active, windowed]),
    () => undefined,
  );
  const selected = useSyncExternalStore(
    useCallback(
      (listener) => {
        if (!active || !windowed) return () => {};
        document.addEventListener("selectionchange", listener);
        return () => document.removeEventListener("selectionchange", listener);
      },
      [active, windowed],
    ),
    useCallback(() => {
      if (!active || !windowed) return "[]";
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return "[]";
      // Read existing browser selection before the first windowed commit can
      // prune it, including every intersecting row rather than just endpoints.
      return JSON.stringify(
        [
          ...(box.current?.querySelectorAll<HTMLElement>("[data-step-key]") ??
            []),
        ]
          .filter((row) => selection.containsNode(row, true))
          .map((row) => row.dataset.stepKey!),
      );
    }, [active, windowed]),
    () => "[]",
  );
  const selectedKeys = useMemo(
    () => new Set<string>(JSON.parse(selected)),
    [selected],
  );
  const offsets = [0];
  for (const row of rows)
    offsets.push(
      offsets[offsets.length - 1]! +
        (sizes.current.get(row.key) ?? (row.kind === "note" ? 28 : 22.5)),
    );

  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !windowed) return;
    let scroller: HTMLElement | null = node.parentElement;
    while (scroller) {
      if (/^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY)) break;
      scroller = scroller.parentElement;
    }
    const read = () => {
      if (!activeRef.current) return;
      const bounds = node.getBoundingClientRect();
      const view = scroller?.getBoundingClientRect();
      if (!node.getClientRects().length || (view && !view.height)) return;
      // A floating chat may be scaling during its entrance. Both positions
      // and measured row heights must stay in untransformed layout units.
      const layoutHeight = scroller ? blockSize(getComputedStyle(scroller)) : 0;
      const scale = view && layoutHeight ? view.height / layoutHeight : 1;
      // Chromium can composite wheel input before its scroll event arrives.
      // Keep a few screens ready while mounting remains independent of history.
      const overscan = Math.max(
        MIN_OVERSCAN,
        2 * (layoutHeight || window.innerHeight),
      );
      const top =
        Math.floor(
          (((view?.top ?? 0) - bounds.top) / scale - overscan) / VIEWPORT_STEP,
        ) * VIEWPORT_STEP;
      const bottom =
        Math.ceil(
          (((view?.bottom ?? window.innerHeight) - bounds.top) / scale +
            overscan) /
            VIEWPORT_STEP,
        ) * VIEWPORT_STEP;
      setViewport((before) =>
        before.top === top && before.bottom === bottom
          ? before
          : { top, bottom },
      );
    };
    update.current = read;
    // Browser geometry is external state. Publish it in the scroll event so
    // React can fill the next main-thread frame without an extra animation frame.
    (scroller ?? window).addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(scroller ?? document.documentElement);
    if (scroller?.firstElementChild)
      observer.observe(scroller.firstElementChild);
    read();
    return () => {
      update.current = () => {};
      observer.disconnect();
      (scroller ?? window).removeEventListener("scroll", read);
    };
  }, [windowed, setViewport]);

  // Refresh before paint when a retained list opens or its host shows again.
  useLayoutEffect(() => {
    if (active) update.current();
  }, [active]);

  const preserve = useCallback(() => {
    const node = box.current;
    if (!node) return;
    const next = new Set<string>();
    const pressedKey = pressed.current
      ?.closest("[data-step-key]")
      ?.getAttribute("data-step-key");
    if (pressedKey) next.add(pressedKey);
    setHeld((before) =>
      before.size === next.size && [...next].every((key) => before.has(key))
        ? before
        : next,
    );
  }, []);
  useLayoutEffect(() => () => pointerCleanup.current?.(), []);

  // One persistent observer supplies every row measurement in layout units.
  // Mixing CSS serialization or transformed rectangles with its precise sizes
  // can alternate fractional values and keep an idle list rendering forever.
  const measuredRows = useRef(new Set<Element>());
  const measurement = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    if (!windowed) return;
    const observer = new ResizeObserver((entries) => {
      if (!activeRef.current) return;
      let changed = false;
      for (const entry of entries) {
        const size = entry.borderBoxSize[0];
        if (!size?.inlineSize) continue;
        const row = entry.target as HTMLElement;
        const style = getComputedStyle(row);
        const height =
          size.blockSize +
          (Number.parseFloat(style.marginTop) || 0) +
          (Number.parseFloat(style.marginBottom) || 0);
        const key = row.dataset.stepKey!;
        if (sizes.current.get(key) === height) continue;
        sizes.current.set(key, height);
        changed = true;
      }
      if (changed) {
        setViewport((before) => ({ ...before }));
        update.current();
      }
    });
    measurement.current = observer;
    return () => {
      observer.disconnect();
      measurement.current = null;
      measuredRows.current.clear();
    };
  }, [windowed, sizes, setViewport]);
  useLayoutEffect(() => {
    const observer = measurement.current;
    if (!observer) return;
    const current = new Set(
      activeRef.current ? box.current?.querySelectorAll("[data-step-key]") : [],
    );
    for (const row of measuredRows.current) {
      if (!current.has(row)) observer.unobserve(row);
    }
    for (const row of current) {
      if (!measuredRows.current.has(row)) observer.observe(row);
    }
    measuredRows.current = current;
  });

  useLayoutEffect(() => {
    if (!destination) return;
    const row = [
      ...(box.current?.querySelectorAll<HTMLElement>("[data-step-key]") ?? []),
    ].find((node) => node.dataset.stepKey === destination.key);
    const controls = row?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href]",
    );
    const target = destination.last
      ? controls?.[controls.length - 1]
      : controls?.[0];
    // The focus snapshot reads the new browser focus in the render that clears
    // destination, keeping this handoff atomic even across event priorities.
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest", behavior: "instant" });
    setDestination(undefined);
  }, [destination]);

  const children: ReactNode[] = [];
  for (let index = 0; index < rows.length; ) {
    const row = rows[index]!;
    const visible = (at: number) => {
      const item = rows[at]!;
      return (
        !windowed ||
        item.focused ||
        opened.has(item.key) ||
        focusedKey === item.key ||
        selectedKeys.has(item.key) ||
        held.has(item.key) ||
        destination?.key === item.key ||
        (offsets[at + 1]! >= viewport.top && offsets[at]! <= viewport.bottom)
      );
    };
    if (visible(index)) {
      children.push(render(row));
      index++;
      continue;
    }
    const start = index++;
    while (index < rows.length && !visible(index)) index++;
    const last = rows[index - 1]!;
    children.push(
      <div
        key={`gap:${row.key}`}
        data-step-gap=""
        className="relative shrink-0"
        style={{
          height: offsets[index]! - offsets[start]!,
          overflowAnchor: "none",
        }}
      >
        <button
          type="button"
          className="sr-only top-0"
          aria-label="Continue through steps"
          onFocus={() => setDestination({ key: row.key, last: false })}
        />
        <button
          type="button"
          className="sr-only bottom-0"
          aria-label="Continue backward through steps"
          onFocus={() => setDestination({ key: last.key, last: true })}
        />
      </div>,
    );
  }
  return (
    <div
      ref={box}
      data-testid="chat-step-window"
      aria-live="off"
      className={className}
      onPointerDown={(event) => {
        if (!active) return;
        pointerCleanup.current?.();
        pressed.current = event.target instanceof Element ? event.target : null;
        preserve();
        const release = () => {
          pointerCleanup.current?.();
          preserve();
        };
        // Only an active gesture owns global release listeners, including when
        // a small list crosses the windowing threshold before the pointer lifts.
        pointerCleanup.current = () => {
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", release);
          pressed.current = null;
          pointerCleanup.current = undefined;
        };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
      }}
    >
      {children}
    </div>
  );
}

/** The scroller's fractional border box before transforms. offsetHeight rounds
 * this size, which makes long-list viewport coordinates drift while scaling. */
function blockSize(style: CSSStyleDeclaration): number {
  const height = Number.parseFloat(style.height);
  return style.boxSizing === "border-box"
    ? height
    : height +
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0) +
        (Number.parseFloat(style.borderTopWidth) || 0) +
        (Number.parseFloat(style.borderBottomWidth) || 0);
}

/** Cached snapshots make browser layout updates synchronous without a second
 * scroll controller or an imperative React render flush. */
function stepViewport() {
  let current = { top: 0, bottom: 0 };
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(change: (before: typeof current) => typeof current) {
      const next = change(current);
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}
