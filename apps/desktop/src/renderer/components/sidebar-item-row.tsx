import { useItemActions } from "@catamorphic/app/ui";
import * as icons from "lucide-react";
import { ChevronRight, LoaderCircle, MoreHorizontal } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeForAction,
  openModeFromEvent,
} from "../../shared/open-mode.js";
import type { SidebarMenuEntry, SidebarPreview } from "../lib/desktop-api.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import { ShortcutHint } from "./shortcut-hint";
import {
  sidebarItemPresentation,
  useSidebarContribution,
} from "./sidebar-contribution.js";
import {
  SIDEBAR_PREVIEW_DELAY_MS,
  type SidebarPreviewAnchor,
  SidebarPreviewPopover,
} from "./sidebar-preview.js";

export interface ContextMenuEntry {
  label: string;
  action: string;
  danger?: boolean;
  icon?: string;
  url?: string;
  disabledReason?: string;
  /** The entry in force: the pick among several, or a setting that is on. */
  checked?: boolean;
  /** A setting the entry turns on and off, not one pick among several. */
  setting?: boolean;
  /** A quieter note after the label, such as a voice's description. */
  detail?: string;
  /** Opens a nested menu; the entry itself picks nothing. */
  submenu?: readonly this[];
}

export function SidebarIcon({ name }: { name?: string }) {
  const Icon = lucideIcon(name) ?? icons.Circle;
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
}

/** Optional hover hint (e.g. a bookmark's URL) in the app-standard style. */
function TitleHint({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  if (!title) return <>{children}</>;
  return (
    <ShortcutHint label={title} className="h-full min-w-0 flex-1">
      {children}
    </ShortcutHint>
  );
}

/**
 * One sidebar list row: icon + label, with a single ⋯ button revealed on
 * hover that opens a menu. One button, not a row of them — stacked icon
 * buttons get unreadable fast and every new capability made it worse.
 *
 * The menu is data (`SidebarMenuEntry[]`, from workspace.js) and the row is
 * generic, so custom config-defined items and built-in bookmarks share
 * exactly the same interaction.
 */
export function SidebarItemRow<
  TMenuEntry extends ContextMenuEntry = SidebarMenuEntry,
>({
  itemId,
  supportedActions,
  contextMenu,
  actions,
  description,
  badges,
  progress,
  presentation = "row",
  expanded,
  resource = false,
  defaultOpenMode = "replace",
  label,
  title,
  icon,
  menu,
  defaultMenu,
  preview,
  previewContent,
  active,
  labelContent,
  end,
  disclosure,
  onOpen,
  onAction,
  renaming,
  style,
  onRenameSubmit,
  onRenameCancel,
}: {
  itemId?: string;
  supportedActions?: readonly string[];
  contextMenu?: readonly TMenuEntry[];
  actions?: readonly TMenuEntry[];
  description?: string;
  badges?: readonly string[];
  progress?: number;
  presentation?: "row" | "tile";
  expanded?: boolean;
  resource?: boolean;
  defaultOpenMode?: OpenMode;
  label: string;
  /** Tooltip; usually the URL. */
  title?: string;
  /** lucide-react icon name, or a node to render directly. */
  icon?: string | ReactNode;
  menu?: readonly TMenuEntry[];
  defaultMenu?: readonly TMenuEntry[];
  preview?: SidebarPreview | false;
  /** Rich inspector body for built-in resources; uses the same hover shell. */
  previewContent?: ReactNode;
  active?: boolean;
  labelContent?: ReactNode;
  end?: ReactNode;
  disclosure?: { open: boolean; onToggle: () => void };
  onOpen: (mode: OpenMode) => void;
  onAction: (entry: TMenuEntry) => void | Promise<void>;
  /** Swap the label for an inline rename field. */
  renaming?: boolean;
  style?: CSSProperties;
  onRenameSubmit?: (label: string) => void;
  onRenameCancel?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const pendingActionRef = useRef<ContextMenuEntry | null>(null);
  const contribution = useSidebarContribution();
  const overrides = sidebarItemPresentation({
    section: contribution?.section,
    id: itemId,
  });
  const [menuKind, setMenuKind] = useState<"overflow" | "context">("overflow");
  const { error: actionError, pending, run: runItemAction } = useItemActions();
  const configuredContext = overrides.contextMenu ?? contextMenu;
  const configuredActions = overrides.actions ?? actions ?? [];
  const available = (entries: readonly ContextMenuEntry[]) =>
    entries.map((entry) => ({
      ...entry,
      disabledReason:
        entry.disabledReason ??
        (entry.url ||
        (resource &&
          (openModeForAction(entry.action) || entry.action === "open")) ||
        (supportedActions
          ? supportedActions.includes(entry.action)
          : [
              ...(defaultMenu ?? []),
              ...(menu ?? []),
              ...(contextMenu ?? []),
              ...(actions ?? []),
            ].some((original) => original.action === entry.action)) ||
        (["refresh", "search", "new-chat", "new-workflow"].includes(
          entry.action,
        ) &&
          contribution?.commands?.has(entry.action))
          ? undefined
          : "This item does not support this action"),
    }));
  const resolvedMenu = available(
    overrides.menu ??
      (menu === undefined
        ? [...(resource ? OPEN_ACTIONS : []), ...(defaultMenu ?? [])]
        : menu),
  );
  const resolvedContext = available(configuredContext ?? resolvedMenu);
  const inlineActions = available(configuredActions);
  const activeMenu = menuKind === "context" ? resolvedContext : resolvedMenu;
  const invoke = (entry: ContextMenuEntry) =>
    runItemAction({
      id: entry.action,
      label: entry.label,
      disabledReason: entry.disabledReason,
      run: async () => {
        const mode = openModeForAction(entry.action);
        if (entry.url && contribution)
          contribution.open(
            entry.url,
            mode ?? overrides.open ?? defaultOpenMode,
          );
        else if (resource && (mode || entry.action === "open"))
          onOpen(mode ?? overrides.open ?? defaultOpenMode);
        else {
          const original = [
            ...(defaultMenu ?? []),
            ...(menu ?? []),
            ...(contextMenu ?? []),
            ...(actions ?? []),
          ].find((candidate) => candidate.action === entry.action);
          if (original) await onAction(original);
          else if (contribution?.command)
            await contribution.command(entry.action);
          else throw new Error("This item does not support this action");
        }
      },
    });
  if (overrides.label !== undefined) labelContent = undefined;
  if (overrides.preview !== undefined) previewContent = undefined;
  label = overrides.label ?? label;
  icon = overrides.icon ?? icon;
  description = overrides.description ?? description;
  badges = overrides.badges ?? badges;
  progress = overrides.progress ?? progress;
  preview = overrides.preview ?? preview;
  if (preview === false) previewContent = undefined;
  defaultOpenMode = overrides.open ?? defaultOpenMode;
  const previewId = useId();
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const rowHoveredRef = useRef(false);
  const rowFocusedRef = useRef(false);
  const previewHoveredRef = useRef(false);
  const [previewAnchor, setPreviewAnchor] =
    useState<SidebarPreviewAnchor | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewEnabled =
    previewContent !== undefined ||
    (preview !== undefined && preview !== false);

  const disarmPreview = () => {
    clearTimeout(previewTimerRef.current);
    setPreviewOpen(false);
  };

  const deferPreviewClose = () => {
    clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      if (
        !rowHoveredRef.current &&
        !rowFocusedRef.current &&
        !previewHoveredRef.current
      ) {
        setPreviewOpen(false);
      }
    }, 100);
  };

  const armPreview = () => {
    if (!previewEnabled || renaming || open) return;
    clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPreviewAnchor({
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      });
      setPreviewOpen(true);
    }, SIDEBAR_PREVIEW_DELAY_MS);
  };

  // Only a scroll that moves the row detaches the fixed-position menu
  // from it; its own button opens and closes it.
  useMenuDismiss({
    open,
    close: () => setOpen(false),
    anchor: buttonRef,
    pressesInAnchor: "ignore",
  });

  useEffect(() => () => clearTimeout(previewTimerRef.current), []);

  useEffect(() => {
    if (!previewOpen) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-resource-inspector]") &&
        !(event instanceof KeyboardEvent)
      )
        return;
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof KeyboardEvent) event.preventDefault();
      clearTimeout(previewTimerRef.current);
      setPreviewOpen(false);
    };
    // A drag carries the row away from its hint; the card would otherwise
    // float over the drop targets until the drag ends.
    const dismissForDrag = () => {
      clearTimeout(previewTimerRef.current);
      setPreviewOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("dragstart", dismissForDrag, true);
    // Scrolling invalidates the fixed anchor coordinates.
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("dragstart", dismissForDrag, true);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [previewOpen]);

  useEffect(() => {
    if (renaming || open || !previewEnabled) {
      clearTimeout(previewTimerRef.current);
      setPreviewOpen(false);
    }
  }, [renaming, open, previewEnabled]);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const IconComponent =
    typeof icon === "string" ? (lucideIcon(icon) ?? icons.Circle) : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click mirrors the row's ⋯ button, which stays keyboard-reachable
    <div
      ref={rowRef}
      style={{ ...style, display: overrides.hide ? "none" : style?.display }}
      data-sidebar-item-id={itemId}
      data-interacting={open || previewOpen || renaming ? "true" : undefined}
      className={`group relative flex items-center rounded-md transition-colors duration-150 ${presentation === "tile" ? "h-9 border border-border bg-bg-raised" : "h-7"} ${
        active ? "bg-bg-overlay" : "hover:bg-bg-overlay/60"
      }`}
      data-point-key={`sidebar:${label}`}
      onMouseEnter={() => {
        rowHoveredRef.current = true;
        armPreview();
      }}
      onMouseLeave={() => {
        rowHoveredRef.current = false;
        deferPreviewClose();
      }}
      onFocusCapture={() => {
        rowFocusedRef.current = true;
        // Keyboard focus previews the row. Focus a click or a dismissed menu
        // hands back does not: the pointer's own hover already does that.
        if (document.documentElement.dataset.focusModality !== "pointer")
          armPreview();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          rowFocusedRef.current = false;
          deferPreviewClose();
        }
      }}
      // Right-click has its own configuration and shares the menu lifecycle.
      onContextMenu={
        resolvedContext.length > 0 && !renaming
          ? (event) => {
              event.preventDefault();
              if (pendingActionRef.current) return;
              disarmPreview();
              setMenuKind("context");
              setPosition({ x: event.clientX, y: event.clientY });
              setOpen(true);
            }
          : contextMenu || overrides.contextMenu
            ? (event) => event.preventDefault()
            : undefined
      }
      onKeyDown={(event) => {
        if (
          (event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")) &&
          resolvedContext.length
        ) {
          event.preventDefault();
          const rect = rowRef.current?.getBoundingClientRect();
          if (rect) {
            setMenuKind("context");
            setPosition({ x: rect.left, y: rect.bottom });
            setOpen(true);
          }
        }
      }}
    >
      {renaming ? (
        <input
          ref={renameRef}
          defaultValue={label}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRenameSubmit?.(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onRenameCancel?.();
            }
          }}
          onBlur={(event) => onRenameSubmit?.(event.currentTarget.value)}
          className="field mx-1 h-6 w-full rounded px-1.5 text-[13px] text-fg"
          aria-label={`Rename ${label}`}
        />
      ) : (
        <>
          {disclosure && (
            <button
              type="button"
              onClick={disclosure.onToggle}
              className="ml-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
              aria-label={`${disclosure.open ? "Collapse" : "Expand"} ${label}`}
              aria-expanded={disclosure.open}
            >
              <ChevronRight
                className={`size-3 transition-transform duration-150 ${disclosure.open ? "rotate-90" : ""}`}
              />
            </button>
          )}
          <TitleHint title={previewEnabled ? undefined : title}>
            <button
              type="button"
              data-tree-primary
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (pendingActionRef.current) return;
                  disarmPreview();
                  onOpen(openModeFromEvent(event, defaultOpenMode));
                }
              }}
              onClick={(event) => {
                if (pendingActionRef.current) return;
                disarmPreview();
                onOpen(openModeFromEvent(event, defaultOpenMode));
              }}
              className={`flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ${disclosure ? "pr-2" : "px-2"} text-left text-[13px] ${presentation === "tile" ? "justify-center" : ""} hover:text-fg ${
                active ? "text-fg" : "text-fg-muted"
              }`}
              aria-expanded={disclosure?.open ?? expanded}
              aria-current={active || undefined}
              aria-details={
                previewEnabled && previewOpen ? previewId : undefined
              }
            >
              {IconComponent ? (
                <IconComponent className="size-3.5 shrink-0 text-fg-faint" />
              ) : (
                icon
              )}
              {presentation === "tile" ? (
                <span className="sr-only">{label}</span>
              ) : (
                (labelContent ?? (
                  // The label is what people read: it keeps its width and the
                  // description gives way first when the row is narrow.
                  <span className="min-w-0 flex-auto truncate">{label}</span>
                ))
              )}
              {description && (
                <span className="min-w-0 max-w-32 shrink-[3] truncate text-[11px] text-fg-faint">
                  {description}
                </span>
              )}
              {badges?.map((badge) => (
                <span
                  key={badge}
                  className="rounded bg-bg-inset px-1 text-[10px] text-fg-muted"
                >
                  {badge}
                </span>
              ))}
              {progress !== undefined && (
                <progress
                  aria-label={`${label} progress`}
                  value={progress}
                  max={1}
                  className="h-1 w-12 accent-accent"
                />
              )}
              {end}
            </button>
          </TitleHint>
          {inlineActions.map((entry) => {
            const Icon = lucideIcon(entry.icon) ?? icons.Circle;
            return (
              <ShortcutHint
                key={`${entry.action}:${entry.label}`}
                label={entry.disabledReason ?? entry.label}
              >
                <button
                  type="button"
                  aria-label={entry.label}
                  disabled={Boolean(entry.disabledReason) || Boolean(pending)}
                  data-disabled-reason={
                    entry.disabledReason ??
                    (pending ? "Wait for the current action" : undefined)
                  }
                  aria-busy={pending === entry.action}
                  onClick={() => void invoke(entry)}
                  className="grid size-6 shrink-0 place-items-center rounded text-fg-muted hover:bg-bg-overlay disabled:opacity-40"
                >
                  {pending === entry.action ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <Icon className="size-3.5" />
                  )}
                </button>
              </ShortcutHint>
            );
          })}
          {resolvedMenu.length > 0 && presentation !== "tile" && (
            <button
              ref={buttonRef}
              type="button"
              onClick={(_event) => {
                if (pendingActionRef.current) return;
                disarmPreview();
                const rect = buttonRef.current?.getBoundingClientRect();
                if (rect) {
                  setPosition({ x: rect.right, y: rect.bottom + 4 });
                }
                setMenuKind("overflow");
                setOpen((value) => !value);
              }}
              className={`grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg mr-1 ${
                open ? "" : "row-reveal"
              }`}
              aria-label={`More actions for ${label}`}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          )}
        </>
      )}

      {position && (
        <MenuPortal
          open={open}
          position={position}
          entries={activeMenu}
          onDismiss={() => setOpen(false)}
          onPick={(entry) => {
            pendingActionRef.current = entry;
            setOpen(false);
          }}
          onExited={() => {
            setPosition(null);
            const pendingAction = pendingActionRef.current;
            pendingActionRef.current = null;
            if (pendingAction) void invoke(pendingAction);
            else
              rowRef.current
                ?.querySelector<HTMLElement>("[data-tree-primary]")
                ?.focus({ preventScroll: true });
          }}
        />
      )}
      {actionError && (
        <ShortcutHint label={actionError}>
          <span
            role="alert"
            className="mr-1 flex shrink-0 items-center gap-1 text-xs text-danger"
          >
            <icons.CircleAlert aria-hidden="true" className="size-3" />
            Failed<span className="sr-only">: {actionError}</span>
          </span>
        </ShortcutHint>
      )}
      {previewEnabled && previewAnchor && (
        <SidebarPreviewPopover
          id={previewId}
          open={previewOpen}
          anchor={previewAnchor}
          preview={preview === false ? undefined : preview}
          content={previewContent}
          fallbackTitle={label}
          onMouseEnter={() => {
            previewHoveredRef.current = true;
            clearTimeout(previewTimerRef.current);
          }}
          onMouseLeave={() => {
            previewHoveredRef.current = false;
            deferPreviewClose();
          }}
          onExited={() => setPreviewAnchor(null)}
        />
      )}
    </div>
  );
}

/**
 * Portal-rendered so the sidebar's scroll container can't clip it — the
 * same lesson ShortcutHint learned (DOM checks pass while pixels clip).
 * Shared with other sidebar rows and dock bubbles that need the same menu.
 */
/**
 * Closes a context menu when the person leaves it: a press outside it,
 * Escape, or focus leaving the window's page, which is what a press in a
 * web page does: the window never sees presses inside a page. With an
 * anchor, a scroll that moves the anchor closes it too, since the menu is
 * fixed where it opened; other scrolls (a chat following its output) do
 * not.
 */
export function useMenuDismiss({
  open,
  close,
  anchor,
  pressesInAnchor = "close",
}: {
  open: boolean;
  close: () => void;
  anchor?: RefObject<Element | null>;
  /** "ignore" when the anchor opens and closes the menu itself. */
  pressesInAnchor?: "close" | "ignore";
}): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const leave = () => closeRef.current();
    const press = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-sidebar-menu]"))
        return;
      if (
        pressesInAnchor === "ignore" &&
        target instanceof Node &&
        anchor?.current?.contains(target)
      )
        return;
      leave();
    };
    const scroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        anchor?.current &&
        event.target.contains(anchor.current)
      )
        leave();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      leave();
    };
    window.addEventListener("pointerdown", press);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", leave);
    if (anchor) window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", leave);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, anchor, pressesInAnchor]);
}

export function MenuPortal<TMenuEntry extends ContextMenuEntry>({
  open,
  position,
  entries,
  onPick,
  onDismiss,
  onExited,
}: {
  open: boolean;
  position: { x: number; y: number };
  entries: readonly TMenuEntry[];
  onPick: (entry: TMenuEntry) => void;
  onDismiss?: () => void;
  onExited: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const frozenEntriesRef = useRef(entries);
  const [adjusted, setAdjusted] = useState(position);
  // The open nested menu: its entry, and the row it opened from.
  const [sub, setSub] = useState<{
    entry: TMenuEntry;
    anchor: HTMLButtonElement;
  } | null>(null);
  const [subAt, setSubAt] = useState<{ x: number; y: number } | null>(null);
  if (open) frozenEntriesRef.current = entries;
  const visibleEntries = open ? entries : frozenEntriesRef.current;

  useEffect(() => {
    if (open) {
      menuButtons(ref)[0]?.focus();
      return;
    }
    setSub(null);
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      (ref.current?.contains(activeElement) ||
        subRef.current?.contains(activeElement))
    ) {
      activeElement.blur();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(onExited, 180);
    return () => window.clearTimeout(timer);
  }, [open, onExited]);

  // Flip above / pull inside the viewport when near an edge.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const next = {
      x: Math.max(
        8,
        Math.min(position.x - rect.width, window.innerWidth - rect.width - 8),
      ),
      y: Math.max(
        8,
        Math.min(
          position.y + rect.height > window.innerHeight - 8
            ? position.y - rect.height - 8
            : position.y,
          window.innerHeight - rect.height - 8,
        ),
      ),
    };
    if (next.x !== adjusted.x || next.y !== adjusted.y) setAdjusted(next);
  }, [position, adjusted.x, adjusted.y]);

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
      right + panel.width <= window.innerWidth - 8
        ? right
        : Math.max(8, parent.left - panel.width - 2);
    const y = Math.max(
      8,
      Math.min(row.top - 5, window.innerHeight - panel.height - 8),
    );
    setSubAt((at) => (at && at.x === x && at.y === y ? at : { x, y }));
  }, [sub]);

  const openSub = (
    entry: TMenuEntry,
    anchor: HTMLButtonElement,
    focus: boolean,
  ) => {
    setSub((current) =>
      current?.entry === entry ? current : { entry, anchor },
    );
    if (focus) requestAnimationFrame(() => menuButtons(subRef)[0]?.focus());
  };
  const closeSub = (refocus: boolean) => {
    const anchor = sub?.anchor;
    setSub(null);
    if (refocus) anchor?.focus();
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

  const items = (list: readonly TMenuEntry[], nested: boolean) =>
    list.map((entry) => {
      const parent = Boolean(entry.submenu?.length);
      const expanded = parent && sub?.entry === entry;
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
          className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
            entry.danger
              ? "text-danger hover:bg-danger/10"
              : expanded
                ? "bg-bg-raised text-fg"
                : entry.checked
                  ? "text-fg hover:bg-bg-raised"
                  : "text-fg-muted hover:bg-bg-raised hover:text-fg"
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
    `fixed z-[140] min-w-44 max-w-[calc(100vw-16px)] ${
      shown ? "animate-pop-in" : "pointer-events-none animate-pop-out"
    }`;
  const listClass =
    "max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl";

  return createPortal(
    <>
      <div
        ref={ref}
        data-sidebar-menu
        role="menu"
        onKeyDown={(event) => {
          if (event.key === "Escape" && onDismiss) {
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
        style={{ left: adjusted.x, top: adjusted.y }}
        className={`${panelClass(open)} origin-top-right`}
      >
        <div className={listClass}>{items(visibleEntries, false)}</div>
      </div>
      {sub?.entry.submenu && (
        <div
          ref={subRef}
          data-sidebar-menu
          role="menu"
          aria-label={sub.entry.label}
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
          <div className={listClass}>{items(sub.entry.submenu, true)}</div>
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
