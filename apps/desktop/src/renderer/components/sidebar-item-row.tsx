import * as icons from "lucide-react";
import { MoreHorizontal } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { SidebarMenuEntry } from "../lib/desktop-api.js";
import { ShortcutHint } from "./shortcut-hint";

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
export function SidebarItemRow({
  label,
  title,
  icon,
  menu,
  onOpen,
  onAction,
  renaming,
  onRenameSubmit,
  onRenameCancel,
}: {
  label: string;
  /** Tooltip; usually the URL. */
  title?: string;
  /** lucide-react icon name, or a node to render directly. */
  icon?: string | ReactNode;
  menu?: SidebarMenuEntry[];
  onOpen: () => void;
  onAction: (entry: SidebarMenuEntry) => void;
  /** Swap the label for an inline rename field. */
  renaming?: boolean;
  onRenameSubmit?: (label: string) => void;
  onRenameCancel?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      // Clicks inside the portal menu handle themselves.
      if ((event.target as HTMLElement)?.closest?.("[data-sidebar-menu]")) {
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
    <div
      className="group relative flex h-7 items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay/60"
      data-point-key={`sidebar:${label}`}
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
          <TitleHint title={title}>
            <button
              type="button"
              onClick={onOpen}
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-[13px] text-fg-muted hover:text-fg"
            >
              {IconComponent ? (
                <IconComponent className="size-3.5 shrink-0 text-fg-faint" />
              ) : (
                icon
              )}
              <span className="truncate">{label}</span>
            </button>
          </TitleHint>
          {menu && menu.length > 0 && (
            <button
              ref={buttonRef}
              type="button"
              onClick={() => {
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

      {open && position && menu && (
        <MenuPortal
          position={position}
          entries={menu}
          onPick={(entry) => {
            setOpen(false);
            onAction(entry);
          }}
        />
      )}
    </div>
  );
}

/**
 * Portal-rendered so the sidebar's scroll container can't clip it — the
 * same lesson ShortcutHint learned (DOM checks pass while pixels clip).
 */
function MenuPortal({
  position,
  entries,
  onPick,
}: {
  position: { x: number; y: number };
  entries: SidebarMenuEntry[];
  onPick: (entry: SidebarMenuEntry) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState(position);

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
      style={{ left: adjusted.x, top: adjusted.y }}
      className="fixed z-[60] min-w-44 -translate-x-full rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl"
    >
      {entries.map((entry) => (
        <button
          key={`${entry.action}:${entry.label}`}
          type="button"
          role="menuitem"
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
    </div>,
    document.body,
  );
}
