import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { appIsMovingFocus, onPagePress } from "../lib/app-focus.js";
import { themeStyle, useTheme } from "../lib/theme.js";
import { anchorGone } from "./menu.js";

export const RESOURCE_INSPECTOR_DELAY_MS = 400;
const CLOSE_GRACE_MS = 120;
/** Rest on a trigger this long before its panel's reads start. */
const WARM_DELAY_MS = 120;
/** The longest a panel waits, unseen, for reads its content says are due. */
export const SETTLE_MAX_MS = 250;

type InspectorInput = "pointer" | "focus";
type InspectorHold =
  | `${"trigger" | "panel"}-${InspectorInput}`
  // Something the panel opened over itself, such as its overflow menu.
  | "panel-child";
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

/** Elements a press on which belongs to an open menu, not to the panel. */
const MENU_PRESS = "[data-sidebar-menu], [data-menu-shield]";

const InspectorHoldContext = createContext<((held: boolean) => void) | null>(
  null,
);

/**
 * Keeps the inspector this renders in open while `held`: for a menu the
 * panel opens over itself (MenuPortal), from opening until it has exited,
 * so a picked action runs while the panel is still there. The menu's
 * shield covers the panel, so the pointer leaves it, and the press that
 * closes the menu lands on the shield; neither closes the panel, and
 * Escape closes the menu first. When the menu has gone, the panel stays
 * only if the pointer or focus rests on it again.
 */
export function useHoldInspector(held: boolean): void {
  const hold = useContext(InspectorHoldContext);
  useEffect(() => {
    if (!held || !hold) return;
    hold(true);
    return () => hold(false);
  }, [held, hold]);
}

const InspectorPendingContext = createContext<
  ((key: string, pending: boolean) => void) | null
>(null);

/**
 * Says a read the panel shows has not landed yet and would change its
 * size when it does (a list). The panel waits for it, unseen, before it
 * appears, at most SETTLE_MAX_MS, so it opens at its size. Reported before
 * paint, so a panel whose reads are cached appears at once.
 */
export function useInspectorPending(pending: boolean): void {
  const report = useContext(InspectorPendingContext);
  const key = useId();
  useLayoutEffect(() => {
    if (!report) return;
    report(key, pending);
    return () => report(key, false);
  }, [report, key, pending]);
}

/**
 * Keyboard focus leads: focus that Tab or the arrows moved, not the focus
 * a pressed button takes or a menu hands back after a press. Only that
 * holds a panel open (DESIGN.md, "Pointer and focus hold an inspector
 * independently").
 */
function keyboardLeads(target: EventTarget | null): boolean {
  const modality = document.documentElement.dataset.focusModality;
  if (modality) return modality === "keyboard";
  return target instanceof Element && target.matches(":focus-visible");
}

export interface ResourceInspectorTriggerProps<
  T extends HTMLElement = HTMLButtonElement,
> {
  ref: RefObject<T | null>;
  /** Where the pointer entered, when spread onto the trigger. */
  onPointerEnter: (event?: { clientX: number; clientY: number }) => void;
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
  anchorRef,
  warmup,
}: {
  label: string;
  /**
   * Rendered, unseen, once the pointer has rested on the trigger a moment
   * (a pointer passing over starts nothing) until the panel opens: a
   * component that only starts the panel's reads, so the panel opens with
   * what it shows instead of filling in. A panel opened at once (focus, an
   * open request) mounts its content, whose reads start then, and waits
   * for those it reports pending (useInspectorPending) before it appears.
   */
  warmup?: ReactNode;
  disabled?: boolean;
  testId?: string;
  /** Where the panel sits relative to its trigger; see computeInspectorPosition. */
  placement?: "side" | "above";
  /**
   * What the panel sits beside, when more than the trigger: the list the
   * trigger is a row of, or the sidebar it heads, so the panel clears that
   * edge and the buttons beside the trigger instead of covering them. Its
   * top still follows the trigger.
   */
  anchorRef?: RefObject<Element | null>;
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
  const warmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // What holds the inspector open. The pointer and keyboard focus hold it
  // independently, on the trigger and on the panel: the pointer leaving must
  // not close what focus holds, nor focus leaving what the pointer holds.
  const holds = useRef(new Set<InspectorHold>());
  const pointerFocus = useRef(false);
  const pinned = useRef(false);
  const dragging = useRef(false);
  const [anchor, setAnchor] = useState<InspectorAnchor | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [warming, setWarming] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  // Where the pointer last was while the panel showed, in window terms,
  // starting where it entered the trigger; unknown is never "on the panel".
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const enteredAt = useRef<{ x: number; y: number } | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  const show = useCallback(() => {
    if (dragging.current || disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const beside = anchorRef?.current?.getBoundingClientRect() ?? rect;
    setAnchor({
      top: rect.top,
      right: beside.right,
      bottom: rect.bottom,
      left: beside.left,
    });
    pointer.current = enteredAt.current;
    clearTimeout(warmTimer.current);
    setMounted(true);
    setOpen(true);
    setWarming(false);
  }, [disabled, anchorRef]);
  useEffect(() => {
    if (!disabled) return;
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    clearTimeout(warmTimer.current);
    setOpen(false);
    setMounted(false);
    setWarming(false);
  }, [disabled]);
  useEffect(() => {
    const start = () => {
      dragging.current = true;
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
      clearTimeout(warmTimer.current);
      pinned.current = false;
      holds.current.clear();
      setOpen(false);
      setMounted(false);
      setWarming(false);
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
    else {
      clearTimeout(warmTimer.current);
      if (warmup)
        warmTimer.current = setTimeout(() => setWarming(true), WARM_DELAY_MS);
      openTimer.current = setTimeout(show, delayMs);
    }
  };
  const scheduleClose = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    clearTimeout(warmTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!pinned.current && holds.current.size === 0) {
        setOpen(false);
        setWarming(false);
      }
    }, CLOSE_GRACE_MS);
  };
  const scheduleCloseRef = useRef(scheduleClose);
  scheduleCloseRef.current = scheduleClose;
  const holdForChild = useCallback(
    (held: boolean) => {
      if (held) {
        holds.current.add("panel-child");
        clearTimeout(closeTimer.current);
        return;
      }
      holds.current.delete("panel-child");
      // A picked action may have closed the panel already.
      if (!openRef.current) return;
      // Focus holds it only where the keyboard put it: arrowing through the
      // menu held the panel for focus, but a press that closed the menu
      // leaves the panel to the pointer, wherever the menu handed focus.
      const active = document.activeElement;
      const keyboard = active !== null && keyboardLeads(active);
      if (!keyboard || !triggerRef.current?.contains(active))
        holds.current.delete("trigger-focus");
      if (!keyboard || active.closest("[data-resource-inspector]")?.id !== id)
        holds.current.delete("panel-focus");
      // Where the pointer is now decides. Its enter and leave events say
      // nothing reliable: the menu and its shield sit inside the panel in
      // React's tree, so crossing onto them never left the panel, and once
      // they are gone no event reports what is under a still pointer.
      holds.current.delete("panel-pointer");
      holds.current.delete("trigger-pointer");
      const at = pointer.current;
      const under =
        at && typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(at.x, at.y)
          : null;
      if (under && triggerRef.current?.contains(under))
        holds.current.add("trigger-pointer");
      else if (under?.closest("[data-resource-inspector]")?.id === id)
        holds.current.add("panel-pointer");
      scheduleCloseRef.current();
    },
    [id],
  );

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open menu holds the window and takes Escape first (ADR 0221).
      if (document.querySelector("[data-menu-shield]")) return;
      event.preventDefault();
      event.stopPropagation();
      pinned.current = false;
      holds.current.clear();
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
      holds.current.clear();
      setOpen(false);
    };
    const dismissForPointer = (event: PointerEvent) => {
      if (
        (event.target instanceof Node &&
          triggerRef.current?.contains(event.target)) ||
        (event.target instanceof Element &&
          // A press on a menu, or on the shield under it, is the menu's:
          // it only closes the menu (ADR 0221).
          event.target.closest(`[data-resource-inspector], ${MENU_PRESS}`))
      ) {
        return;
      }
      pinned.current = false;
      holds.current.clear();
      setOpen(false);
    };
    const trackPointer = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const close = () => {
      pinned.current = false;
      holds.current.clear();
      setOpen(false);
    };
    // A press inside a page, which the window never sees itself.
    const stopPagePress = onPagePress(close);
    // The trigger turned inert or hidden: its list or sidebar closed.
    const observer = new MutationObserver(() => {
      const trigger = triggerRef.current;
      if (trigger && anchorGone(trigger)) close();
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "hidden"],
    });
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("scroll", dismissForScroll, true);
    window.addEventListener("pointerdown", dismissForPointer);
    window.addEventListener("pointermove", trackPointer, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerdown", trackPointer, true);
    return () => {
      stopPagePress();
      observer.disconnect();
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("scroll", dismissForScroll, true);
      window.removeEventListener("pointerdown", dismissForPointer);
      window.removeEventListener("pointermove", trackPointer, true);
      window.removeEventListener("pointerdown", trackPointer, true);
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
      clearTimeout(warmTimer.current);
    },
    [],
  );

  return (
    <>
      {children({
        ref: triggerRef,
        onPointerEnter: (event) => {
          enteredAt.current = event
            ? { x: event.clientX, y: event.clientY }
            : null;
          holds.current.add("trigger-pointer");
          scheduleOpen();
        },
        onPointerLeave: () => {
          enteredAt.current = null;
          holds.current.delete("trigger-pointer");
          scheduleClose();
        },
        onPointerDown: () => {
          // The focus a press causes lands later in this same input task,
          // after any microtask, so the mark lasts until the next task.
          pointerFocus.current = true;
          setTimeout(() => {
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
          // Focus from a click, from Escape returning to the trigger, or
          // that the app moved (a popover handing it back) leaves the preview
          // to the pointer, and a disabled inspector ignores focus.
          if (pointerFocus.current || disabled || appIsMovingFocus()) return;
          holds.current.add("trigger-focus");
          scheduleOpen(true);
        },
        onBlur: (event) => {
          if (
            event.relatedTarget instanceof Node &&
            triggerRef.current?.contains(event.relatedTarget)
          )
            return;
          holds.current.delete("trigger-focus");
          scheduleClose();
        },
        "aria-details": open ? id : undefined,
      })}
      {warming && !mounted && warmup}
      {mounted && anchor && (
        <InspectorPortal
          testId={testId}
          id={id}
          label={label}
          anchor={anchor}
          placement={placement}
          open={open}
          onEnter={(input) => {
            holds.current.add(`panel-${input}`);
            clearTimeout(closeTimer.current);
          }}
          onLeave={(input) => {
            holds.current.delete(`panel-${input}`);
            scheduleClose();
          }}
          onExited={() => setMounted(false)}
        >
          <InspectorHoldContext.Provider value={holdForChild}>
            {typeof content === "function"
              ? content(() => {
                  clearTimeout(openTimer.current);
                  clearTimeout(closeTimer.current);
                  pinned.current = false;
                  holds.current.clear();
                  setOpen(false);
                })
              : content}
          </InspectorHoldContext.Provider>
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
  /** The pointer or focus entered the panel. */
  onEnter: (input: InspectorInput) => void;
  onLeave: (input: InspectorInput) => void;
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
  // Unseen until the reads its content reports pending land, or for at most
  // SETTLE_MAX_MS: it appears at its size (useInspectorPending).
  const [shown, setShown] = useState(false);
  const pending = useRef(new Set<string>());
  const measured = useRef(false);
  // SETTLE_MAX_MS has passed: it appears whatever is still loading.
  const overdue = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  // Only while it is open: a panel closed before it was seen never appears.
  const reveal = useCallback(() => {
    if (
      openRef.current &&
      measured.current &&
      (pending.current.size === 0 || overdue.current)
    )
      setShown(true);
  }, []);
  const report = useCallback(
    (key: string, isPending: boolean) => {
      if (isPending) pending.current.add(key);
      else pending.current.delete(key);
      reveal();
    },
    [reveal],
  );
  // After the content's own layout effects have reported.
  useLayoutEffect(() => {
    measured.current = true;
    reveal();
    const timer = window.setTimeout(() => {
      overdue.current = true;
      reveal();
    }, SETTLE_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [reveal]);
  useLayoutEffect(() => {
    if (open) reveal();
  }, [open, reveal]);
  useEffect(() => {
    if (!shown) return;
    // Height changes animate only once the panel is seen.
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  const visible = open && shown;
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
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
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
    // Never seen: there is nothing to see leave, and its exit motion,
    // which starts from full opacity, would flash it on its way out.
    if (!shown) {
      onExited();
      return;
    }
    const timer = window.setTimeout(onExited, 180);
    return () => window.clearTimeout(timer);
  }, [open, shown, onExited]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      data-resource-inspector
      data-side={position.side}
      data-testid={testId}
      data-open={visible || undefined}
      aria-hidden={!visible}
      inert={!visible}
      data-theme={theme?.appearance}
      style={{
        ...themeStyle(theme),
        left: position.left,
        top: position.top,
        height: height ?? undefined,
      }}
      data-settled={settled || undefined}
      onPointerEnter={() => onEnter("pointer")}
      onPointerLeave={() => onLeave("pointer")}
      // A pressed button takes focus too; only keyboard focus holds it.
      onFocusCapture={(event) => {
        if (keyboardLeads(event.target)) onEnter("focus");
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        onLeave("focus");
      }}
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName.startsWith("inspector-out-") &&
          !open
        )
          onExited();
      }}
      // Over a window's drag row its buttons must still take clicks.
      className={`app-no-drag fixed z-[130] max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] w-80 overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-overlay p-3 shadow-2xl [scrollbar-gutter:stable] ${settled ? "transition-[height,top] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none" : ""} ${!shown ? "pointer-events-none opacity-0" : open ? `animate-inspector-in-${position.side}` : `pointer-events-none opacity-0 animate-inspector-out-${position.side}`}`}
    >
      <InspectorPendingContext.Provider value={report}>
        <div ref={content}>{children}</div>
      </InspectorPendingContext.Provider>
    </div>,
    document.body,
  );
}
