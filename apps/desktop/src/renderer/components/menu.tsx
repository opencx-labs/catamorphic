import * as icons from "lucide-react";
import { ChevronRight } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  isMenuSeparator,
  type MenuEntry,
  type MenuSeparator,
} from "../../shared/menu.js";

/** A menu row the app draws; `icon` and `url` serve sidebar placements. */
export interface ContextMenuEntry extends MenuEntry {
  icon?: string;
  url?: string;
  submenu?: readonly (this | MenuSeparator)[];
}

/**
 * Where a menu opens: at the pointer, extending right and down as menus
 * do and flipping where the window ends, or under the control that opened
 * it, aligned to its right edge (above it when there is no room below).
 */
export type MenuAt =
  | { pointer: { x: number; y: number } }
  | { control: { top: number; right: number; bottom: number; left: number } };

export function menuAtPointer(event: {
  clientX: number;
  clientY: number;
}): MenuAt {
  return { pointer: { x: event.clientX, y: event.clientY } };
}

export function menuAtControl(element: Element): MenuAt {
  const { top, right, bottom, left } = element.getBoundingClientRect();
  return { control: { top, right, bottom, left } };
}

const EDGE = 8;

/** The panel's corner and the corner it grows from, kept in the window. */
export function placeMenu(
  at: MenuAt,
  size: { width: number; height: number },
): { left: number; top: number; origin: string } {
  const room = {
    right: window.innerWidth - EDGE,
    bottom: window.innerHeight - EDGE,
  };
  let left: number;
  let top: number;
  let originX: "left" | "right";
  let originY: "top" | "bottom";
  if ("pointer" in at) {
    const { x, y } = at.pointer;
    const flipX = x + size.width > room.right;
    const flipY = y + size.height > room.bottom;
    left = flipX ? x - size.width : x;
    top = flipY ? y - size.height : y;
    originX = flipX ? "right" : "left";
    originY = flipY ? "bottom" : "top";
  } else {
    const rect = at.control;
    const flipY = rect.bottom + 4 + size.height > room.bottom;
    left = rect.right - size.width;
    top = flipY ? rect.top - 4 - size.height : rect.bottom + 4;
    originX = "right";
    originY = flipY ? "bottom" : "top";
  }
  return {
    left: Math.max(EDGE, Math.min(left, room.right - size.width)),
    top: Math.max(EDGE, Math.min(top, room.bottom - size.height)),
    origin: `${originY} ${originX}`,
  };
}

/** True once the control a menu belongs to can no longer be used or seen. */
function anchorGone(anchor: Element): boolean {
  return (
    !anchor.isConnected ||
    anchor.closest("[inert], [hidden]") !== null ||
    (typeof anchor.checkVisibility === "function" &&
      !anchor.checkVisibility({ visibilityProperty: true }))
  );
}

/**
 * The app's menus: overflow, right-click and page menus. Portal-rendered
 * so no scroll container clips it (DOM checks pass while pixels clip).
 *
 * While open, a transparent shield covers the window under the menu, as a
 * native menu holds the screen: a press anywhere else (a sidebar row, a
 * web page, an app's frame, the title bar) only closes the menu. Pages
 * and frames run in their own processes, so without it the window never
 * saw presses inside them. The menu also closes on Escape, when the
 * window loses focus, and when its anchor goes: a scroll carries it away,
 * or it turns inert or hidden (its sidebar closed).
 */
export function MenuPortal<TEntry extends ContextMenuEntry>({
  open,
  at,
  entries,
  label,
  anchor,
  onPick,
  onDismiss,
  onExited,
}: {
  open: boolean;
  at: MenuAt;
  entries: readonly (TEntry | MenuSeparator)[];
  /** Names the menu for assistive technology. */
  label?: string;
  /** The control the menu belongs to; the menu goes when it does. */
  anchor?: RefObject<Element | null>;
  onPick: (entry: TEntry) => void;
  onDismiss: () => void;
  onExited: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const frozenEntriesRef = useRef(entries);
  const [placed, setPlaced] = useState<{
    left: number;
    top: number;
    origin: string;
  } | null>(null);
  // The open nested menu: its entry, and the row it opened from.
  const [sub, setSub] = useState<{
    entry: TEntry;
    anchor: HTMLButtonElement;
  } | null>(null);
  const [subAt, setSubAt] = useState<{ x: number; y: number } | null>(null);
  if (open) frozenEntriesRef.current = entries;
  const visibleEntries = open ? entries : frozenEntriesRef.current;
  const subEntry = sub
    ? (visibleEntries.find(
        (entry): entry is TEntry =>
          !isMenuSeparator(entry) && entry.action === sub.entry.action,
      ) ?? sub.entry)
    : null;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const inMenu = (node: Node) =>
    Boolean(ref.current?.contains(node) || subRef.current?.contains(node));
  // Where focus was as the menu opened. It goes back there as the menu
  // closes, unless the person has put it somewhere else meanwhile.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: inMenu reads refs
  useEffect(() => {
    const active = document.activeElement;
    if (open) {
      if (active instanceof HTMLElement && !inMenu(active))
        returnFocusRef.current = active;
      menuButtons(ref)[0]?.focus();
      return;
    }
    setSub(null);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (active && active !== document.body && !inMenu(active)) return;
    if (back?.isConnected) back.focus({ preventScroll: true });
    else if (active instanceof HTMLElement && inMenu(active)) active.blur();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => dismissRef.current();
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    // Only a scroll that moves the anchor detaches the fixed menu from it;
    // other scrolls (a chat following its output) leave it be.
    const scroll = (event: Event) => {
      const element = anchor?.current;
      if (
        element &&
        event.target instanceof Node &&
        event.target.contains(element)
      )
        dismiss();
    };
    const observer =
      anchor &&
      new MutationObserver(() => {
        const element = anchor.current;
        if (element && anchorGone(element)) dismiss();
      });
    observer?.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "hidden"],
    });
    // The shield takes presses below it; this catches those on whatever
    // the window draws above it (an update banner, a toast).
    const press = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu], [data-menu-shield]")
      )
        return;
      dismiss();
    };
    // Focus leaving the menu without a press: Tab, or a shortcut that
    // opens the palette.
    const focus = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      )
        return;
      dismiss();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("pointerdown", press, true);
    document.addEventListener("focusin", focus);
    return () => {
      observer?.disconnect();
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("pointerdown", press, true);
      document.removeEventListener("focusin", focus);
    };
  }, [open, anchor]);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(onExited, 180);
    return () => window.clearTimeout(timer);
  }, [open, onExited]);

  // Measured before paint: the panel first renders unplaced.
  const atKey = JSON.stringify(at);
  const entriesKey = visibleEntries
    .map((entry) => (isMenuSeparator(entry) ? "—" : entry.label))
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again only when the point or the entries shown change
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const next = placeMenu(at, {
      width: panel.offsetWidth,
      height: panel.offsetHeight,
    });
    setPlaced((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.origin === next.origin
        ? current
        : next,
    );
  }, [atKey, entriesKey]);

  // A nested menu opens beside its row, on whichever side has room,
  // with its first row level with the one it opened from.
  useLayoutEffect(() => {
    const panel = subRef.current?.getBoundingClientRect();
    if (!sub || !panel) {
      setSubAt(null);
      return;
    }
    const row = sub.anchor.getBoundingClientRect();
    const parent = ref.current?.getBoundingClientRect() ?? row;
    const right = parent.right + 2;
    const x =
      right + panel.width <= window.innerWidth - EDGE
        ? right
        : Math.max(EDGE, parent.left - panel.width - 2);
    const y = Math.max(
      EDGE,
      Math.min(row.top - 5, window.innerHeight - panel.height - EDGE),
    );
    setSubAt((at) => (at && at.x === x && at.y === y ? at : { x, y }));
  }, [sub]);

  const openSub = (
    entry: TEntry,
    anchorRow: HTMLButtonElement,
    focus: boolean,
  ) => {
    setSub((current) =>
      current?.entry.action === entry.action
        ? current
        : { entry, anchor: anchorRow },
    );
    if (focus) requestAnimationFrame(() => menuButtons(subRef)[0]?.focus());
  };
  const closeSub = (refocus: boolean) => {
    const row = sub?.anchor;
    setSub(null);
    if (refocus) row?.focus();
  };

  const navigate = (
    event: React.KeyboardEvent<HTMLDivElement>,
    panel: RefObject<HTMLDivElement | null>,
  ) => {
    const buttons = menuButtons(panel);
    const activeElement = document.activeElement;
    const current =
      activeElement instanceof HTMLButtonElement
        ? buttons.indexOf(activeElement)
        : -1;
    const moveTo = (index: number) => {
      event.preventDefault();
      buttons[index]?.focus();
    };
    if (event.key === "ArrowDown") {
      moveTo((current + 1) % buttons.length);
    } else if (event.key === "ArrowUp") {
      moveTo((current - 1 + buttons.length) % buttons.length);
    } else if (event.key === "Home") {
      moveTo(0);
    } else if (event.key === "End") {
      moveTo(buttons.length - 1);
    }
  };

  const items = (list: readonly (TEntry | MenuSeparator)[], nested: boolean) =>
    list.map((entry, index) => {
      if (isMenuSeparator(entry))
        return (
          <hr
            // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity but their place
            key={`separator:${index}`}
            className="mx-2 my-1 h-px border-0 bg-border"
          />
        );
      const parent = Boolean(entry.submenu?.length);
      // By action: a menu rebuilt while open (a live state changed) keeps
      // its open row and shows the submenu's current entries.
      const expanded = parent && sub?.entry.action === entry.action;
      return (
        <button
          key={`${entry.action}:${entry.label}`}
          type="button"
          {...(parent
            ? {
                role: "menuitem",
                "aria-haspopup": "menu" as const,
                "aria-expanded": expanded,
              }
            : entry.checked === undefined
              ? { role: "menuitem" }
              : {
                  role: entry.setting ? "menuitemcheckbox" : "menuitemradio",
                  "aria-checked": entry.checked,
                })}
          tabIndex={open ? 0 : -1}
          disabled={Boolean(entry.disabledReason)}
          data-disabled-reason={entry.disabledReason}
          data-submenu={parent || undefined}
          onMouseEnter={(event) => {
            if (nested) return;
            if (parent) openSub(entry, event.currentTarget, false);
            else if (sub) closeSub(false);
          }}
          onKeyDown={(event) => {
            if (!parent || nested) return;
            if (event.key === "ArrowRight" || event.key === "Enter") {
              event.preventDefault();
              openSub(entry, event.currentTarget, true);
            }
          }}
          onClick={(event) => {
            if (parent) openSub(entry, event.currentTarget, true);
            else onPick(entry);
          }}
          className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
            entry.disabledReason
              ? // Faint text alone is barely lighter in the light theme.
                "cursor-default text-fg-muted opacity-45"
              : entry.danger
                ? "cursor-pointer text-danger hover:bg-danger/10"
                : expanded
                  ? "cursor-pointer bg-bg-raised text-fg"
                  : entry.checked
                    ? "cursor-pointer text-fg hover:bg-bg-raised"
                    : "cursor-pointer text-fg-muted hover:bg-bg-raised hover:text-fg"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">
            {entry.label}
            {entry.detail && (
              <span className="ms-2 text-fg-faint">{entry.detail}</span>
            )}
          </span>
          {entry.checked && (
            <icons.Check className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          {parent && (
            <ChevronRight
              className="size-3.5 shrink-0 text-fg-faint"
              aria-hidden="true"
            />
          )}
        </button>
      );
    });

  // The panel animates on an element that does not scroll: a slide
  // inside a scroller would flash its scrollbar for the length of it.
  const panelClass = (shown: boolean) =>
    `fixed z-[140] min-w-44 max-w-[min(20rem,calc(100vw-16px))] ${
      shown ? "animate-pop-in" : "pointer-events-none animate-pop-out"
    }`;
  const listClass =
    "max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl";
  // Unplaced only until the layout effect measures it, before any paint;
  // never hidden, or it could not take focus as it opens.
  const panelStyle: CSSProperties = placed
    ? { left: placed.left, top: placed.top, transformOrigin: placed.origin }
    : { left: 0, top: 0 };

  return createPortal(
    <>
      {open && (
        // The shield only takes the press that closes the menu; Escape
        // closes it from the keyboard. It closes on mousedown, not the
        // pointerdown before it: the shield is still there to keep focus
        // where it was (the menu hands it back) and to take the click. A
        // right-click's contextmenu, which follows, reaches what is under
        // it and opens that menu instead, as on macOS.
        <div
          data-menu-shield
          aria-hidden="true"
          className="app-no-drag fixed inset-0 z-[140]"
          onMouseDown={(event) => {
            event.preventDefault();
            dismissRef.current();
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
      )}
      <div
        ref={ref}
        data-sidebar-menu
        role="menu"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
            return;
          }
          navigate(event, ref);
        }}
        onAnimationEnd={(event) => {
          if (event.animationName === "pop-out" && !open) onExited();
        }}
        style={panelStyle}
        className={panelClass(open)}
      >
        <div className={listClass}>{items(visibleEntries, false)}</div>
      </div>
      {subEntry?.submenu && (
        <div
          ref={subRef}
          data-sidebar-menu
          role="menu"
          aria-label={subEntry.label}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSub(true);
              return;
            }
            navigate(event, subRef);
          }}
          style={
            subAt
              ? { left: subAt.x, top: subAt.y }
              : { left: 0, top: 0, visibility: "hidden" }
          }
          className={`${panelClass(open)} origin-top-left`}
        >
          <div className={listClass}>{items(subEntry.submenu, true)}</div>
        </div>
      )}
    </>,
    document.body,
  );
}

function menuButtons(
  ref: RefObject<HTMLDivElement | null>,
): HTMLButtonElement[] {
  return [
    ...(ref.current?.querySelectorAll<HTMLButtonElement>(
      "[role=menuitem]:not(:disabled), [role=menuitemradio]:not(:disabled), [role=menuitemcheckbox]:not(:disabled)",
    ) ?? []),
  ];
}
