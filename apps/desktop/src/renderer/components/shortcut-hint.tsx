import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 800;

/**
 * Hover popover that teaches a button's keyboard shortcut, or (without a
 * shortcut) acts as the app's standard tooltip. The hint appears after a
 * hover delay and never intercepts the pointer. Use this instead of the
 * native `title` attribute so all hints look and time the same.
 *
 * Rendered through a portal: hosts often sit inside overflow-hidden or
 * transformed containers (bubble pill, sidebar) that would clip an
 * absolutely-positioned popover.
 */
export function ShortcutHint({
  label,
  shortcut,
  side = "bottom",
  delay = SHOW_DELAY_MS,
  children,
}: {
  /** Short action name, e.g. "Toggle sidebar". */
  label: string;
  /** Display form of the shortcut, e.g. "⌘B"; omit for a plain tooltip. */
  shortcut?: string;
  side?: "bottom" | "top";
  /**
   * Hover delay before the hint shows. The 800ms default fits buttons
   * (their meaning is usually guessable); identity hints on icon-only
   * surfaces (chat bubbles) pass a near-zero delay so hovering answers
   * "which one is this" immediately.
   */
  delay?: number;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Drives the enter/exit transition; the element unmounts after the exit
  // transition ends, not when the pointer leaves.
  const [visible, setVisible] = useState(false);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const show = () => {
    if (
      anchorRef.current?.querySelector(
        "[disabled][data-disabled-reason], [aria-disabled=true][data-disabled-reason]",
      )
    )
      return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPosition({
        x: rect.x + rect.width / 2,
        y: side === "bottom" ? rect.bottom + 7 : rect.top - 7,
      });
      // Mount hidden, then flip visible next frame so the transition runs.
      requestAnimationFrame(() => setVisible(true));
    }, delay);
  };

  const showFromFocus = () => {
    clearTimeout(timerRef.current);
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      x: rect.x + rect.width / 2,
      y: side === "bottom" ? rect.bottom + 7 : rect.top - 7,
    });
    requestAnimationFrame(() => setVisible(true));
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only hint anchor; the wrapped control stays the interactive element
    <span
      ref={anchorRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={showFromFocus}
      onBlurCapture={hide}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") hide();
      }}
      // Clicking the wrapped control usually changes state; drop the hint.
      onClickCapture={hide}
    >
      {children}
      {position &&
        createPortal(
          <span
            role="tooltip"
            style={{
              left: position.x,
              top: side === "bottom" ? position.y : undefined,
              bottom:
                side === "top" ? window.innerHeight - position.y : undefined,
            }}
            onTransitionEnd={() => {
              if (!visible) setPosition(null);
            }}
            className={`pointer-events-none fixed z-[400] -translate-x-1/2 whitespace-nowrap rounded-md bg-bg-overlay px-2 py-1 text-[11px] text-fg-muted shadow-lg ring-1 ring-border transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
              visible
                ? "translate-y-0 opacity-100"
                : side === "bottom"
                  ? "translate-y-0.5 opacity-0"
                  : "-translate-y-0.5 opacity-0"
            }`}
          >
            {label}
            {shortcut && (
              <span className="ml-1.5 text-fg-faint">{shortcut}</span>
            )}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Native disabled controls do not reliably dispatch React mouse events.
 * Capture pointer interest once at the document boundary; reasons live next
 * to each disabled condition, and the hint uses the same portal vocabulary.
 */
export function DisabledControlHints() {
  const [hint, setHint] = useState<{
    label: string;
    x: number;
    y: number;
  } | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let target: HTMLElement | null = null;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(showTimer);
      setVisible(false);
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => setHint(null), 200);
      target = null;
    };
    const move = (event: Event) => {
      const next =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              "[disabled][data-disabled-reason], [aria-disabled=true][data-disabled-reason]",
            )
          : null;
      if (next === target) return;
      hide();
      if (!next?.dataset.disabledReason) return;
      target = next;
      const anchor = next;
      showTimer = setTimeout(() => {
        if (
          !anchor.isConnected ||
          !anchor.matches("[disabled], [aria-disabled=true]")
        )
          return;
        clearTimeout(exitTimer);
        const rect = anchor.getBoundingClientRect();
        setHint({
          label: anchor.dataset.disabledReason ?? "",
          x: Math.max(
            148,
            Math.min(window.innerWidth - 148, rect.x + rect.width / 2),
          ),
          y:
            rect.bottom + 40 > window.innerHeight
              ? Math.max(8, rect.top - 44)
              : rect.bottom + 7,
        });
        setVisible(true);
      }, SHOW_DELAY_MS);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerover", move, true);
    document.addEventListener("focusin", move, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(exitTimer);
      document.removeEventListener("pointerover", move, true);
      document.removeEventListener("focusin", move, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return hint
    ? createPortal(
        <span
          role="tooltip"
          style={{ left: hint.x, top: hint.y }}
          className={`pointer-events-none fixed z-[400] w-max max-w-72 -translate-x-1/2 rounded-md bg-bg-overlay px-2 py-1 text-[11px] text-fg-muted shadow-lg ring-1 ring-border transition-opacity duration-200 ${visible ? "animate-fade-in opacity-100" : "opacity-0"}`}
        >
          {hint.label}
        </span>,
        document.body,
      )
    : null;
}
