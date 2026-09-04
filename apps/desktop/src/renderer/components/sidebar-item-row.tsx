import * as icons from "lucide-react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
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
import type { SidebarMenuEntry, SidebarPreview } from "../lib/desktop-api.js";
import { ShortcutHint } from "./shortcut-hint";
import {
  SIDEBAR_PREVIEW_DELAY_MS,
  type SidebarPreviewAnchor,
  SidebarPreviewPopover,
} from "./sidebar-preview.js";

export interface ContextMenuEntry {
  label: string;
  action: string;
  danger?: boolean;
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
  return <ShortcutHint label={title}>{children}</ShortcutHint>;
}

/**
 * One sidebar list row: icon + label, with a single ⋯ button revealed on
 * hover that opens a menu. One button, not a row of them — stacked icon
 * buttons get unreadable fast and every new capability made it worse.
 *
 * The menu is data (`SidebarMenuEntry[]`, from sidebar.js) and the row is
 * generic, so custom config-defined items and built-in bookmarks share
 * exactly the same interaction.
 */
export function SidebarItemRow<
  TMenuEntry extends ContextMenuEntry = SidebarMenuEntry,
>({
  label,
  title,
  icon,
  menu,
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
  label: string;
  /** Tooltip; usually the URL. */
  title?: string;
  /** lucide-react icon name, or a node to render directly. */
  icon?: string | ReactNode;
  menu?: readonly TMenuEntry[];
  preview?: SidebarPreview | false;
  /** Rich inspector body for built-in resources; uses the same hover shell. */
  previewContent?: ReactNode;
  active?: boolean;
  labelContent?: ReactNode;
  end?: ReactNode;
  disclosure?: { open: boolean; onToggle: () => void };
  onOpen: () => void;
  onAction: (entry: TMenuEntry) => void;
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
  const pendingActionRef = useRef<TMenuEntry | null>(null);
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

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      // Clicks inside the portal menu handle themselves.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      ) {
        return;
      }
      if (
        event.target instanceof Node &&
        buttonRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    // Any scroll would detach the fixed-position menu from its row.
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(previewTimerRef.current), []);

  useEffect(() => {
    if (!previewOpen) return;
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof KeyboardEvent) event.preventDefault();
      clearTimeout(previewTimerRef.current);
      setPreviewOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    // Scrolling invalidates the fixed anchor coordinates.
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("keydown", dismiss);
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
    typeof icon === "string"
      ? (
          icons as unknown as Record<
            string,
            React.ComponentType<{ className?: string }>
          >
        )[icon]
      : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click mirrors the row's ⋯ button, which stays keyboard-reachable
    <div
      ref={rowRef}
      style={style}
      className={`group relative flex h-7 items-center rounded-md transition-colors duration-150 ${
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
        armPreview();
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          rowFocusedRef.current = false;
          deferPreviewClose();
        }
      }}
      // Right-click = the ⋯ menu, at the cursor. Same entries, same
      // portal — two paths into one menu, never two menus.
      onContextMenu={
        menu && menu.length > 0 && !renaming
          ? (event) => {
              event.preventDefault();
              if (pendingActionRef.current) return;
              disarmPreview();
              setPosition({ x: event.clientX, y: event.clientY });
              setOpen(true);
            }
          : undefined
      }
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
              onClick={() => {
                if (pendingActionRef.current) return;
                disarmPreview();
                onOpen();
              }}
              className={`flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 ${disclosure ? "pr-2" : "px-2"} text-left text-[13px] hover:text-fg ${
                active ? "text-fg" : "text-fg-muted"
              }`}
              aria-current={active || undefined}
              aria-describedby={previewEnabled ? previewId : undefined}
            >
              {IconComponent ? (
                <IconComponent className="size-3.5 shrink-0 text-fg-faint" />
              ) : (
                icon
              )}
              {labelContent ?? <span className="truncate">{label}</span>}
              {end}
            </button>
          </TitleHint>
          {menu && menu.length > 0 && (
            <button
              ref={buttonRef}
              type="button"
              onClick={() => {
                if (pendingActionRef.current) return;
                disarmPreview();
                const rect = buttonRef.current?.getBoundingClientRect();
                if (rect) {
                  setPosition({ x: rect.right, y: rect.bottom + 4 });
                }
                setOpen((value) => !value);
              }}
              className={`mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg ${
                open ? "" : "opacity-0 group-hover:opacity-100"
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

      {position && menu && (
        <MenuPortal
          open={open}
          position={position}
          entries={menu}
          onPick={(entry) => {
            pendingActionRef.current = entry;
            setOpen(false);
          }}
          onExited={() => {
            setPosition(null);
            const pendingAction = pendingActionRef.current;
            pendingActionRef.current = null;
            if (pendingAction) onAction(pendingAction);
          }}
        />
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
export function MenuPortal<TMenuEntry extends ContextMenuEntry>({
  open,
  position,
  entries,
  onPick,
  onExited,
}: {
  open: boolean;
  position: { x: number; y: number };
  entries: readonly TMenuEntry[];
  onPick: (entry: TMenuEntry) => void;
  onExited: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frozenEntriesRef = useRef(entries);
  const [adjusted, setAdjusted] = useState(position);
  if (open) frozenEntriesRef.current = entries;
  const visibleEntries = open ? entries : frozenEntriesRef.current;

  useEffect(() => {
    if (open) {
      menuButtons(ref)[0]?.focus();
      return;
    }
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      ref.current?.contains(activeElement)
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
    const next = { ...position };
    if (rect.bottom > window.innerHeight - 8) {
      next.y = Math.max(8, position.y - rect.height - 8);
    }
    if (rect.right > window.innerWidth - 8) {
      next.x = window.innerWidth - 8;
    }
    if (next.x !== adjusted.x || next.y !== adjusted.y) setAdjusted(next);
  }, [position, adjusted.x, adjusted.y]);

  return createPortal(
    <div
      ref={ref}
      data-sidebar-menu
      role="menu"
      onKeyDown={(event) => {
        const buttons = menuButtons(ref);
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
      }}
      style={{ left: adjusted.x, top: adjusted.y }}
      className={`fixed z-[140] min-w-44 -translate-x-full ${open ? "" : "pointer-events-none"}`}
    >
      <div
        onAnimationEnd={(event) => {
          if (event.animationName === "pop-out" && !open) onExited();
        }}
        className={`w-full origin-top-right rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl ${
          open ? "animate-pop-in" : "animate-pop-out"
        }`}
      >
        {visibleEntries.map((entry) => (
          <button
            key={`${entry.action}:${entry.label}`}
            type="button"
            role="menuitem"
            tabIndex={open ? 0 : -1}
            onClick={() => onPick(entry)}
            className={`flex h-7 w-full cursor-pointer items-center rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
              entry.danger
                ? "text-danger hover:bg-danger/10"
                : "text-fg-muted hover:bg-bg-raised hover:text-fg"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function menuButtons(
  ref: RefObject<HTMLDivElement | null>,
): HTMLButtonElement[] {
  return [
    ...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ??
      []),
  ];
}
