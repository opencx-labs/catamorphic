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
  const [present, setPresent] = useState(open);
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

  // Place relative to the anchor; re-place on resize and (captured) scroll.
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
      style={position}
    >
      {children}
    </div>,
    document.body,
  );
}
