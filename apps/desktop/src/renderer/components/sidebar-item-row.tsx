import { useItemActions } from "@catamorphic/app/ui";
import * as icons from "lucide-react";
import { ChevronRight, LoaderCircle, MoreHorizontal } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  dangerLast,
  isMenuSeparator,
  type MenuSeparator,
  menuGroups,
} from "../../shared/menu.js";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeForAction,
  openModeFromEvent,
} from "../../shared/open-mode.js";
import type {
  SidebarBadge,
  SidebarSignal,
  SidebarTrend,
} from "../../shared/sidebar.js";
import { appIsMovingFocus } from "../lib/app-focus.js";
import type { SidebarMenuEntry, SidebarPreview } from "../lib/desktop-api.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import { TONE_TEXT } from "../lib/tones.js";
import { AnimatedTitle } from "./animated-title.js";
import { SignalBadge, SignalGlyph } from "./chat-signals.js";
import {
  type ContextMenuEntry,
  type MenuAt,
  MenuPortal,
  menuAtControl,
  menuAtPointer,
} from "./menu.js";
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
import { Sparkline } from "./sparkline.js";

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
  keepDescription = false,
  badges,
  progress,
  trend,
  signal,
  presentation = "row",
  expanded,
  resource = false,
  defaultOpenMode = "replace",
  label,
  pointKey,
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
  /**
   * A short identifier (a pull request's number) stays whole and the label
   * gives way instead; a long description (a path) shrinks first.
   */
  keepDescription?: boolean;
  badges?: readonly (string | SidebarBadge)[];
  progress?: number;
  /** A reading's recent history, drawn as a sparkline (ADR 0263). */
  trend?: SidebarTrend;
  /** What the row is doing, drawn the same everywhere (ADR 0234). */
  signal?: SidebarSignal;
  presentation?: "row" | "tile";
  expanded?: boolean;
  resource?: boolean;
  defaultOpenMode?: OpenMode;
  label: string;
  /**
   * What an agent points at to reach this row: "sidebar:<label>", or the
   * tab key of the open tab the row stands for.
   */
  pointKey?: string;
  /** Tooltip; usually the URL. */
  title?: string;
  /** lucide-react icon name, or a node to render directly. */
  icon?: string | ReactNode;
  menu?: readonly TMenuEntry[];
  /** The row's own menu when no configuration replaces it; may hold rules. */
  defaultMenu?: readonly (TMenuEntry | MenuSeparator)[];
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
  const [menuAt, setMenuAt] = useState<MenuAt | null>(null);
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
  // Every entry this row was given, the ones it can actually run.
  const ownEntries = [
    ...(defaultMenu ?? []).filter(
      (entry): entry is TMenuEntry => !isMenuSeparator(entry),
    ),
    ...(menu ?? []),
    ...(contextMenu ?? []),
    ...(actions ?? []),
  ];
  const supports = (entry: ContextMenuEntry) =>
    Boolean(entry.url) ||
    (resource &&
      (Boolean(openModeForAction(entry.action)) || entry.action === "open")) ||
    (supportedActions
      ? supportedActions.includes(entry.action)
      : ownEntries.some((original) => original.action === entry.action)) ||
    (["refresh", "search"].includes(entry.action) &&
      Boolean(contribution?.commands?.has(entry.action)));
  const available = (
    entries: readonly (ContextMenuEntry | MenuSeparator)[],
  ): (ContextMenuEntry | MenuSeparator)[] =>
    entries.map((entry) =>
      isMenuSeparator(entry)
        ? entry
        : {
            ...entry,
            disabledReason:
              entry.disabledReason ??
              (supports(entry)
                ? undefined
                : "This item does not support this action"),
          },
    );
  const resolvedMenu = available(
    overrides.menu ??
      (menu === undefined
        ? menuGroups<ContextMenuEntry>(
            resource ? OPEN_ACTIONS : [],
            dangerLast(defaultMenu ?? []),
          )
        : menu),
  );
  const resolvedContext = available(configuredContext ?? resolvedMenu);
  const inlineActions = available(configuredActions).filter(
    (entry): entry is ContextMenuEntry => !isMenuSeparator(entry),
  );
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
          const original = ownEntries.find(
            (candidate) => candidate.action === entry.action,
          );
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
  trend = overrides.trend ?? trend;
  signal = overrides.signal ?? signal;
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
      data-point-key={pointKey ?? `sidebar:${label}`}
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
        // Nor does focus the app moves (an opening sidebar's, onto what is
        // already in front).
        if (
          document.documentElement.dataset.focusModality !== "pointer" &&
          !appIsMovingFocus()
        )
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
              setMenuAt(menuAtPointer(event));
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
          if (rowRef.current) {
            setMenuKind("context");
            setMenuAt(menuAtControl(rowRef.current));
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
              className={`flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-[13px] ${presentation === "tile" ? "justify-center" : ""} hover:text-fg ${
                active ? "text-fg" : "text-fg-muted"
              }`}
              aria-expanded={disclosure?.open ?? expanded}
              aria-current={active || undefined}
              aria-details={
                previewEnabled && previewOpen ? previewId : undefined
              }
            >
              <SignalGlyph working={signal === "working"} className="size-3.5">
                {IconComponent ? (
                  <IconComponent className="size-3.5 shrink-0 text-fg-faint" />
                ) : (
                  icon
                )}
              </SignalGlyph>
              {presentation === "tile" ? (
                <span className="sr-only">{label}</span>
              ) : (
                (labelContent ?? (
                  // The label is what people read: it keeps its width and the
                  // description gives way first when the row is narrow. A
                  // renamed row says so (a chat its agent titled).
                  <AnimatedTitle text={label} className="min-w-0 flex-auto" />
                ))
              )}
              {description && (
                <span
                  className={`text-[11px] text-fg-faint ${
                    keepDescription
                      ? "shrink-0 whitespace-nowrap"
                      : "min-w-0 max-w-32 shrink-[3] truncate"
                  }`}
                >
                  {description}
                </span>
              )}
              {badges?.map((badge) => {
                const text = typeof badge === "string" ? badge : badge.label;
                const BadgeIcon =
                  typeof badge === "string"
                    ? undefined
                    : lucideIcon(badge.icon);
                const tone = typeof badge === "string" ? undefined : badge.tone;
                return (
                  <span
                    key={text}
                    data-tone={tone}
                    className={`flex max-w-28 shrink-0 items-center gap-1 truncate rounded bg-bg-inset px-1 text-[10px] transition-colors duration-150 ${tone ? TONE_TEXT[tone] : "text-fg-muted"}`}
                  >
                    {BadgeIcon && (
                      <BadgeIcon
                        className="size-2.5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{text}</span>
                  </span>
                );
              })}
              {progress !== undefined && (
                <progress
                  aria-label={`${label} progress`}
                  value={progress}
                  max={1}
                  className="h-1 w-12 accent-accent"
                />
              )}
              {trend && presentation !== "tile" && <Sparkline trend={trend} />}
              {(signal === "attention" || signal === "unread") && (
                <span
                  data-signal={signal}
                  className="grid size-3 shrink-0 place-items-center"
                >
                  <SignalBadge
                    signals={{
                      attention: signal === "attention",
                      unread: signal === "unread",
                    }}
                    size="sm"
                  />
                  <span className="sr-only">
                    {signal === "attention" ? "Ready for you" : "Unread"}
                  </span>
                </span>
              )}
              {signal === "working" && (
                <span data-signal="working" className="sr-only">
                  Working
                </span>
              )}
              {end}
            </button>
          </TitleHint>
          {/* Before the row's controls, so its last stays at its end. */}
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
          {inlineActions.map((entry, index) => {
            const Icon = lucideIcon(entry.icon) ?? icons.Circle;
            // The row's last control sits where ⋯ or the chevron would.
            const last =
              index === inlineActions.length - 1 &&
              !disclosure &&
              (resolvedMenu.length === 0 || presentation === "tile");
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
                  // Row buttons show with the row's hover or focus, as ⋯ does.
                  className={`grid size-6 shrink-0 place-items-center rounded text-fg-muted hover:bg-bg-overlay disabled:opacity-40 ${
                    last ? "mr-0.5" : ""
                  } ${pending === entry.action ? "" : "row-reveal"}`}
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
              onClick={() => {
                if (pendingActionRef.current || !buttonRef.current) return;
                disarmPreview();
                setMenuAt(menuAtControl(buttonRef.current));
                setMenuKind("overflow");
                setOpen(true);
              }}
              className={`grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg ${
                disclosure ? "" : "mr-0.5"
              } ${open ? "" : "row-reveal"}`}
              aria-label={`More actions for ${label}`}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          )}
          {/* The disclosure ends the row, as it ends a section's header:
              every row's icon starts at the same place, so only a child's
              indent reads as belonging to the row above. The row's last
              control (this, or ⋯) is centered under the header's chevron. */}
          {disclosure && (
            <button
              type="button"
              onClick={disclosure.onToggle}
              className="mr-0.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
              aria-label={`${disclosure.open ? "Collapse" : "Expand"} ${label}`}
              aria-expanded={disclosure.open}
              data-row-disclosure=""
            >
              <ChevronRight
                className={`size-3 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${disclosure.open ? "rotate-90" : ""}`}
              />
            </button>
          )}
        </>
      )}

      {menuAt && (
        <MenuPortal
          open={open}
          at={menuAt}
          anchor={rowRef}
          label={`Actions for ${label}`}
          entries={activeMenu}
          onDismiss={() => setOpen(false)}
          onPick={(entry) => {
            pendingActionRef.current = entry;
            setOpen(false);
          }}
          onExited={() => {
            setMenuAt(null);
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
