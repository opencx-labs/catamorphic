import type { CSSProperties, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 500;
const EXIT_MS = 150;

/**
 * Hover/focus tooltip. Never instant: shows after ~500ms (a tooltip that
 * fires on flyover is noise), fades 150ms, and the exit animates before
 * unmount. Portal-rendered with fixed positioning so overflow-hidden or
 * transformed ancestors can't clip it. Positions above the anchor, flipping
 * below when there's no room.
 *
 * Wraps its child in an inline-flex span used as the measuring anchor.
 */
export function Tooltip({
  label,
  delay = SHOW_DELAY_MS,
  children,
}: {
  /** The tooltip text. */
  label: ReactNode;
  /** Show delay in ms; defaults to 500. */
  delay?: number;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [state, setState] = useState<"closed" | "open" | "closing">("closed");
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });
  const tooltipId = useId();

  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("open"), delay);
  };
  const hide = () => {
    clearTimeout(timerRef.current);
    setState((current) => (current === "open" ? "closing" : "closed"));
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Exit animates before unmount; clock fallback mirrors the CSS duration.
  useEffect(() => {
    if (state !== "closing") return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setState("closed");
    };
    const tip = tipRef.current;
    tip?.addEventListener("animationend", finish);
    const timer = setTimeout(finish, EXIT_MS + 70);
    return () => {
      tip?.removeEventListener("animationend", finish);
      clearTimeout(timer);
    };
  }, [state]);

  // Measure and place once visible (top-centered, flip below if clipped).
  useLayoutEffect(() => {
    if (state === "closed") return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const flip = a.top - t.height - 6 < 4;
    setSide(flip ? "bottom" : "top");
    const left = Math.max(
      4,
      Math.min(
        a.left + a.width / 2 - t.width / 2,
        window.innerWidth - t.width - 4,
      ),
    );
    const top = flip ? a.bottom + 6 : a.top - t.height - 6;
    setPosition({ left, top });
  }, [state]);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/focus
          listeners only relay to the wrapped interactive child; the span
          itself is never operated. */}
      <span
        ref={anchorRef}
        style={{ display: "inline-flex", minWidth: 0 }}
        aria-describedby={state === "open" ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {state !== "closed"
        ? createPortal(
            <div
              ref={tipRef}
              id={tooltipId}
              role="tooltip"
              className="cat-tooltip"
              data-side={side}
              data-state={state === "closing" ? "closing" : undefined}
              style={position}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
