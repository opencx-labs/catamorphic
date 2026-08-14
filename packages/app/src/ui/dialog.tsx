import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx.js";

const FOCUSABLE =
  "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled])," +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** How long the closing animation runs; the clock fallback for unmount. */
const EXIT_MS = 180;

/**
 * Modal dialog, controlled through `open`/`onClose`. Portals to
 * `document.body`; `role="dialog"` + `aria-modal`, focus is trapped inside
 * and restored to the opener on close; Esc closes, overlay click closes
 * unless `closeOnOverlayClick={false}`.
 *
 * Motion follows the shell contract: enter 220ms fade + 4px rise + 98%
 * scale, exit the 180ms mirror — and the exit ANIMATES BEFORE UNMOUNT: the
 * dialog stays mounted through the closing animation and is removed on
 * `animationend` (with a clock fallback, since occluded windows throttle
 * animation events).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  closeOnOverlayClick = true,
  className,
}: {
  open: boolean;
  /** Called for every close intent (Esc, overlay click, your own buttons). */
  onClose: () => void;
  /** Dialog heading; also labels the dialog for assistive tech. */
  title?: ReactNode;
  /** Muted line under the title; wired to `aria-describedby`. */
  description?: ReactNode;
  children?: ReactNode;
  /** Footer slot — actions right-aligned. */
  footer?: ReactNode;
  /** Set false for confirm-style dialogs that must not dismiss on a stray click. */
  closeOnOverlayClick?: boolean;
  /** Extra class for the panel (e.g. to widen it). */
  className?: string;
}) {
  const [present, setPresent] = useState(open);
  const closing = present && !open;
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (open) setPresent(true);
  }, [open]);

  // Capture the opener and move focus in when the dialog appears.
  useEffect(() => {
    if (!open || !present) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    first?.focus();
  }, [open, present]);

  // Exit: unmount after the closing animation, then restore focus.
  useEffect(() => {
    if (!closing) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setPresent(false);
      openerRef.current?.focus();
    };
    const panel = panelRef.current;
    panel?.addEventListener("animationend", finish);
    const timer = setTimeout(finish, EXIT_MS + 70);
    return () => {
      panel?.removeEventListener("animationend", finish);
      clearTimeout(timer);
    };
  }, [closing]);

  if (!present) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // Focus trap: Tab wraps within the panel's focusables.
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return createPortal(
    // The root listens for Esc and the Tab focus trap as they bubble from
    // the panel's controls; it is never itself the focus target.
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div
      className="cat-dialog-root"
      data-state={closing ? "closing" : "open"}
      onKeyDown={onKeyDown}
    >
      <div className="cat-dialog-overlay" aria-hidden="true" />
      <div
        className="cat-dialog"
        onPointerDown={(event) => {
          if (closeOnOverlayClick && event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title != null ? titleId : undefined}
          aria-describedby={description != null ? descriptionId : undefined}
          tabIndex={-1}
          className={cx("cat-dialog-panel", className)}
        >
          {title != null ? (
            <h2 className="cat-dialog-title" id={titleId}>
              {title}
            </h2>
          ) : null}
          {description != null ? (
            <p className="cat-dialog-desc" id={descriptionId}>
              {description}
            </p>
          ) : null}
          {children}
          {footer != null ? (
            <div className="cat-dialog-footer">{footer}</div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
