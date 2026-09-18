import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const EXIT_MS = 150;

/**
 * Internal anchored popover used by the date pickers. Portal + fixed
 * positioning (immune to overflow clipping), opens below the anchor and
 * flips above when there's no room, 150ms fade + 2px slide from its side,
 * exit animates before unmount. Closes on outside pointerdown and Esc.
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  children,
  align = "start",
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  // Height follows the content through a transition once the first
  // measurement has landed, so late-loading content grows the panel
  // instead of snapping it.
  const [height, setHeight] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const closing = present && !open;
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });

  useEffect(() => {
    if (open) setPresent(true);
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setPresent(false);
    };
    const pop = popRef.current;
    pop?.addEventListener("animationend", finish);
    const timer = setTimeout(finish, EXIT_MS + 70);
    return () => {
      pop?.removeEventListener("animationend", finish);
      clearTimeout(timer);
    };
  }, [closing]);

  useLayoutEffect(() => {
    if (!present) {
      setHeight(null);
      setSettled(false);
      return;
    }
    const node = contentRef.current;
    const pop = popRef.current;
    if (!node || !pop || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const style = getComputedStyle(pop);
      setHeight(
        node.offsetHeight +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth),
      );
    };
    measure();
    const frame = requestAnimationFrame(() => setSettled(true));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [present]);

  // Place relative to the anchor; re-place on resize, (captured) scroll and
  // the panel's own growth.
  useLayoutEffect(() => {
    if (!present) return;
    const place = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const a = anchor.getBoundingClientRect();
      const p = pop.getBoundingClientRect();
      const flip =
        a.bottom + p.height + 4 > window.innerHeight - 4 &&
        a.top - p.height - 4 > 4;
      setSide(flip ? "top" : "bottom");
      const left = Math.max(
        4,
        Math.min(
          align === "end" ? a.right - p.width : a.left,
          window.innerWidth - p.width - 4,
        ),
      );
      const top = flip ? a.top - p.height - 4 : a.bottom + 4;
      setPosition({ left, top });
    };
    place();
    const controller = new AbortController();
    const pop = popRef.current;
    const observer =
      pop && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(place)
        : undefined;
    if (pop) observer?.observe(pop);
    controller.signal.addEventListener("abort", () => observer?.disconnect());
    window.addEventListener("resize", place, { signal: controller.signal });
    window.addEventListener("scroll", place, {
      signal: controller.signal,
      capture: true,
    });
    return () => controller.abort();
  }, [present, align, anchorRef]);

  // Outside pointerdown / Esc close — only while actually open.
  useEffect(() => {
    if (!open || !present) return;
    const controller = new AbortController();
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target as Node;
        if (popRef.current?.contains(target)) return;
        if (anchorRef.current?.contains(target)) return;
        onClose();
      },
      { signal: controller.signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") onClose();
      },
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [open, present, onClose, anchorRef]);

  if (!present) return null;
  return createPortal(
    <div
      ref={popRef}
      className="cat-popover"
      data-side={side}
      data-state={closing ? "closing" : undefined}
      data-settled={settled || undefined}
      style={{ ...position, height: height ?? undefined }}
    >
      <div ref={contentRef}>{children}</div>
    </div>,
    document.body,
  );
}
