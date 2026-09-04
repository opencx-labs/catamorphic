import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export const RESOURCE_INSPECTOR_DELAY_MS = 400;
const CLOSE_GRACE_MS = 120;
const VIEWPORT_MARGIN = 8;
const GAP = 8;

export interface InspectorAnchor {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function computeInspectorPosition({
  anchor,
  width,
  height,
  viewportWidth,
  viewportHeight,
}: {
  anchor: InspectorAnchor;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}): { side: "left" | "right"; left: number; top: number } {
  const fitsRight =
    anchor.right + GAP + width <= viewportWidth - VIEWPORT_MARGIN;
  const side: "left" | "right" = fitsRight ? "right" : "left";
  return {
    side,
    left: fitsRight
      ? anchor.right + GAP
      : Math.max(VIEWPORT_MARGIN, anchor.left - width - GAP),
    top: Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.top, viewportHeight - height - VIEWPORT_MARGIN),
    ),
  };
}

export interface ResourceInspectorTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onClick: () => void;
  onFocus: () => void;
  onBlur: (event: React.FocusEvent<HTMLButtonElement>) => void;
  "aria-details"?: string;
}

/**
 * Interactive hover/focus inspector shared by resource switchers. It keeps
 * pointer interest across the trigger-to-portal gap, flips at the viewport
 * edge, remains mounted for its exit motion, and dismisses on Escape.
 */
export function ResourceInspector({
  label,
  children,
  content,
  delayMs = RESOURCE_INSPECTOR_DELAY_MS,
  pinOnClick = false,
  openRequest,
}: {
  label: string;
  children: (props: ResourceInspectorTriggerProps) => ReactNode;
  content: ReactNode;
  delayMs?: number;
  /** Keep the inspector open after clicking its trigger. */
  pinOnClick?: boolean;
  /** Changing this value opens and pins the inspector (palette/status use). */
  openRequest?: number;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const triggerInterested = useRef(false);
  const panelInterested = useRef(false);
  const pointerFocus = useRef(false);
  const pinned = useRef(false);
  const [anchor, setAnchor] = useState<InspectorAnchor | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const show = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    });
    setMounted(true);
    setOpen(true);
  }, []);
  const scheduleOpen = (immediate = false) => {
    clearTimeout(closeTimer.current);
    clearTimeout(openTimer.current);
    if (immediate) show();
    else openTimer.current = setTimeout(show, delayMs);
  };
  const scheduleClose = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (
        !pinned.current &&
        !triggerInterested.current &&
        !panelInterested.current
      )
        setOpen(false);
    }, CLOSE_GRACE_MS);
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      pinned.current = false;
      triggerInterested.current = false;
      panelInterested.current = false;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const dismissForScroll = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-resource-inspector]")
      ) {
        return;
      }
      pinned.current = false;
      triggerInterested.current = false;
      panelInterested.current = false;
      setOpen(false);
    };
    const dismissForPointer = (event: PointerEvent) => {
      if (
        (event.target instanceof Node &&
          triggerRef.current?.contains(event.target)) ||
        (event.target instanceof Element &&
          event.target.closest("[data-resource-inspector]"))
      ) {
        return;
      }
      pinned.current = false;
      triggerInterested.current = false;
      panelInterested.current = false;
      setOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("scroll", dismissForScroll, true);
    window.addEventListener("pointerdown", dismissForPointer);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("scroll", dismissForScroll, true);
      window.removeEventListener("pointerdown", dismissForPointer);
    };
  }, [open]);

  useEffect(() => {
    if (openRequest === undefined || openRequest === 0) return;
    pinned.current = true;
    show();
  }, [openRequest, show]);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <>
      {children({
        ref: triggerRef,
        onPointerEnter: () => {
          triggerInterested.current = true;
          scheduleOpen();
        },
        onPointerLeave: () => {
          triggerInterested.current = false;
          scheduleClose();
        },
        onPointerDown: () => {
          pointerFocus.current = true;
          queueMicrotask(() => {
            pointerFocus.current = false;
          });
        },
        onClick: () => {
          if (!pinOnClick) return;
          pinned.current = !pinned.current;
          if (pinned.current) show();
          else setOpen(false);
        },
        onFocus: () => {
          triggerInterested.current = true;
          if (!pointerFocus.current) scheduleOpen(true);
        },
        onBlur: (event) => {
          if (
            event.relatedTarget instanceof Node &&
            triggerRef.current?.contains(event.relatedTarget)
          )
            return;
          triggerInterested.current = false;
          scheduleClose();
        },
        "aria-details": open ? id : undefined,
      })}
      {mounted && anchor && (
        <InspectorPortal
          id={id}
          label={label}
          anchor={anchor}
          open={open}
          onEnter={() => {
            panelInterested.current = true;
            clearTimeout(closeTimer.current);
          }}
          onLeave={() => {
            panelInterested.current = false;
            scheduleClose();
          }}
          onExited={() => setMounted(false)}
        >
          {content}
        </InspectorPortal>
      )}
    </>
  );
}

function InspectorPortal({
  id,
  label,
  anchor,
  open,
  onEnter,
  onLeave,
  onExited,
  children,
}: {
  id: string;
  label: string;
  anchor: InspectorAnchor;
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onExited: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    side: "left" | "right";
  }>({
    left: anchor.right + GAP,
    top: anchor.top,
    side: "right",
  });
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const updatePosition = () => {
      setPosition(
        computeInspectorPosition({
          anchor,
          width: panel.offsetWidth,
          height: panel.offsetHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    updatePosition();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updatePosition);
    observer?.observe(panel);
    window.addEventListener("resize", updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [anchor]);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(onExited, 180);
    return () => window.clearTimeout(timer);
  }, [open, onExited]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      data-resource-inspector
      data-side={position.side}
      data-testid="resource-inspector"
      style={{ left: position.left, top: position.top }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocusCapture={onEnter}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        onLeave();
      }}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) onExited();
      }}
      className={`fixed z-[130] max-h-[calc(100vh-1rem)] w-80 overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-overlay p-3 shadow-2xl [scrollbar-gutter:stable] ${open ? "animate-pop-in" : "pointer-events-none animate-pop-out"}`}
    >
      {children}
    </div>,
    document.body,
  );
}
