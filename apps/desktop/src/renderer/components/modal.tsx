import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { themeStyle, useTheme } from "../lib/theme.js";

export function Modal({
  open,
  onClose,
  children,
  width = 480,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  labelledBy?: string;
}) {
  const theme = useTheme();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || !mounted) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panelRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      // A dialog stacked on top of this one (a confirm inside a settings
      // modal) owns the keys; only the topmost open dialog reacts.
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]',
        ),
      ).filter((element) => !element.closest("[inert]"));
      if (dialogs.at(-1) !== panelRef.current) return;
      // The app-styled select owns Escape/Tab while its top-layer picker is
      // open. Dismiss that picker before dismissing or cycling this dialog.
      if (
        typeof CSS !== "undefined" &&
        CSS.supports?.("selector(select:open)") &&
        panelRef.current?.querySelector("select:open")
      )
        return;
      // A control recording a shortcut owns every key while it is armed.
      if (panelRef.current?.querySelector("[data-keyboard-capture]")) return;
      if (event.key === "Escape") {
        // Claim the key so the expanded chat's window listener ignores it.
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (document.activeElement === panelRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      const activeElement = document.activeElement;
      const focusStayedInModal =
        activeElement === document.body ||
        (activeElement instanceof Node &&
          panelRef.current?.contains(activeElement) === true);
      if (focusStayedInModal && previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, [open, mounted]);

  if (!mounted) return null;
  // Rendered at the body: a "fixed" panel inside a sidebar or a transformed
  // pane would otherwise position itself relative to that pane.
  return createPortal(
    <div
      data-theme={theme?.appearance}
      style={themeStyle(theme)}
      className={`fixed inset-0 z-[100] grid place-items-center transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-0 ${
        open
          ? "pointer-events-auto animate-fade-in"
          : "pointer-events-none animate-fade-out"
      }`}
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName === "fade-out" &&
          !open
        )
          setMounted(false);
      }}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; Escape covers keyboard */}
      <div
        className="absolute inset-0 bg-black/50"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{ width, maxWidth: "calc(100vw - 48px)" }}
        className={`relative max-h-[calc(100dvh-48px)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-bg-raised shadow-2xl outline-none motion-reduce:animate-none ${
          open ? "animate-modal-in" : "animate-modal-out"
        }`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
