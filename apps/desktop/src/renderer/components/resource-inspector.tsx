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
import { themeStyle, useTheme } from "../lib/theme.js";

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
  placement = "side",
}: {
  anchor: InspectorAnchor;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * "side" flips left/right of the anchor. "above" stacks over it (below
   * when there is no room), left-aligned, so a wide panel never lands on
   * the anchor's own controls such as a pill's remove button.
   */
  placement?: "side" | "above";
}): { side: "left" | "right"; left: number; top: number } {
  if (placement === "above") {
    const fitsAbove = anchor.top - GAP - height >= VIEWPORT_MARGIN;
    return {
      side: "right",
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(anchor.left, viewportWidth - width - VIEWPORT_MARGIN),
      ),
      top: fitsAbove
        ? anchor.top - GAP - height
        : Math.min(
            anchor.bottom + GAP,
            viewportHeight - height - VIEWPORT_MARGIN,
          ),
    };
  }
  const fitsRight =
    anchor.right + GAP + width <= viewportWidth - VIEWPORT_MARGIN;
  const side: "left" | "right" = fitsRight ? "right" : "left";
  return {
    side,
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        fitsRight ? anchor.right + GAP : anchor.left - width - GAP,
        viewportWidth - width - VIEWPORT_MARGIN,
      ),
    ),
    top: Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.top, viewportHeight - height - VIEWPORT_MARGIN),
    ),
  };
}

export interface ResourceInspectorTriggerProps<
  T extends HTMLElement = HTMLButtonElement,
> {
  ref: RefObject<T | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onClick: () => void;
  onFocus: () => void;
  onBlur: (event: React.FocusEvent<T>) => void;
  "aria-details"?: string;
}

/**
 * Interactive hover/focus inspector shared by resource switchers. It keeps
 * pointer interest across the trigger-to-portal gap, flips at the viewport
 * edge, remains mounted for its exit motion, and dismisses on Escape.
 */
export function ResourceInspector<T extends HTMLElement = HTMLButtonElement>({
  label,
  children,
  content,
  delayMs = RESOURCE_INSPECTOR_DELAY_MS,
  pinOnClick = false,
  openRequest,
  onOpen,
  disabled = false,
  testId,
  placement = "side",
}: {
  label: string;
  disabled?: boolean;
  testId?: string;
  /** Where the panel sits relative to its trigger; see computeInspectorPosition. */
  placement?: "side" | "above";
  children: (props: ResourceInspectorTriggerProps<T>) => ReactNode;
  content: ReactNode | ((dismiss: () => void) => ReactNode);
  delayMs?: number;
  /** Keep the inspector open after clicking its trigger. */
  pinOnClick?: boolean;
  /** Changing this value opens and pins the inspector (palette/status use). */
  openRequest?: number;
  onOpen?: () => void;
}) {
  const id = useId();
  const triggerRef = useRef<T>(null);
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
  const dragging = useRef(false);
  const [anchor, setAnchor] = useState<InspectorAnchor | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  const show = useCallback(() => {
    if (dragging.current || disabled) return;
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
  }, [disabled]);
  useEffect(() => {
    if (!disabled) return;
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setOpen(false);
    setMounted(false);
  }, [disabled]);
  useEffect(() => {
    const start = () => {
      dragging.current = true;
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      pinned.current = false;
      triggerInterested.current = false;
      panelInterested.current = false;
      setOpen(false);
      setMounted(false);
    };
    const end = () => {
      dragging.current = false;
    };
    document.addEventListener("dragstart", start, true);
    document.addEventListener("dragend", end, true);
    document.addEventListener("drop", end, true);
    return () => {
      document.removeEventListener("dragstart", start, true);
      document.removeEventListener("dragend", end, true);
      document.removeEventListener("drop", end, true);
    };
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
      event.stopPropagation();
      pinned.current = false;
      triggerInterested.current = false;
      panelInterested.current = false;
      setOpen(false);
      pointerFocus.current = true;
      triggerRef.current?.focus();
      pointerFocus.current = false;
      clearTimeout(openTimer.current);
    };
    const dismissForScroll = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-resource-inspector]")
      ) {
        return;
      }
      // A sibling transcript or terminal can scroll while this trigger stays
      // still. Only scrolling an ancestor can detach the preview's anchor.
      if (
        event.target instanceof Element &&
        !event.target.contains(triggerRef.current)
      ) {
        return;
      }
      // Keyboard focus scrolls offscreen links into view asynchronously. Keep
      // their preview attached instead of immediately dismissing it on that scroll.
      if (triggerRef.current?.contains(document.activeElement)) {
        show();
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
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("scroll", dismissForScroll, true);
    window.addEventListener("pointerdown", dismissForPointer);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("scroll", dismissForScroll, true);
      window.removeEventListener("pointerdown", dismissForPointer);
    };
  }, [open, show]);

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
          if (!pinOnClick) {
            clearTimeout(openTimer.current);
            clearTimeout(closeTimer.current);
            setOpen(false);
            return;
          }
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
          testId={testId}
          id={id}
          label={label}
          anchor={anchor}
          placement={placement}
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
          {typeof content === "function"
            ? content(() => {
                clearTimeout(openTimer.current);
                clearTimeout(closeTimer.current);
                pinned.current = false;
                triggerInterested.current = false;
                panelInterested.current = false;
                setOpen(false);
              })
            : content}
        </InspectorPortal>
      )}
    </>
  );
}

export function InspectorPortal({
  testId = "resource-inspector",
  id,
  label,
  anchor,
  placement = "side",
  open,
  onEnter,
  onLeave,
  onExited,
  children,
}: {
  testId?: string;
  id: string;
  label: string;
  anchor: InspectorAnchor;
  placement?: "side" | "above";
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onExited: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Portaled to the body, the panel keeps the theme of the scope it opened in.
  const theme = useTheme();
  // The panel's height follows its content through a transition, so async
  // sections that arrive after the popover opens grow it instead of
  // snapping it. The first measurement lands before paint, untransitioned.
  const [height, setHeight] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    const node = content.current;
    const panel = ref.current;
    if (!node || !panel) return;
    // Border-box height: content plus the panel's own padding and border,
    // so the measured height never leaves a sliver that scrolls.
    const chrome = () => {
      const style = getComputedStyle(panel);
      return (
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth)
      );
    };
    const measure = () => setHeight(node.offsetHeight + chrome());
    measure();
    const frame = requestAnimationFrame(() => setSettled(true));
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, []);
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
          placement,
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
  }, [anchor, placement]);

  useEffect(() => {
    if (open) return;
    for (const media of ref.current?.querySelectorAll("audio, video") ?? []) {
      if (media instanceof HTMLMediaElement) media.pause();
    }
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
      data-testid={testId}
      data-open={open || undefined}
      aria-hidden={!open}
      inert={!open}
      data-theme={theme?.appearance}
      style={{
        ...themeStyle(theme),
        left: position.left,
        top: position.top,
        height: height ?? undefined,
      }}
      data-settled={settled || undefined}
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
        if (
          event.target === event.currentTarget &&
          event.animationName.startsWith("inspector-out-") &&
          !open
        )
          onExited();
      }}
      className={`fixed z-[130] max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] w-80 overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-overlay p-3 shadow-2xl [scrollbar-gutter:stable] ${settled ? "transition-[height,top] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none" : ""} ${open ? `animate-inspector-in-${position.side}` : `pointer-events-none opacity-0 animate-inspector-out-${position.side}`}`}
    >
      <div ref={content}>{children}</div>
    </div>,
    document.body,
  );
}
