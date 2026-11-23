import { Clock, Puzzle } from "lucide-react";
import { mergeRendered, type RenderedTab } from "../lib/rendered-tabs.js";
import { tabKey, type WorkspaceTab } from "../lib/workspace-types.js";

export {
  type DiffSource,
  tabKey,
  type WorkflowDraft,
  type WorkspaceTab,
} from "../lib/workspace-types.js";

import {
  AppWindow,
  Bot,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  Compass,
  Download,
  FileCode,
  FileDiff,
  Ghost,
  GitFork,
  Globe,
  KeyRound,
  LayoutGrid,
  MessageSquare,
  Plus,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  SquareTerminal,
  UserCog,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import {
  type AnimationEvent,
  type ComponentType,
  type DragEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { OpenMode } from "../../shared/open-mode.js";
import { useEndOfDrag } from "../lib/drag-end.js";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import { usePageDialogsWaiting } from "../lib/page-dialogs.js";
import { useLatestHandlers, useStableEntries } from "../lib/stable.js";
import { TAB_DRAG_TYPE, type TabDragPayload } from "../lib/tab-drag";
import { useWindowImage } from "../lib/window-images";
import { AnimatedTitle } from "./animated-title";
import { AppGlyph } from "./app-icon";
import { ChatGlyph, hasCustomChatIcon } from "./chat-icon";
import { ACTIVITY_LABELS, SignalBadge, SignalGlyph } from "./chat-signals";
import type { FileTarget } from "./file-menu.js";
import {
  OpenResourceButton,
  type ResourceActions,
} from "./open-resource-button.js";
import { ShortcutHint } from "./shortcut-hint";

/**
 * The card's status line, as the icon's corners say it: what needs the
 * person, then what the tab is doing.
 */
function tabStatusLine(tab: WorkspaceTab): string | null {
  if (tab.kind === "browser" && tab.pageDialog)
    return "The page is waiting for your answer";
  if (tab.awaitingInput) return "The agent is waiting for your answer";
  const needs = tab.attention
    ? "Ready for you"
    : tab.unread
      ? "New reply"
      : tab.draft
        ? tab.kind === "editor" || tab.kind === "workflow"
          ? "Unsaved changes"
          : "Unsent draft"
        : null;
  const activity = tab.activity;
  const doing =
    activity === "working"
      ? "Agent is working…"
      : activity
        ? ACTIVITY_LABELS[activity]
        : null;
  if (needs || doing) return [needs, doing].filter(Boolean).join(" · ");
  if (tab.kind === "browser" && tab.sharingWith)
    return `Shared with ${tab.sharingWith}. Stays loaded while shared`;
  if (tab.kind === "browser" && tab.asleep)
    return "Asleep to save memory. Opens where you left off";
  if (tab.kind === "browser" && tab.incognito)
    return "Incognito. Keeps no history and does not reopen after Work quits";
  return null;
}

/**
 * A sleeping tab (ADR 0194) reads as Chrome's: its icon fades behind a
 * dashed ring. The ring sits in the icon's own box, so nothing shifts.
 */
function SleepRing({ tab }: { tab: WorkspaceTab }) {
  if (tab.kind !== "browser" || !tab.asleep) return null;
  return (
    <span
      aria-hidden="true"
      data-tab-asleep=""
      className="pointer-events-none absolute -inset-[3px] animate-fade-in rounded-full border border-dashed border-fg-muted"
    />
  );
}

/**
 * A tab a page in this window shares (ADR 0315) wears an accent ring, as
 * Chrome marks a captured tab. Always mounted for a page, so the ring
 * fades both ways in the icon's own box.
 */
function ShareRing({ tab }: { tab: WorkspaceTab }) {
  if (tab.kind !== "browser") return null;
  return (
    <span
      aria-hidden="true"
      data-tab-shared={tab.sharingWith ? "" : undefined}
      className={`pointer-events-none absolute -inset-[3px] rounded-full border-[1.5px] border-accent transition-opacity duration-200 ease-standard ${
        tab.sharingWith ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}

const sleepingGlyph = (tab: WorkspaceTab) =>
  `transition-[opacity,filter,scale] duration-200 ease-standard ${
    tab.kind === "browser" && tab.asleep ? "scale-80 opacity-50 grayscale" : ""
  }`;

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

const TAB_ICONS = {
  workflow: WorkflowIcon,
  run: WorkflowIcon,
  app: LayoutGrid,
  artifact: AppWindow,
  chat: MessageSquare,
  browser: Globe,
  settings: SettingsIcon,
  "profile-settings": UserCog,
  history: Clock,
  sites: SlidersHorizontal,
  passwords: KeyRound,
  downloads: Download,
  extensions: Puzzle,
  usage: ChartColumn,
  palette: Search,
  "agent-setup": Bot,
  onboarding: Compass,
  terminal: SquareTerminal,
  editor: FileCode,
  diff: FileDiff,
  mcpapp: AppWindow,
} as const;

/**
 * The icon the tab's page showed, from main (ADR 0277), or the tab's own
 * glyph while there is none.
 */
function PageIcon({
  icon,
  className,
  fallback: Fallback,
}: {
  icon: string | null;
  className: string;
  fallback: ComponentType<{ className?: string }>;
}) {
  const source = useWindowImage(icon ? { site: { icon } } : null);
  return source ? (
    <img src={source} alt="" className={`${className} rounded-[3px]`} />
  ) : (
    <Fallback className={className} />
  );
}

/**
 * A tab's close button takes no room in the strip: it rides over the end of
 * the tab's label (`.workspace-tab-close` in styles.css), showing while the
 * tab is hovered or holds keyboard focus, as the title's end fades under it.
 */
function CloseButton({
  hint,
  label,
  onClick,
}: {
  hint: boolean;
  label: string;
  onClick: () => void;
}) {
  const keybindings = useKeybindings();
  const button = (
    <button
      type="button"
      onClick={onClick}
      className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg"
      aria-label={label}
    >
      <X className="size-3" />
    </button>
  );
  const className = "workspace-tab-close";
  return hint ? (
    <ShortcutHint
      label="Close tab"
      shortcut={formatBinding(keybindings["close-tab"])}
      className={className}
    >
      {button}
    </ShortcutHint>
  ) : (
    <ShortcutHint label={label} className={className}>
      {button}
    </ShortcutHint>
  );
}

/**
 * Tab strip only — the host owns the surrounding top bar (drag region,
 * sidebar toggle) so tabs and window chrome share one row.
 */
/** Where a tab's stretch of its group's eyebrow ends. */
type EyebrowEnd = "bridge" | "chevron" | "tab";

export interface TabGroup {
  /** The owning chat's tab key. */
  parentKey: string;
  /** Attached tab keys, in strip order (empty when collapsed hides them). */
  memberKeys: string[];
  collapsed: boolean;
}

/** How far across a tab, 0 to 1, the pointer is. */
function dropRatio(element: HTMLElement, clientX: number) {
  const rect = element.getBoundingClientRect();
  return (clientX - rect.left) / Math.max(1, rect.width);
}

export const WorkspaceTabBar = memo(function WorkspaceTabBar(
  props: Parameters<typeof TabStrip>[0],
) {
  // A tab whose page waits on its dialog says so (ADR 0227); one out of
  // sight also wears the waiting question's badge. A tab on screen shows
  // the dialog itself.
  const waiting = usePageDialogsWaiting();
  const { activeKey, secondaryKey } = props;
  const tabs = useMemo(
    () =>
      waiting.size === 0
        ? props.tabs
        : props.tabs.map((tab) => {
            const key = tabKey(tab);
            if (tab.kind !== "browser" || !waiting.has(key)) return tab;
            const onScreen = key === activeKey || key === secondaryKey;
            return {
              ...tab,
              pageDialog: true,
              ...(onScreen ? {} : { awaitingInput: true }),
            };
          }),
    [props.tabs, waiting, activeKey, secondaryKey],
  );
  // A waiting tab is rebuilt whenever the list is: the rows compare it.
  const stable = useStableEntries(tabs, tabKey);
  return <TabStrip {...props} tabs={stable} />;
});

/**
 * What a row asks of its strip. The same functions for the strip's life
 * (they read the strip's latest props and state), so a row renders only
 * when what it shows changed.
 */
interface StripActions {
  element(id: string, element: HTMLElement | null): void;
  updateTitle(id: string): void;
  open(key: string, mode: OpenMode): void;
  close(key: string): void;
  toggleGroup(chatLocalId: string): void;
  hover(key: string, element: HTMLElement, exiting: boolean): void;
  unhover(): void;
  dragStart(event: DragEvent<HTMLElement>, tab: WorkspaceTab): void;
  dragEnd(): void;
  dragOver(event: DragEvent<HTMLElement>, tab: WorkspaceTab): void;
  dragLeave(key: string): void;
  drop(event: DragEvent<HTMLElement>, tab: WorkspaceTab): void;
  animationEnd(
    event: AnimationEvent<HTMLElement>,
    id: string,
    key: string,
  ): void;
  /** Asked as the tab's menu opens. */
  file(key: string): FileTarget | undefined;
  actions(
    key: string,
    group: { chatLocalId: string; collapsed: boolean } | undefined,
  ): ResourceActions | undefined;
}

/** Tabs with less than this much room for a clipped title become icon-only. */
const NARROW_TITLE_PX = 20;

function markNarrowTitle(title: Element) {
  title
    .closest(".workspace-tab")
    ?.toggleAttribute(
      "data-tab-narrow",
      title.clientWidth < NARROW_TITLE_PX &&
        title.scrollWidth > title.clientWidth,
    );
}

function TabStrip({
  alignment = "start",
  overflow = "scroll",
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
  onAttach,
  attachable,
  onDragStateChange,
  tabFile,
  tabActions,
}: {
  alignment?: "start" | "center";
  overflow?: "scroll" | "shrink";
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
  onSelect: (key: string, mode?: OpenMode) => void;
  onClose: (key: string) => void;
  /** Chrome-style + after the last tab; always opens a new tab. */
  onNew?: () => void;
  /** Fold/unfold a group's members (by the owning chat's localId). */
  onToggleGroup?: (chatLocalId: string) => void;
  /** Drag-reorder: move `key` before `beforeKey` (null = to the end). */
  onReorder?: (key: string, beforeKey: string | null) => void;
  /**
   * A tab dropped on a chat's tab, or among another group's tabs, joins
   * that chat (`chatKey`); dropped among the top tabs, null, it leaves its
   * chat. Lands before `beforeKey` (null: last).
   */
  onAttach?: (
    key: string,
    chatKey: string | null,
    beforeKey: string | null,
  ) => void;
  /** Whether a tab may join that chat (or, with null, leave its own). */
  attachable?: (key: string, chatKey: string | null) => boolean;
  /** A tab drag started (key) or ended (null) — hosts show drop zones. */
  onDragStateChange?: (key: string | null) => void;
  /**
   * The file a tab shows (an editor's): its menu adds the file's actions.
   * Asked as the menu opens.
   */
  tabFile?: (key: string) => FileTarget | undefined;
  /**
   * What a tab's resource does itself (a chat's verbs), after opening it.
   * Asked as the menu opens.
   */
  tabActions?: (key: string) => ResourceActions | undefined;
}) {
  const keybindings = useKeybindings();
  const [rendered, setRendered] = useState<RenderedTab[]>(() =>
    mergeRendered([], tabs),
  );
  // Tabs whose entrance has played. They drop its class, and the clip it
  // needs while the width grows, so a group's eyebrow can sit above them.
  const [entered, setEntered] = useState<ReadonlySet<string>>(() => new Set());
  // The tabs as last drawn: a departing tab collapses from its real width.
  const tabElementsRef = useRef(new Map<string, HTMLElement>());
  const narrowObserverRef = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    if (overflow !== "shrink" || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const { target } of entries) markNarrowTitle(target);
    });
    narrowObserverRef.current = observer;
    for (const tab of tabElementsRef.current.values()) {
      const title = tab.querySelector(".workspace-tab-title");
      if (title) observer.observe(title);
    }
    return () => {
      observer.disconnect();
      narrowObserverRef.current = null;
      for (const tab of tabElementsRef.current.values())
        tab.removeAttribute("data-tab-narrow");
    };
  }, [overflow]);
  const prevTabsRef = useRef(tabs);
  if (prevTabsRef.current !== tabs) {
    const pinned = new Map(
      prevTabsRef.current.map((tab) => [tabKey(tab), Boolean(tab.pinned)]),
    );
    const repinned = tabs.flatMap((tab) => {
      const was = pinned.get(tabKey(tab));
      return was !== undefined && was !== Boolean(tab.pinned)
        ? [tabKey(tab)]
        : [];
    });
    prevTabsRef.current = tabs;
    setRendered((previous) =>
      mergeRendered(
        previous,
        tabs,
        (id) => tabElementsRef.current.get(id)?.getBoundingClientRect().width,
      ),
    );
    // A pinned or unpinned tab arrives again at its new place.
    if (repinned.length > 0)
      setEntered((previous) =>
        repinned.some((key) => previous.has(key))
          ? new Set([...previous].filter((key) => !repinned.includes(key)))
          : previous,
      );
  }
  const [dragKey, setDragKey] = useState<string | null>(null);
  // Where a dragged tab would land: before a tab, or inside a chat's.
  const [dropAt, setDropAt] = useState<{
    key: string;
    inside: boolean;
  } | null>(null);
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
      setHoverCard({
        key,
        exiting: false,
        x: rect.left,
        y: rect.bottom + 8,
      });
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

  const removeExited = (id: string) =>
    setRendered((previous) =>
      previous.filter((entry) => !(entry.exiting && entry.id === id)),
    );
  // Hidden or occluded Chromium windows can pause CSS animations and omit
  // animationend. Keep the event as the precise visible-window path, with a
  // clock fallback beyond tab-out's 180ms duration so ghost tabs cannot stay
  // mounted forever after their underlying surface has closed.
  const exitingKeys = JSON.stringify(
    rendered.filter((entry) => entry.exiting).map((entry) => entry.id),
  );
  useEffect(() => {
    const keys: string[] = JSON.parse(exitingKeys);
    if (keys.length === 0) return;
    const exiting = new Set(keys);
    // A tab that comes back plays its entrance again.
    setEntered((previous) =>
      keys.some((key) => previous.has(key))
        ? new Set([...previous].filter((key) => !exiting.has(key)))
        : previous,
    );
    const timer = window.setTimeout(
      () =>
        setRendered((previous) =>
          previous.filter((entry) => !(entry.exiting && exiting.has(entry.id))),
        ),
      TAB_EXIT_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exitingKeys]);
  const endDrag = () => {
    setDragKey(null);
    setDropAt(null);
    onDragStateChange?.(null);
  };
  // A tab closed mid-drag never hears its dragend: the close buttons would
  // stay hidden and the strip's ends would stop moving the window.
  useEndOfDrag(Boolean(dragKey), endDrag);

  const parentOf = new Map(
    groups.flatMap((group) =>
      group.memberKeys.map((key): [string, string] => [key, group.parentKey]),
    ),
  );
  /** A chat's tab takes a tab dropped on all but its leading edge. */
  const dropsInside = (dragged: string, tab: WorkspaceTab, x: number) =>
    tab.kind === "chat" &&
    !dragged.startsWith("chat:") &&
    Boolean(onAttach && attachable?.(dragged, tabKey(tab))) &&
    x > 0.3;
  /**
   * A dragged tab lands before another (null: last) among the tabs of the
   * group it lands in, joining or leaving a chat on the way.
   */
  const land = (dragged: string, beforeKey: string | null) => {
    const into = beforeKey ? (parentOf.get(beforeKey) ?? null) : null;
    if (
      onAttach &&
      !dragged.startsWith("chat:") &&
      (parentOf.get(dragged) ?? null) !== into &&
      attachable?.(dragged, into)
    )
      onAttach(dragged, into, beforeKey);
    else onReorder?.(dragged, beforeKey);
  };
  const actions = useLatestHandlers<StripActions>({
    element(id, element) {
      const observer = narrowObserverRef.current;
      if (element) {
        tabElementsRef.current.set(id, element);
        const title = observer && element.querySelector(".workspace-tab-title");
        if (title) observer.observe(title);
      } else {
        const title =
          observer &&
          tabElementsRef.current.get(id)?.querySelector(".workspace-tab-title");
        if (title) observer.unobserve(title);
        tabElementsRef.current.delete(id);
      }
    },
    updateTitle(id) {
      if (!narrowObserverRef.current) return;
      const title = tabElementsRef.current
        .get(id)
        ?.querySelector(".workspace-tab-title");
      if (title) markNarrowTitle(title);
    },
    open(key, mode) {
      disarmHoverCard();
      onSelect(key, mode);
    },
    close: onClose,
    toggleGroup(chatLocalId) {
      onToggleGroup?.(chatLocalId);
    },
    hover(key, element, exiting) {
      if (!exiting && !dragKey) armHoverCard(key, element);
    },
    unhover: disarmHoverCard,
    dragStart(event, tab) {
      const key = tabKey(tab);
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
          bookmarkUrl: tab.bookmarkUrl,
        } satisfies TabDragPayload),
      );
      event.dataTransfer.effectAllowed = "copyMove";
      disarmHoverCard();
      setDragKey(key);
      onDragStateChange?.(key);
    },
    dragEnd: endDrag,
    dragOver(event, tab) {
      const key = tabKey(tab);
      if (!dragKey || dragKey === key) return;
      event.preventDefault();
      event.stopPropagation();
      const inside = dropsInside(
        dragKey,
        tab,
        dropRatio(event.currentTarget, event.clientX),
      );
      setDropAt((current) =>
        current?.key === key && current.inside === inside
          ? current
          : { key, inside },
      );
    },
    dragLeave(key) {
      setDropAt((current) => (current?.key === key ? null : current));
    },
    drop(event, tab) {
      const key = tabKey(tab);
      if (!dragKey || dragKey === key) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        dropsInside(dragKey, tab, dropRatio(event.currentTarget, event.clientX))
      )
        onAttach?.(dragKey, key, null);
      else land(dragKey, key);
      endDrag();
    },
    animationEnd(event, id, key) {
      if (event.target !== event.currentTarget) return;
      if (event.animationName === "tab-out") removeExited(id);
      if (
        event.animationName === "tab-in" ||
        event.animationName === "tab-pin-in"
      )
        setEntered((previous) =>
          previous.has(key) ? previous : new Set(previous).add(key),
        );
    },
    file: (key) => tabFile?.(key),
    actions(key, group) {
      const ownActions = tabActions?.(key);
      return group && onToggleGroup
        ? {
            leading: [
              {
                label: group.collapsed ? "Expand group" : "Collapse group",
                action: "toggle-group",
              },
            ],
            entries: ownActions?.entries ?? [],
            onAction: (action: string) =>
              action === "toggle-group"
                ? onToggleGroup(group.chatLocalId)
                : ownActions?.onAction(action),
          }
        : ownActions;
    },
  });

  if (rendered.length === 0 && !onNew) return null;
  // Groups holding the tab in front or its split companion.
  const activeGroups = new Set(
    rendered.flatMap(({ tab, exiting }) =>
      !exiting &&
      tab.groupId &&
      (tabKey(tab) === activeKey || tabKey(tab) === secondaryKey)
        ? [tab.groupId]
        : [],
    ),
  );
  // The strip's spare room drags the window, as Chrome's does: the strip
  // takes presses for its tabs and their drops, so its empty ends hand
  // them back to the chrome. Centred tabs sit between two such ends, which
  // share the room equally; with no room left they have no width. While a
  // tab is dragged they are part of the drop target (the end of the strip),
  // never a window handle.
  const windowHandle = (end: "start" | "end") => (
    <div
      aria-hidden="true"
      data-tab-strip-room={end}
      className={`min-w-0 flex-1 self-stretch ${end === "start" ? "-me-1" : "-ms-1"} ${dragKey ? "" : "app-drag"}`}
    />
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target for tab reordering; tabs themselves are buttons
    <div
      className="app-no-drag flex min-w-0 flex-1 items-center gap-1 self-stretch overflow-x-auto overflow-y-hidden"
      data-tab-orientation="horizontal"
      data-tab-alignment={alignment}
      data-tab-overflow={overflow}
      // A dragged tab hides every close button until it lands.
      data-tab-dragging={dragKey ? "" : undefined}
      onDragOver={(event) => {
        if (dragKey) {
          event.preventDefault();
          setDropAt(null);
        }
      }}
      onDrop={(event) => {
        if (!dragKey) return;
        event.preventDefault();
        land(dragKey, null);
        endDrag();
      }}
    >
      {alignment === "center" && windowHandle("start")}
      {rendered.map(({ id, tab, exiting, width }, index) => {
        const key = tabKey(tab);
        const parentGroup = groupByParent.get(key);
        const group = tab.groupId
          ? groupByParent.get(`chat:${tab.groupId}`)
          : undefined;
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
        // A group wears one eyebrow across all its tabs: each tab draws its
        // stretch of the line, bridging the gap to the next member (and the
        // fold chevron after the last), so the run reads as one.
        const sameGroup = (neighbor?: RenderedTab) =>
          Boolean(
            neighbor &&
              !neighbor.exiting &&
              neighbor.tab.groupId === tab.groupId,
          );
        const foldable = Boolean(onToggleGroup);
        return (
          <TabRow
            key={id}
            id={id}
            tab={tab}
            exiting={exiting}
            width={width}
            actions={actions}
            active={!exiting && key === activeKey}
            // A group wears the accent while it holds the tab in front (or
            // its split companion); left behind, its eyebrow and chevrons
            // go quiet, so it never reads as the one in focus.
            groupActive={Boolean(tab.groupId && activeGroups.has(tab.groupId))}
            secondary={!exiting && key === secondaryKey}
            highlighted={!exiting && key === highlightKey}
            mergeRight={inPair && neighborInPair(rendered[index + 1])}
            mergeLeft={inPair && neighborInPair(rendered[index - 1])}
            eyebrow={
              !exiting && tab.groupId
                ? sameGroup(rendered[index - 1])
                  ? "rest"
                  : "start"
                : undefined
            }
            eyebrowEnd={
              closesGroup && foldable
                ? "chevron"
                : sameGroup(rendered[index + 1])
                  ? "bridge"
                  : "tab"
            }
            groupCollapsed={group && foldable ? group.collapsed : undefined}
            folded={
              parentGroup?.collapsed && foldable
                ? parentGroup.memberKeys.length
                : undefined
            }
            closesGroup={Boolean(closesGroup && foldable)}
            reorderable={Boolean(onReorder)}
            dragged={dragKey === key}
            drop={
              dropAt?.key === key
                ? dropAt.inside
                  ? "inside"
                  : "before"
                : undefined
            }
            entered={entered.has(key)}
          />
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
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
              aria-label="New tab"
            >
              <Plus className="size-4" />
            </button>
          </ShortcutHint>
        </div>
      )}
      {windowHandle("end")}
    </div>
  );
}

/**
 * One tab of the strip. It renders when its own entry or its place among
 * its neighbours changes, never because another tab came to the front.
 */
const TabRow = memo(function TabRow({
  id,
  tab,
  exiting,
  width,
  actions,
  active,
  groupActive,
  secondary,
  highlighted,
  mergeRight,
  mergeLeft,
  eyebrow,
  eyebrowEnd,
  groupCollapsed,
  folded,
  closesGroup,
  reorderable,
  dragged,
  drop,
  entered,
}: {
  /** React key: the tab's own, or its departing copy's after a pin change. */
  id: string;
  tab: WorkspaceTab;
  exiting: boolean;
  /** Width a departing tab collapses from (px). */
  width: number | undefined;
  actions: StripActions;
  active: boolean;
  groupActive: boolean;
  secondary: boolean;
  highlighted: boolean;
  mergeRight: boolean;
  mergeLeft: boolean;
  /** Its stretch of its group's eyebrow: the first, or one after it. */
  eyebrow: "start" | "rest" | undefined;
  eyebrowEnd: EyebrowEnd;
  /** Its group, when the strip folds groups: folded or not. */
  groupCollapsed: boolean | undefined;
  /** A folded group's chat: how many tabs it holds. */
  folded: number | undefined;
  /** The last tab of an open group: the fold chevron follows it. */
  closesGroup: boolean;
  reorderable: boolean;
  dragged: boolean;
  drop: "inside" | "before" | undefined;
  entered: boolean;
}) {
  const key = tabKey(tab);
  // A pinned or unpinned tab's departing copy: the tab lives on.
  const ghost = id !== key;
  const Icon = TAB_ICONS[tab.kind];
  const groupId = tab.groupId;
  const title = tab.label ?? tab.name;
  const setElement = useCallback(
    (element: HTMLElement | null) => {
      actions.element(id, element);
      if (tab.pinned) element?.removeAttribute("data-tab-narrow");
      // tab-out collapses from here (styles.css).
      if (element && exiting && width !== undefined)
        element.style.setProperty("--tab-width", `${width}px`);
    },
    [actions, id, exiting, width, tab.pinned],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new title can overflow a box whose width stayed the same.
  useEffect(() => {
    actions.updateTitle(id);
  }, [actions, id, title]);
  return (
    <>
      <div
        ref={setElement}
        data-tab-flexible={(!tab.pinned && !exiting) || undefined}
        data-tab-folded={folded !== undefined || undefined}
        data-palette-target={highlighted || undefined}
        data-point-key={ghost ? undefined : key}
        // Anywhere on the tab (its close button over the label's end,
        // its padding) opens the menu its label opens.
        onContextMenu={(event) => {
          const tabLabel = event.currentTarget.querySelector(
            ".workspace-tab-label",
          );
          if (
            exiting ||
            event.defaultPrevented ||
            !tabLabel ||
            (event.target instanceof Node && tabLabel.contains(event.target))
          )
            return;
          event.preventDefault();
          tabLabel.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: event.clientX,
              clientY: event.clientY,
            }),
          );
        }}
        data-page-dialog={
          (tab.kind === "browser" && tab.pageDialog) || undefined
        }
        draggable={reorderable && !exiting}
        onDragStart={(event) => actions.dragStart(event, tab)}
        onDragEnd={actions.dragEnd}
        onDragOver={(event) => actions.dragOver(event, tab)}
        onDragLeave={() => actions.dragLeave(key)}
        onDrop={(event) => actions.drop(event, tab)}
        onAnimationEnd={(event) => actions.animationEnd(event, id, key)}
        data-tab-active={active || undefined}
        data-tab-drop={drop === "inside" ? "inside" : undefined}
        className={`workspace-tab group relative flex h-8 shrink-0 items-center border text-xs transition-[margin,border-radius,color,background-color,border-color] duration-150 rounded-lg ${
          mergeRight ? "rounded-r-none border-r-0 " : ""
        }${mergeLeft ? "-ml-1 rounded-l-none border-l-0 " : ""}${
          dragged ? "opacity-50 " : ""
        }${drop === "before" ? "border-l-2 border-l-accent " : ""}${
          exiting
            ? "animate-tab-out pointer-events-none"
            : entered
              ? ""
              : tab.pinned
                ? "animate-tab-pin-in"
                : "animate-tab-in"
        } ${
          // The tab in front wears the theme's accent, as an open
          // chat's bubble does: a neutral border on the strip's near
          // black was hard to find. The palette's target keeps the
          // full accent, so the two still read apart.
          highlighted
            ? active
              ? "border-accent bg-bg text-fg"
              : "border-accent text-fg"
            : active
              ? "border-accent/60 bg-bg text-fg"
              : secondary
                ? "border-border bg-bg text-fg-muted"
                : "border-transparent text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
        }`}
        aria-hidden={exiting || undefined}
      >
        {eyebrow && (
          <span
            aria-hidden="true"
            data-tab-group-eyebrow={eyebrow}
            // Three pixels tall, so its rounded ends read as a pill
            // rather than a cut line; a pixel above the tab's edge.
            className={`pointer-events-none absolute -top-[5px] h-[3px] transition-colors duration-150 ${groupActive ? "bg-accent/50" : "bg-border-strong"} ${
              eyebrow === "start"
                ? "left-1.5 rounded-l-full"
                : mergeLeft
                  ? "left-0"
                  : "-left-px"
            } ${
              // Past this tab's border: gap-1 to the next member (none
              // across a merged split pair), or gap-1 and the size-6
              // fold chevron after the last.
              eyebrowEnd === "bridge"
                ? mergeRight
                  ? "right-0"
                  : "-right-[5px]"
                : eyebrowEnd === "chevron"
                  ? "-right-[29px] rounded-r-full"
                  : "right-1.5 rounded-r-full"
            }`}
          />
        )}
        {/* The label and the close button riding over its end. The
          label is the tab's press target, so it fills the tab inside
          its border: the tab's padding is the label's own, and a press
          anywhere on the tab opens it. */}
        <span className="workspace-tab-core relative flex min-w-0 items-center self-stretch">
          <OpenResourceButton
            type="button"
            url={tab.kind === "browser" ? tab.bookmarkUrl : undefined}
            file={() => actions.file(key)}
            actions={() =>
              actions.actions(
                key,
                groupId !== undefined && groupCollapsed !== undefined
                  ? { chatLocalId: groupId, collapsed: groupCollapsed }
                  : undefined,
              )
            }
            onOpen={(mode) => actions.open(key, mode)}
            onMouseEnter={(event) =>
              actions.hover(key, event.currentTarget, exiting)
            }
            onMouseLeave={actions.unhover}
            // A pinned tab is its icon: the hover card names it.
            className={`workspace-tab-label flex min-w-0 cursor-pointer items-center gap-1.5 self-stretch ${tab.pinned ? "px-2" : "px-2.5"}`}
            aria-current={active || undefined}
            aria-label={title}
            data-tab-pinned={tab.pinned || undefined}
          >
            {/* Same signal vocabulary as the chat bubbles: a spinner
            on the icon's lower corner while working, or what it waits
            on (the icon still names the tab); unread/draft/question
            land as badges on its upper corner. */}
            <span className="workspace-tab-icon relative grid size-3.5 shrink-0 place-items-center">
              <SignalGlyph activity={tab.activity} className="size-3.5">
                {tab.kind === "browser" ? (
                  <PageIcon
                    icon={tab.faviconUrl ?? null}
                    className={`size-3.5 ${sleepingGlyph(tab)}`}
                    fallback={Icon}
                  />
                ) : tab.kind === "app" ? (
                  <AppGlyph icon={tab.appIcon} className="size-3.5" />
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
              <SleepRing tab={tab} />
              <ShareRing tab={tab} />
              {/* An incognito page keeps its site's icon; a ghost on
                its lower corner says where it lives. */}
              {tab.kind === "browser" && tab.incognito && !tab.activity && (
                <span
                  className="absolute -bottom-1 -right-1 grid size-2.5 place-items-center rounded-full bg-bg-raised"
                  data-tab-incognito=""
                >
                  <Ghost className="size-1.5 text-fg-muted" />
                </span>
              )}
              {/* A custom conversation icon still reads as a chat: a
                tiny chat marker rides the glyph's lower corner, which
                what the chat is doing takes while it says anything. */}
              {tab.kind === "chat" &&
                hasCustomChatIcon(tab.chatIcon) &&
                !tab.activity && (
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
            {!tab.pinned && (
              <AnimatedTitle
                text={title}
                className="workspace-tab-title min-w-3 max-w-40"
              />
            )}
          </OpenResourceButton>
          {/* ⌘W closes the ACTIVE tab, so only its X advertises it. A
            pinned tab closes from its menu only. */}
          {!tab.pinned && (
            <CloseButton
              hint={active}
              label={`Close ${title}`}
              onClick={() => actions.close(key)}
            />
          )}
        </span>
        {/* Collapsed group parent: expand its folded surfaces. It
          sits over the label's last 4px, where the tab's padding was,
          and above the label, so all of it takes a press. */}
        {folded !== undefined && (
          <ShortcutHint label="Expand grouped tabs">
            <button
              type="button"
              onClick={() => actions.toggleGroup(key.slice("chat:".length))}
              className={`flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 text-[10px] transition-colors duration-150 hover:bg-bg-overlay hover:text-accent relative -ms-1 me-1 ${groupActive ? "text-accent/80" : "text-fg-faint"}`}
              aria-label={`Expand ${folded} grouped tabs`}
            >
              <ChevronsRight className="size-3" />
              {folded}
            </button>
          </ShortcutHint>
        )}
      </div>
      {/* Last member of an expanded group: fold the group away. */}
      {closesGroup && groupId !== undefined && (
        <span className="self-center">
          <ShortcutHint label="Collapse grouped tabs">
            <button
              type="button"
              onClick={() => actions.toggleGroup(groupId)}
              className={`grid size-6 shrink-0 cursor-pointer place-items-center rounded transition-colors duration-150 hover:bg-bg-overlay hover:text-accent ${groupActive ? "text-accent/70" : "text-fg-faint"}`}
              aria-label="Collapse grouped tabs"
            >
              <ChevronsLeft className="size-3.5" />
            </button>
          </ShortcutHint>
        </span>
      )}
    </>
  );
});
