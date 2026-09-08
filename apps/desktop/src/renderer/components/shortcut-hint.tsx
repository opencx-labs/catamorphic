import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  className = "",
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
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Drives the enter/exit transition; the element unmounts after the exit
  // transition ends, not when the pointer leaves.
  const [visible, setVisible] = useState(false);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!position || !tooltip) return;
    const { width, height } = tooltip.getBoundingClientRect();
    const x = Math.max(
      Math.ceil(8 + width / 2),
      Math.min(position.x, Math.floor(window.innerWidth - 8 - width / 2)),
    );
    const y =
      side === "bottom"
        ? Math.max(8, Math.min(position.y, window.innerHeight - height - 8))
        : Math.max(height + 8, Math.min(position.y, window.innerHeight - 8));
    if (x !== position.x || y !== position.y) setPosition({ x, y });
  }, [position, side]);

  const show = () => {
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

  const hide = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only hint anchor; the wrapped control stays the interactive element
    <span
      ref={anchorRef}
      className={`inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      // Clicking the wrapped control usually changes state; drop the hint.
      onClickCapture={hide}
    >
      {children}
      {position &&
        createPortal(
          <span
            ref={tooltipRef}
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
            className={`pointer-events-none fixed z-50 w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 break-words rounded-md bg-bg-overlay px-2 py-1 text-[11px] text-fg-muted shadow-lg ring-1 ring-border transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
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
