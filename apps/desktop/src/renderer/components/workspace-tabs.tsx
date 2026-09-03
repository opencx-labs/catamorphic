import {
  AppWindow,
  Bot,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  FileCode,
  FileDiff,
  GitFork,
  Globe,
  LayoutGrid,
  MessageSquare,
  Plus,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  UserCog,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import { TAB_DRAG_TYPE, type TabDragPayload } from "../lib/tab-drag";
import { AnimatedTitle } from "./animated-title";
import { ChatGlyph, hasCustomChatIcon } from "./chat-icon";
import { SignalBadge, SignalGlyph } from "./chat-signals";
import { ShortcutHint } from "./shortcut-hint";

/**
 * Live activity signals mirrored onto a tab's icon — the same vocabulary
 * as the chat bubbles (chat-signals.tsx): spinner while working, dot for
 * unread, pencil for a draft (chat composer text, editor unsaved changes),
 * pulsing "?" for a waiting agent question.
 */
interface TabIndicators {
  /** Agent working → the icon cross-fades to a spinner. */
  working?: boolean;
  /** Response landed while the tab was hidden → dot on the icon. */
  unread?: boolean;
  /** A workflow requested user attention → pulsing dot on the icon. */
  attention?: boolean;
  /** Unsent draft (chat composer, editor changes) → pencil badge. */
  draft?: boolean;
  /** The agent asked and is waiting → pulsing "?" badge. */
  awaitingInput?: boolean;
  /** Chat group this tab belongs to (parent chat or attached surface). */
  groupId?: string;
  /** Secondary hover-card line: URL, file path, agent name … */
  detail?: string;
}

/** The card's status line — most urgent signal first. */
function tabStatusLine(tab: WorkspaceTab): string | null {
  if (tab.working) return "Agent is working…";
  if (tab.awaitingInput) return "The agent is waiting for your answer";
  if (tab.attention) return "Ready for you";
  if (tab.unread) return "New reply";
  if (tab.draft) {
    return tab.kind === "editor" ? "Unsaved changes" : "Unsent draft";
  }
  return null;
}

const HOVER_CARD_DELAY_MS = 500;
const TAB_EXIT_FALLBACK_MS = 280;

/**
 * Chrome-style tab hover card: the FULL title (the strip truncates at
 * ~20 chars), a per-kind detail line (page URL, file path, agent), and
 * the tab's live status. Portal-rendered below the tab; appears after a
 * short dwell so sweeping across the strip stays quiet.
 */
function TabHoverCard({
  tab,
  anchor,
  exiting,
  onExited,
}: {
  tab: WorkspaceTab;
  anchor: { x: number; y: number };
  exiting: boolean;
  onExited: () => void;
}) {
  const status = tabStatusLine(tab);
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - 296));
  return createPortal(
    <div
      role="tooltip"
      data-testid="tab-hover-card"
      style={{ left, top: anchor.y }}
      onAnimationEnd={(event) => {
        if (event.animationName === "fade-out" && exiting) onExited();
      }}
      className={`pointer-events-none fixed z-50 w-72 rounded-lg border border-border bg-bg-overlay p-2.5 shadow-2xl ${exiting ? "animate-fade-out" : "animate-fade-in"}`}
    >
      <p className="break-words text-[12px] font-medium leading-4 text-fg">
        {tab.label ?? tab.name}
      </p>
      {tab.detail && (
        <p className="mt-0.5 break-all text-[11px] leading-4 text-fg-muted">
          {tab.detail}
        </p>
      )}
      {status && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
          <span
            className={`size-1.5 rounded-full ${
              tab.working || tab.awaitingInput ? "bg-accent" : "bg-fg-faint"
            }`}
          />
          {status}
        </p>
      )}
    </div>,
    document.body,
  );
}

/** What a diff tab shows: a local working-tree diff, or a PR file patch. */
export type DiffSource =
  | {
      type: "local";
      worktreePath: string;
      filePath: string;
      mode: "uncommitted" | "vs-main";
    }
  | {
      type: "pr";
      prNumber: number;
      filePath: string;
      /** Unified-diff hunk text; null for binary or oversized files. */
      patch: string | null;
      status: string;
    };

export type WorkspaceTab = (
  | { kind: "workflow"; name: string; label?: string }
  | { kind: "app"; name: string; label?: string }
  | {
      kind: "chat";
      name: string;
      label?: string;
      /** Agent-chosen conversation icon ("<name>:<color>"). */
      chatIcon?: string | null;
      /** The chat is a fork of another conversation. */
      fork?: boolean;
    }
  | {
      kind: "browser";
      name: string;
      label?: string;
      faviconUrl?: string | null;
    }
  | { kind: "settings"; name: string; label?: string }
  | { kind: "profile-settings"; name: string; label?: string }
  | { kind: "usage"; name: string; label?: string }
  | { kind: "palette"; name: string; label?: string }
  | { kind: "agent-setup"; name: string; label?: string }
  | { kind: "terminal"; name: string; label?: string }
  | { kind: "editor"; name: string; label?: string }
  | {
      /** A read-only file diff (sidebar Changes / Pull Requests rows). */
      kind: "diff";
      name: string;
      label?: string;
      projectId: string;
      source: DiffSource;
    }
  | {
      /** An MCP Apps view (a connection tool's ui:// template). */
      kind: "mcpapp";
      name: string;
      label?: string;
      toolKey: string;
      toolInput?: unknown;
      toolResult?: unknown;
    }
) &
  TabIndicators;

export const tabKey = (tab: WorkspaceTab) => `${tab.kind}:${tab.name}`;

const TAB_ICONS = {
  workflow: WorkflowIcon,
  app: LayoutGrid,
  chat: MessageSquare,
  browser: Globe,
  settings: SettingsIcon,
  "profile-settings": UserCog,
  usage: ChartColumn,
  palette: Search,
  "agent-setup": Bot,
  terminal: SquareTerminal,
  editor: FileCode,
  diff: FileDiff,
  mcpapp: AppWindow,
} as const;

interface RenderedTab {
  tab: WorkspaceTab;
  exiting: boolean;
}

/**
 * Merge incoming tabs with the previous render list so removed tabs stay
 * mounted (near their old position) while their exit animation plays. The
 * width collapse of an exiting tab is what slides its neighbors over.
 * Surviving tabs follow the INCOMING order — drag-reordering must move
 * them, not freeze them at their first-render positions.
 */
function mergeRendered(
  previous: RenderedTab[],
  tabs: WorkspaceTab[],
): RenderedTab[] {
  const incoming = new Set(tabs.map((tab) => tabKey(tab)));
  const merged: RenderedTab[] = tabs.map((tab) => ({ tab, exiting: false }));
  previous.forEach((entry, index) => {
    if (incoming.has(tabKey(entry.tab))) return;
    merged.splice(Math.min(index, merged.length), 0, {
      tab: entry.tab,
      exiting: true,
    });
  });
  return merged;
}

function CloseButton({
  hint,
  label,
  className,
  onClick,
}: {
  hint: boolean;
  label: string;
  className: string;
  onClick: () => void;
}) {
  const keybindings = useKeybindings();
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={`grid size-5 cursor-pointer place-items-center rounded text-fg-faint transition-opacity duration-150 hover:text-fg ${className}`}
      aria-label={label}
    >
      <X className="size-3" />
    </button>
  );
  return hint ? (
    <ShortcutHint
      label="Close tab"
      shortcut={formatBinding(keybindings["close-tab"])}
    >
      {button}
    </ShortcutHint>
  ) : (
    <ShortcutHint label={label}>{button}</ShortcutHint>
  );
}

/**
 * Tab strip only — the host owns the surrounding top bar (drag region,
 * sidebar toggle) so tabs and window chrome share one row.
 */
export interface TabGroup {
  /** The owning chat's tab key. */
  parentKey: string;
  /** Attached tab keys, in strip order (empty when collapsed hides them). */
  memberKeys: string[];
  collapsed: boolean;
}

export function WorkspaceTabBar({
  tabs,
  activeKey,
  secondaryKey,
  highlightKey,
  groups = [],
  onSelect,
  onClose,
  onNew,
  onToggleGroup,
  onReorder,
  onDragStateChange,
}: {
  tabs: WorkspaceTab[];
  activeKey?: string;
  /** The unfocused pane of a split view — styled active but muted. */
  secondaryKey?: string;
  /**
   * Tab a highlighted palette command would act on — rendered with an
   * accent border so "Close tab" (etc.) points at its target before Enter.
   */
  highlightKey?: string;
  /** Chat groups: parent chat tab + its attached surfaces. */
  groups?: TabGroup[];
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Chrome-style + after the last tab; always opens a new tab. */
  onNew?: () => void;
  /** Fold/unfold a group's members (by the owning chat's localId). */
  onToggleGroup?: (chatLocalId: string) => void;
  /** Drag-reorder: move `key` before `beforeKey` (null = to the end). */
  onReorder?: (key: string, beforeKey: string | null) => void;
  /** A tab drag started (key) or ended (null) — hosts show drop zones. */
  onDragStateChange?: (key: string | null) => void;
}) {
  const keybindings = useKeybindings();
  const [rendered, setRendered] = useState<RenderedTab[]>(() =>
    mergeRendered([], tabs),
  );
  const prevTabsRef = useRef(tabs);
  if (prevTabsRef.current !== tabs) {
    prevTabsRef.current = tabs;
    setRendered((previous) => mergeRendered(previous, tabs));
  }
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropBeforeKey, setDropBeforeKey] = useState<string | null>(null);
  // Hover card: armed by dwelling on a tab's body, disarmed by leaving,
  // clicking, or starting a drag.
  const [hoverCard, setHoverCard] = useState<{
    key: string;
    x: number;
    y: number;
    exiting: boolean;
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(hoverTimerRef.current), []);
  const armHoverCard = (key: string, element: HTMLElement) => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const rect = element.getBoundingClientRect();
      setHoverCard({ key, x: rect.left, y: rect.bottom + 8, exiting: false });
    }, HOVER_CARD_DELAY_MS);
  };
  const disarmHoverCard = () => {
    clearTimeout(hoverTimerRef.current);
    setHoverCard((current) => (current ? { ...current, exiting: true } : null));
  };
  const groupByParent = new Map(
    groups.map((group) => [group.parentKey, group]),
  );
  const lastMemberKeys = new Map(
    groups
      .filter((group) => !group.collapsed && group.memberKeys.length > 0)
      .map((group) => [group.memberKeys.at(-1) as string, group]),
  );

  const removeExited = (key: string) =>
    setRendered((previous) =>
      previous.filter((entry) => !(entry.exiting && tabKey(entry.tab) === key)),
    );
  // Hidden or occluded Chromium windows can pause CSS animations and omit
  // animationend. Keep the event as the precise visible-window path, with a
  // clock fallback beyond tab-out's 180ms duration so ghost tabs cannot stay
  // mounted forever after their underlying surface has closed.
  const exitingKeys = JSON.stringify(
    rendered.filter((entry) => entry.exiting).map((entry) => tabKey(entry.tab)),
  );
  useEffect(() => {
    const keys: string[] = JSON.parse(exitingKeys);
    if (keys.length === 0) return;
    const exiting = new Set(keys);
    const timer = window.setTimeout(
      () =>
        setRendered((previous) =>
          previous.filter(
            (entry) => !(entry.exiting && exiting.has(tabKey(entry.tab))),
          ),
        ),
      TAB_EXIT_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exitingKeys]);

  if (rendered.length === 0 && !onNew) return null;
  return (
    // overflow-y-hidden: tabs hang 1px below the row (-mb-px overlaps the
    // border), and overflow-x-auto alone turns that spill into a phantom
    // vertical scrollbar in the corner.
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target for tab reordering; tabs themselves are buttons
    <div
      className="app-no-drag flex min-w-0 flex-1 items-end gap-1 self-stretch overflow-x-auto overflow-y-hidden"
      onDragOver={(event) => {
        if (dragKey) {
          event.preventDefault();
          setDropBeforeKey(null);
        }
      }}
      onDrop={(event) => {
        if (!dragKey) return;
        event.preventDefault();
        onReorder?.(dragKey, null);
        setDragKey(null);
        setDropBeforeKey(null);
        onDragStateChange?.(null);
      }}
    >
      {rendered.map(({ tab, exiting }, index) => {
        const key = tabKey(tab);
        const active = !exiting && key === activeKey;
        const secondary = !exiting && key === secondaryKey;
        const highlighted = !exiting && key === highlightKey;
        const Icon = TAB_ICONS[tab.kind];
        const parentGroup = groupByParent.get(key);
        const closesGroup = !exiting ? lastMemberKeys.get(key) : undefined;
        // The split pair merges into one bubble when adjacent: facing
        // corners square off, inner borders drop, and the gap closes.
        const inPair =
          !exiting &&
          Boolean(secondaryKey) &&
          (key === activeKey || key === secondaryKey);
        const neighborInPair = (neighbor?: RenderedTab) =>
          Boolean(
            neighbor &&
              !neighbor.exiting &&
              tabKey(neighbor.tab) !== key &&
              (tabKey(neighbor.tab) === activeKey ||
                tabKey(neighbor.tab) === secondaryKey),
          );
        const mergeRight = inPair && neighborInPair(rendered[index + 1]);
        const mergeLeft = inPair && neighborInPair(rendered[index - 1]);
        return (
          <Fragment key={key}>
            <div
              data-palette-target={highlighted || undefined}
              data-point-key={key}
              draggable={Boolean(onReorder) && !exiting}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", key);
                // A tab dropped on a chat becomes a tab pill (the chat
                // reads this flavor; the strip's own reorder reads the key).
                event.dataTransfer.setData(
                  TAB_DRAG_TYPE,
                  JSON.stringify({
                    key,
                    kind: tab.kind,
                    title: tab.label ?? tab.name,
                    detail: tab.detail,
                  } satisfies TabDragPayload),
                );
                event.dataTransfer.effectAllowed = "copyMove";
                disarmHoverCard();
                setDragKey(key);
                onDragStateChange?.(key);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDropBeforeKey(null);
                onDragStateChange?.(null);
              }}
              onDragOver={(event) => {
                if (!dragKey || dragKey === key) return;
                event.preventDefault();
                event.stopPropagation();
                setDropBeforeKey(key);
              }}
              onDragLeave={() =>
                setDropBeforeKey((current) =>
                  current === key ? null : current,
                )
              }
              onDrop={(event) => {
                if (!dragKey || dragKey === key) return;
                event.preventDefault();
                event.stopPropagation();
                onReorder?.(dragKey, key);
                setDragKey(null);
                setDropBeforeKey(null);
                onDragStateChange?.(null);
              }}
              onAnimationEnd={(event) => {
                if (event.animationName === "tab-out") removeExited(key);
              }}
              className={`group -mb-px flex h-8 shrink-0 items-center rounded-t-lg border px-1 text-[12px] transition-[margin,border-radius,color,background-color,border-color] duration-150 ${
                mergeRight ? "rounded-tr-none border-r-0 " : ""
              }${mergeLeft ? "-ml-1 rounded-tl-none border-l-0 " : ""}${
                tab.groupId ? "border-t-2 border-t-accent/40 " : ""
              }${dragKey === key ? "opacity-50 " : ""}${
                dropBeforeKey === key ? "border-l-2 border-l-accent " : ""
              }${
                exiting
                  ? "animate-tab-out pointer-events-none"
                  : "animate-tab-in"
              } ${
                highlighted
                  ? active
                    ? "border-accent border-b-bg bg-bg text-fg"
                    : "border-accent text-fg"
                  : active
                    ? "border-border border-b-bg bg-bg text-fg"
                    : secondary
                      ? "border-border border-b-bg bg-bg text-fg-muted"
                      : "border-transparent text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
              }`}
              aria-hidden={exiting || undefined}
            >
              <button
                type="button"
                onClick={() => {
                  disarmHoverCard();
                  onSelect(key);
                }}
                onMouseEnter={(event) => {
                  if (!exiting && !dragKey) {
                    armHoverCard(key, event.currentTarget);
                  }
                }}
                onMouseLeave={disarmHoverCard}
                className="flex cursor-pointer items-center gap-1.5 px-1.5"
              >
                {/* Same signal vocabulary as the chat bubbles: spinner
                  while working; unread/draft/question land as badges. */}
                <span className="relative grid size-3.5 shrink-0 place-items-center">
                  <SignalGlyph
                    working={tab.working ?? false}
                    className="size-3.5"
                  >
                    {tab.kind === "browser" && tab.faviconUrl ? (
                      <img
                        src={tab.faviconUrl}
                        alt=""
                        className="size-3.5 rounded-[3px]"
                      />
                    ) : tab.kind === "chat" ? (
                      <ChatGlyph
                        icon={tab.chatIcon}
                        fork={tab.fork}
                        className="size-3.5"
                      />
                    ) : (
                      <Icon className="size-3.5" />
                    )}
                  </SignalGlyph>
                  {/* A custom conversation icon still reads as a chat: a
                      tiny chat marker rides the glyph's corner. */}
                  {tab.kind === "chat" && hasCustomChatIcon(tab.chatIcon) && (
                    <span className="absolute -bottom-1 -right-1 grid size-2.5 place-items-center rounded-full bg-bg-raised">
                      {tab.fork ? (
                        <GitFork className="size-1.5 text-fg-muted" />
                      ) : (
                        <MessageSquare className="size-1.5 text-fg-muted" />
                      )}
                    </span>
                  )}
                  <span className="absolute -right-1 -top-1">
                    <SignalBadge
                      signals={{
                        working: tab.working,
                        unread: tab.unread,
                        attention: tab.attention,
                        draft: tab.draft,
                        awaitingInput: tab.awaitingInput,
                      }}
                      size="sm"
                    />
                  </span>
                </span>
                <AnimatedTitle
                  text={tab.label ?? tab.name}
                  className="max-w-40"
                />
              </button>
              {/* Collapsed group parent: expand its folded surfaces. */}
              {parentGroup?.collapsed && onToggleGroup && (
                <ShortcutHint label="Expand grouped tabs">
                  <button
                    type="button"
                    onClick={() =>
                      onToggleGroup(parentGroup.parentKey.slice("chat:".length))
                    }
                    className="flex h-5 cursor-pointer items-center gap-0.5 rounded px-1 text-[10px] text-accent/80 transition-colors duration-150 hover:bg-bg-overlay hover:text-accent"
                    aria-label={`Expand ${parentGroup.memberKeys.length} grouped tabs`}
                  >
                    <ChevronsRight className="size-3" />
                    {parentGroup.memberKeys.length}
                  </button>
                </ShortcutHint>
              )}
              {/* ⌘W closes the ACTIVE tab, so only its X advertises it. */}
              <CloseButton
                hint={active}
                label={`Close ${tab.label ?? tab.name}`}
                className={active ? "" : "opacity-0 group-hover:opacity-100"}
                onClick={() => onClose(key)}
              />
            </div>
            {/* Last member of an expanded group: fold the group away. */}
            {closesGroup && onToggleGroup && (
              <span className="self-center">
                <ShortcutHint label="Collapse grouped tabs">
                  <button
                    type="button"
                    onClick={() =>
                      onToggleGroup(closesGroup.parentKey.slice("chat:".length))
                    }
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-accent/70 transition-colors duration-150 hover:bg-bg-overlay hover:text-accent"
                    aria-label="Collapse grouped tabs"
                  >
                    <ChevronsLeft className="size-3.5" />
                  </button>
                </ShortcutHint>
              </span>
            )}
          </Fragment>
        );
      })}
      {(() => {
        const hovered = hoverCard
          ? rendered.find(
              (entry) => !entry.exiting && tabKey(entry.tab) === hoverCard.key,
            )
          : null;
        return hovered && hoverCard ? (
          <TabHoverCard
            tab={hovered.tab}
            anchor={hoverCard}
            exiting={hoverCard.exiting}
            onExited={() =>
              setHoverCard((current) =>
                current?.exiting && current.key === hoverCard.key
                  ? null
                  : current,
              )
            }
          />
        ) : null;
      })()}
      {onNew && (
        // self-stretch + items-center: the + rides mid-row like the
        // sidebar toggle, not glued to the tabs' hanging baseline. The
        // ShortcutHint wrapper is the flex item, so centering lives on
        // this container, not the button.
        <div className="flex shrink-0 items-center self-stretch">
          <ShortcutHint
            label="New tab"
            shortcut={formatBinding(keybindings["new-tab"])}
          >
            <button
              type="button"
              onClick={onNew}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              aria-label="New tab"
            >
              <Plus className="size-4" />
            </button>
          </ShortcutHint>
        </div>
      )}
    </div>
  );
}
