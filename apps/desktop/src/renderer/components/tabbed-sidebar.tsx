import { focusTreeRow, onTreeLeave } from "@catamorphic/app/ui";
import { Circle, Plus } from "lucide-react";
import {
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  SidebarSectionConfig,
  SidebarSide,
  SidebarSurface,
  SidebarTabConfig,
} from "../../shared/sidebar.js";
import { matchesSidebarSurface, sessionSection } from "../../shared/sidebar.js";
import {
  appIsMovingFocus,
  moveFocusAsApp,
  personInputCount,
  personMovedOn,
} from "../lib/app-focus.js";
import { keyLedLast, keyMovedFocus } from "../lib/focus-modality.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import { motionMs } from "../lib/motion.js";
import { leaveSidebar, type SidebarLeave } from "../lib/sidebar-leave.js";
import { type SidebarMotion, useSidebarMotion } from "../lib/sidebar-motion.js";
import { useDraggingTab } from "../lib/use-dragging-tab.js";
import { fadeEdges } from "./catamorphic/edge-fade.js";
import { Collapsible } from "./collapsible.js";
import { OverlayScrollbar } from "./overlay-scrollbar.js";
import { ShortcutHint } from "./shortcut-hint.js";
import type { SidebarContentState } from "./sidebar-contribution.js";

/** How long an opening sidebar waits for the row of what is in front. */
const FOCUS_WAIT_MS = 1500;
/** How long an arrow into the next list waits for its row to be drawn. */
const ROW_DRAW_WAIT_MS = 300;

/**
 * The lists in a panel the keyboard can reach, in order: closed sections
 * are inert and hidden ones hidden, so nothing here forces a layout while
 * the panel slides.
 */
const panelLists = (panel: Element | null | undefined): Element[] =>
  panel
    ? [...panel.querySelectorAll("[data-tree-viewport]")].filter(
        (list) => !list.closest("[inert], [hidden]"),
      )
    : [];

/**
 * Asks lists in turn for a row (`focusTreeRow`) until focus is on one of
 * theirs, again each frame for up to `ms`: a list may still be loading, and
 * draws a row it revealed from out of view by the next frame. Stops once
 * the person has acted and put focus somewhere. `asApp` counts the move as
 * the app's own, so it opens no row's preview. Returns its cancel.
 */
function focusRowSoon({
  lists,
  which,
  visible,
  ms,
  asApp = false,
  landed,
}: {
  lists: () => Element[];
  which: "first" | "last" | "selected";
  visible: boolean;
  ms: number;
  asApp?: boolean;
  landed?: () => void;
}): () => void {
  const started = performance.now();
  const inputs = personInputCount();
  let frame = 0;
  const there = () => {
    const active = document.activeElement;
    return (
      !!active?.closest("[data-tree-id]") &&
      lists().some((list) => list.contains(active))
    );
  };
  const ask = () => {
    lists().some((list) => focusTreeRow({ scroller: list, which, visible }));
  };
  const look = () => {
    if (!there()) {
      if (personMovedOn(inputs)) return;
      if (asApp) moveFocusAsApp(ask);
      else ask();
    }
    if (there()) landed?.();
    else if (performance.now() - started < ms)
      frame = requestAnimationFrame(look);
  };
  look();
  return () => cancelAnimationFrame(frame);
}

/**
 * An arrow past a list's end (onTreeLeave) goes on to the next or previous
 * open list in the panel, so the sidebar reads as one list. True when a
 * list took it.
 */
function continueAcrossLists({
  panel,
  direction,
  scroller,
}: {
  panel: Element;
  direction: "up" | "down";
  scroller: Element;
}): boolean {
  const lists = panelLists(panel);
  const from = lists.indexOf(scroller);
  if (from < 0) return false;
  const step = direction === "down" ? 1 : -1;
  const which = direction === "down" ? "first" : "last";
  for (
    let index = from + step;
    index >= 0 && index < lists.length;
    index += step
  ) {
    const list = lists[index];
    if (list && focusTreeRow({ scroller: list, which })) {
      // A row revealed from out of view is drawn by the next frame.
      focusRowSoon({
        lists: () => [list],
        which,
        visible: true,
        ms: ROW_DRAW_WAIT_MS,
      });
      return true;
    }
  }
  return false;
}

/**
 * A sidebar panel: it fades where its sections continue past its edges, and
 * the arrows run across its lists.
 */
const panelRef = (panel: HTMLDivElement | null) => {
  if (!panel) return;
  const unfade = fadeEdges(panel);
  const unleave = onTreeLeave({
    container: panel,
    onLeave: (leave) => continueAcrossLists({ panel, ...leave }),
  });
  return () => {
    unfade();
    unleave();
  };
};

/**
 * Brings a focused row into its sidebar panel's view, clear of the panel's
 * faded edges (its scroll padding).
 */
function revealInPanel(row: Element): void {
  const panel = row.closest(".sidebar-tab-panel");
  if (!panel) return;
  const padding = getComputedStyle(panel);
  const view = panel.getBoundingClientRect();
  const top = view.top + (Number.parseFloat(padding.scrollPaddingTop) || 0);
  const bottom =
    view.bottom - (Number.parseFloat(padding.scrollPaddingBottom) || 0);
  const box = row.getBoundingClientRect();
  if (box.top < top) panel.scrollTop -= top - box.top;
  else if (box.bottom > bottom) panel.scrollTop += box.bottom - bottom;
}

/**
 * A row the keyboard focuses comes into the panel's view. Focus a press
 * gives, or the app hands back (a menu closing onto its row), leaves the
 * panel where it is.
 */
const keepRowInView = (event: ReactFocusEvent<HTMLDivElement>) => {
  const row =
    event.target instanceof Element
      ? event.target.closest("[data-tree-id]")
      : null;
  if (
    row &&
    document.documentElement.dataset.focusModality === "keyboard" &&
    !appIsMovingFocus()
  )
    revealInPanel(row);
};

interface LayoutState {
  width: number;
  selected: string;
}
function readLayout(key: string, side: SidebarSide): LayoutState {
  const fallback = { width: side === "left" ? 260 : 320, selected: "" };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return {
      width:
        typeof value?.width === "number"
          ? Math.max(220, Math.min(520, value.width))
          : fallback.width,
      selected: typeof value?.selected === "string" ? value.selected : "",
    };
  } catch {
    return fallback;
  }
}

function TabIcon({ name }: { name?: string }) {
  const Icon = lucideIcon(name) ?? Circle;
  return <Icon className="size-4" aria-hidden="true" />;
}

/** A `when` that depends on what is in front, not on who is looking. */
function followsSurface(when: SidebarSectionConfig["when"]): boolean {
  return Boolean(
    when?.surface ||
      when?.session !== undefined ||
      when?.pathPrefix ||
      when?.selection !== undefined,
  );
}

/**
 * A tab that comes and goes with what is in front (This session beside a
 * chat, ADR 0226). It is never the default choice, so its arriving never
 * changes the tab the person sees.
 */
function contextualTab(tab: SidebarTabConfig): boolean {
  return (
    followsSurface(tab.when) ||
    tab.sections.every(
      (section) => followsSurface(section.when) || sessionSection(section),
    )
  );
}

/** How long a tab or the strip takes to arrive or leave (styles.css). */
const STRIP_MOTION_MS = 200;

/** Both sides use the same chrome, keyboard model and persistent panel lifecycle. */
export function TabbedSidebar({
  side,
  sidebarRef,
  overlay = false,
  revealed = false,
  tabs: configuredTabs,
  surface = { kind: "none" },
  open,
  scope,
  header,
  headerActions,
  footer,
  error,
  focusRequest = 0,
  onCustomize,
  onMotionChange,
  renderSection,
}: {
  side: SidebarSide;
  sidebarRef?: Ref<HTMLElement>;
  /** Open over the content instead of beside it. */
  overlay?: boolean;
  revealed?: boolean;
  tabs: SidebarTabConfig[];
  surface?: SidebarSurface;
  open: boolean;
  scope: string;
  header?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  error?: string;
  /**
   * Raised each time the person opens the sidebar: keyboard focus goes to
   * the row standing for what is in front, when a list shows one.
   */
  focusRequest?: number;
  onCustomize: () => void;
  /** Where the sidebar is in its slide, as laid out. */
  onMotionChange?: (motion: SidebarMotion) => void;
  renderSection: (
    section: SidebarSectionConfig,
    visible: boolean,
    report: (state: SidebarContentState, droppable: boolean) => void,
    relevant: boolean,
    /** Hidden only for being empty; see SidebarSlot. */
    observeEmpty: boolean,
  ) => ReactNode;
}) {
  const storageKey = `catamorphic:sidebar:${scope}:${side}`;
  const [layout, setLayout] = useState(() => readLayout(storageKey, side));
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [resizing, setResizing] = useState(false);
  const [tabMotion, setTabMotion] = useState(false);
  const root = useRef<HTMLElement>(null);
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const panelArea = useRef<HTMLDivElement>(null);
  const motion = useSidebarMotion({ open, dock: !overlay, panel });
  // Sections are live while the panel is on screen, sliding included. They
  // pause once it has gone, never on the click that starts it moving, so
  // what slides away is what was shown.
  const onScreen = motion.phase !== "closed";
  // Before paint, so chrome that follows the sidebar (its toggle, the room
  // made for it) changes in the same frame as the sidebar.
  useLayoutEffect(() => {
    onMotionChange?.({
      phase: motion.phase,
      docked: motion.docked,
      push: motion.push,
    });
  }, [motion.phase, motion.docked, motion.push, onMotionChange]);
  // The content beside it reads the panel's width, so what starts at the
  // sidebar's edge can slide with the panel (styles.css).
  useLayoutEffect(() => {
    const row = root.current?.parentElement;
    const name = `--${side}-sidebar-width`;
    row?.style.setProperty(name, `${layout.width}px`);
    return () => {
      row?.style.removeProperty(name);
    };
  }, [side, layout.width]);
  // Closing from open, the items leave before the panel does (and the
  // panel waits for them: data-items-lead). Opening again mid-close plays
  // them back from where they are; once closed they are put back at once.
  const [shownPhase, setShownPhase] = useState(motion.phase);
  const [itemsLead, setItemsLead] = useState(false);
  if (motion.phase !== shownPhase) {
    setShownPhase(motion.phase);
    // Not an overlay's reveal: a peek is dismissed often, and at once.
    setItemsLead(
      motion.phase === "closing" && shownPhase === "open" && !overlay,
    );
  }
  const leave = useRef<SidebarLeave | undefined>(undefined);
  useLayoutEffect(() => {
    const current = leave.current;
    if (motion.phase === "closed") {
      current?.cancel();
      leave.current = undefined;
    } else if (motion.phase !== "closing") {
      current?.leaving(false);
    } else if (current) {
      current.leaving(true);
    } else if (itemsLead && panel.current) {
      leave.current = leaveSidebar({
        panel: panel.current,
        side,
        onReturned: () => {
          leave.current = undefined;
        },
      });
    }
  }, [motion.phase, itemsLead, side]);
  useEffect(
    () => () => {
      leave.current?.cancel();
      leave.current = undefined;
    },
    [],
  );
  const [content, setContent] = useState<
    ReadonlyMap<string, SidebarContentState>
  >(new Map());
  const [droppable, setDroppable] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback(
    (id: string, state: SidebarContentState, takesDrops: boolean) => {
      setContent((current) =>
        current.get(id) === state ? current : new Map(current).set(id, state),
      );
      setDroppable((current) => {
        if (current.has(id) === takesDrops) return current;
        const next = new Set(current);
        if (takesDrops) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [],
  );
  // A section hidden for being empty that takes drops shows while something
  // it could take is dragged (pinned pages: "Drop a tab here"), and a moment
  // after the drop so what arrives lands in view.
  const dragging = useDraggingTab();
  // A session-scoped section needs a chat's session: the chat in front, or
  // the chat that opened the page, file or terminal in front (ADR 0226).
  const sectionRelevant = (section: SidebarSectionConfig) =>
    matchesSidebarSurface(section.when, surface) &&
    (!sessionSection(section) || Boolean(surface.sessionId));
  const sectionAvailable = (section: SidebarSectionConfig) => {
    if (!sectionRelevant(section)) return false;
    const state = content.get(section.id);
    if (state === "unavailable") return false;
    if (!section.hideEmpty || state !== "empty") return true;
    return dragging && droppable.has(section.id);
  };
  // A section hidden only because it is empty must keep observing, or it
  // can never learn that it has something to show again (Changes after a
  // commit, until the next edit). Live sources keep a root lease the same
  // way. A tab that vanished because every section in it is empty counts
  // as the one to observe too.
  const sectionEmptyHidden = (section: SidebarSectionConfig) =>
    sectionRelevant(section) &&
    !sectionAvailable(section) &&
    content.get(section.id) === "empty";
  const tabs = configuredTabs.filter(
    (tab) =>
      matchesSidebarSurface(tab.when, surface) &&
      tab.sections.some(sectionAvailable),
  );
  // The person's choice while it is on offer; otherwise the first tab that
  // stays whatever is in front, so a contextual tab arriving never takes
  // the panel from what the person was looking at.
  const selected =
    tabs.find((tab) => tab.id === layout.selected)?.id ??
    (tabs.find((tab) => !contextualTab(tab)) ?? tabs[0])?.id;
  // After the first paint, motion follows what changes (styles.css): the
  // panels cross-fade whenever the tab in front changes, a click or not.
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => setMotionReady(true), []);
  const [shownSelected, setShownSelected] = useState(selected);
  if (selected !== shownSelected) {
    setShownSelected(selected);
    if (motionReady && shownSelected !== undefined && selected !== undefined)
      setTabMotion(true);
  }
  // Tabs join and leave the strip (ADR 0226): one grows into its place
  // while its neighbours slide, and one leaving shrinks away the way it
  // came. Each keeps one element throughout, so a quick change back
  // reverses from where it is (CSS transitions, styles.css). The strip
  // itself opens and folds as the tab count crosses one. Only changes to a
  // tab list already shown move: the first list (the workspace file
  // arriving), the sidebar's own opening (its header controls) and a
  // sidebar off screen change at once; reduced motion settles at once.
  const showStrip = tabs.length > 1 || Boolean(headerActions);
  const tabIds = tabs.map((tab) => tab.id);
  const [strip, setStrip] = useState<{
    ids: readonly string[];
    shown: boolean;
    arriving: ReadonlySet<string>;
    leaving: ReadonlySet<string>;
    motion: "arriving" | "folding" | null;
  }>(() => ({
    ids: tabIds,
    shown: showStrip,
    arriving: new Set(),
    leaving: new Set(),
    motion: null,
  }));
  if (
    showStrip !== strip.shown ||
    tabIds.length !== strip.ids.length ||
    tabIds.some((id, index) => strip.ids[index] !== id)
  ) {
    const animate = motionReady && onScreen && strip.ids.length > 0;
    const added = tabIds.filter((id) => !strip.ids.includes(id));
    const removed = strip.ids.filter((id) => !tabIds.includes(id));
    // The strip moves for the tabs only, never for its header controls.
    const countCrossed = tabIds.length > 1 !== strip.ids.length > 1;
    setStrip({
      ids: tabIds,
      shown: showStrip,
      arriving: animate
        ? new Set([
            ...[...strip.arriving].filter((id) => tabIds.includes(id)),
            ...added,
          ])
        : new Set(),
      leaving: animate
        ? new Set([
            ...[...strip.leaving].filter((id) => !tabIds.includes(id)),
            ...removed,
          ])
        : new Set(),
      motion: !animate
        ? null
        : showStrip === strip.shown || !countCrossed
          ? showStrip
            ? strip.motion === "folding"
              ? "arriving"
              : strip.motion
            : null
          : showStrip
            ? "arriving"
            : "folding",
    });
  }
  const stripMoving =
    strip.arriving.size > 0 || strip.leaving.size > 0 || strip.motion !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: every change to the strip restarts its settle, so what just started moving finishes
  useEffect(() => {
    if (!stripMoving) return;
    const timer = setTimeout(
      () =>
        setStrip((current) => ({
          ...current,
          arriving: new Set(),
          leaving: new Set(),
          motion: null,
        })),
      motionMs(STRIP_MOTION_MS),
    );
    return () => clearTimeout(timer);
  }, [stripMoving, strip]);
  const stripTabs = configuredTabs.filter(
    (tab) => tabIds.includes(tab.id) || strip.leaving.has(tab.id),
  );
  const stripFolding = !showStrip && strip.motion === "folding";
  const previousSelected = useRef(selected);
  const focusWithin = useRef(false);
  useLayoutEffect(() => {
    if (
      previousSelected.current !== selected &&
      focusWithin.current &&
      selected
    ) {
      (
        document.getElementById(`${id}-tab-${selected}`) ??
        document.getElementById(`${id}-panel-${selected}`)
      )?.focus();
    }
    previousSelected.current = selected;
  }, [selected, id]);
  // Focus on a tab that leaves, or in a strip that folds, would be lost
  // with it: it moves to the tab in front, or its panel.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      !active.closest(
        "[data-sidebar-tab-leaving], [data-sidebar-strip-folding]",
      )
    )
      return;
    const target =
      !stripFolding && selected
        ? document.getElementById(`${id}-tab-${selected}`)
        : null;
    (
      target ??
      (selected ? document.getElementById(`${id}-panel-${selected}`) : null)
    )?.focus();
  });
  useEffect(() => {
    // Persist the initial tab before the first click. Keep an existing choice
    // while tabs are temporarily filtered during project/permission loading.
    if (selected && !layout.selected)
      setLayout((current) => ({ ...current, selected }));
  }, [selected, layout.selected]);
  useEffect(() => {
    if (open && selected)
      setVisited((current) =>
        current.has(selected) ? current : new Set([...current, selected]),
      );
  }, [open, selected]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(layout));
  }, [storageKey, layout]);
  // Opened by the person, the sidebar takes keyboard focus to the row of
  // what is in front, so the arrows go on from there; the panel and its
  // lists may still be arriving. The app moves this focus, so it previews
  // nothing; opened by a shortcut, the ring shows where focus went, and by
  // a press it waits for the first arrow.
  const openRef = useRef(open);
  openRef.current = open;
  // A request older than this sidebar (it remounts with the project or
  // profile) was someone else's.
  const handledFocus = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocus.current) return;
    handledFocus.current = focusRequest;
    if (!openRef.current) return;
    const visible = keyLedLast();
    return focusRowSoon({
      lists: () =>
        panelLists(
          panelArea.current?.querySelector(".sidebar-tab-panel:not([hidden])"),
        ),
      which: "selected",
      visible,
      ms: FOCUS_WAIT_MS,
      asApp: true,
      landed: () => {
        const row = document.activeElement?.closest("[data-tree-id]");
        if (row) revealInPanel(row);
        if (visible) keyMovedFocus();
      },
    });
  }, [focusRequest]);
  const select = (tabId: string) => {
    setTabMotion(true);
    setLayout((current) => ({ ...current, selected: tabId }));
  };
  return (
    <aside
      ref={(element) => {
        root.current = element;
        if (typeof sidebarRef === "function") sidebarRef(element);
        else if (sidebarRef) sidebarRef.current = element;
      }}
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node)
          focusWithin.current = Boolean(
            root.current?.contains(event.relatedTarget),
          );
      }}
      data-sidebar={side}
      data-motion={motion.phase}
      data-items-lead={itemsLead || undefined}
      data-docked={motion.docked}
      data-push={motion.push || undefined}
      data-settled={motion.settled}
      data-tab-motion={tabMotion}
      data-resizing={resizing || undefined}
      data-sidebar-revealed={revealed}
      className="tabbed-sidebar"
      aria-label={`${side === "left" ? "Left" : "Right"} sidebar`}
      aria-hidden={!open}
      inert={!open}
      style={{ width: motion.docked ? layout.width : 0 }}
    >
      <div
        ref={panel}
        className={`sidebar-inner ${overlay ? "rounded-r-xl shadow-xl" : ""}`}
        style={{ width: layout.width }}
      >
        {header}
        {(showStrip || stripFolding) && (
          // One strip element while it opens, shows and folds; folding, it
          // is what it showed, no longer tabs.
          <div
            aria-hidden={stripFolding || undefined}
            inert={stripFolding}
            data-sidebar-strip-folding={stripFolding ? "" : undefined}
            className={`sidebar-strip flex h-10 shrink-0 items-center gap-2 px-2 ${
              stripFolding
                ? "sidebar-strip-folding"
                : strip.motion === "arriving"
                  ? "sidebar-strip-arriving"
                  : ""
            }`}
          >
            {headerActions}
            <div
              role="tablist"
              aria-label={`${side === "left" ? "Left" : "Right"} sidebar tabs`}
              className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto"
            >
              {stripTabs.map((tab) => {
                const leaving = strip.leaving.has(tab.id);
                const interactive = !leaving && !stripFolding;
                const index = tabs.indexOf(tab);
                return (
                  <ShortcutHint
                    key={tab.id}
                    label={tab.title}
                    className={`sidebar-tab-slot ${
                      leaving
                        ? "sidebar-tab-slot-leaving"
                        : strip.arriving.has(tab.id)
                          ? "sidebar-tab-slot-arriving"
                          : ""
                    }`}
                  >
                    {interactive ? (
                      <button
                        type="button"
                        role="tab"
                        id={`${id}-tab-${tab.id}`}
                        aria-controls={`${id}-panel-${tab.id}`}
                        aria-label={tab.title}
                        aria-selected={selected === tab.id}
                        tabIndex={selected === tab.id ? 0 : -1}
                        className="sidebar-tab"
                        onClick={() => select(tab.id)}
                        onKeyDown={(event) => {
                          const next =
                            event.key === "ArrowRight"
                              ? (index + 1) % tabs.length
                              : event.key === "ArrowLeft"
                                ? (index + tabs.length - 1) % tabs.length
                                : event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? tabs.length - 1
                                    : null;
                          if (next === null) return;
                          event.preventDefault();
                          const target = tabs[next];
                          if (target) {
                            select(target.id);
                            document
                              .getElementById(`${id}-tab-${target.id}`)
                              ?.focus();
                          }
                        }}
                      >
                        <TabIcon name={tab.icon} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        id={`${id}-tab-${tab.id}`}
                        tabIndex={-1}
                        aria-hidden="true"
                        data-sidebar-tab-leaving={leaving ? tab.id : undefined}
                        data-selected={selected === tab.id || undefined}
                        className="sidebar-tab"
                      >
                        <TabIcon name={tab.icon} />
                      </button>
                    )}
                  </ShortcutHint>
                );
              })}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="px-3 pb-2 text-xs text-warning">
            workspace.js could not reload. {error}
          </p>
        )}
        <div
          ref={panelArea}
          className="relative min-h-0 flex-1 overflow-hidden"
        >
          {configuredTabs.map((tab) => (
            <div
              key={tab.id}
              role="tabpanel"
              id={`${id}-panel-${tab.id}`}
              aria-labelledby={
                tabs.length > 1 ? `${id}-tab-${tab.id}` : undefined
              }
              aria-label={tabs.length > 1 ? undefined : tab.title}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tab panels must be keyboard reachable when content has no focusable controls
              tabIndex={0}
              hidden={selected !== tab.id}
              inert={selected !== tab.id || !open}
              ref={panelRef}
              onFocus={keepRowInView}
              className="sidebar-tab-panel cat-edge-fade"
            >
              {tab.sections.map((section) => (
                <SidebarSlot
                  key={section.id}
                  section={section}
                  mounted={
                    visited.has(tab.id) ||
                    (open && selected === tab.id) ||
                    section.app === undefined
                  }
                  relevant={
                    matchesSidebarSurface(tab.when, surface) &&
                    sectionRelevant(section)
                  }
                  available={sectionAvailable(section)}
                  still={selected !== tab.id}
                  visible={onScreen && selected === tab.id}
                  observeEmpty={
                    onScreen &&
                    (selected === tab.id || !tabs.includes(tab)) &&
                    sectionEmptyHidden(section)
                  }
                  report={report}
                  renderSection={renderSection}
                />
              ))}
            </div>
          ))}
          {/* Only a section that asks for one has a thumb; every other
              list fades the edge it continues past (cat-edge-fade). */}
          {configuredTabs.some((tab) =>
            tab.sections.some((section) => section.scrollbar),
          ) && (
            <OverlayScrollbar edge={side} getArea={() => panelArea.current} />
          )}
          {tabs.length === 0 && (
            <div className="grid h-full place-items-center p-4">
              <button
                type="button"
                onClick={onCustomize}
                aria-label="Customize sidebar"
                className="mx-auto flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-4 text-[13px] text-fg-muted transition-colors duration-150 hover:border-border-strong hover:bg-bg-overlay hover:text-fg"
              >
                <Plus className="size-4" aria-hidden="true" />
                Customize sidebar
              </button>
            </div>
          )}
        </div>
        {footer}
        {/* biome-ignore lint/a11y/useSemanticElements: interactive resize separator, not a thematic break */}
        <div
          role="separator"
          aria-label={`Resize ${side} sidebar`}
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={520}
          aria-valuenow={layout.width}
          tabIndex={open ? 0 : -1}
          className="sidebar-resizer"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const delta =
              (event.key === "ArrowRight" ? 20 : -20) *
              (side === "left" ? 1 : -1);
            setLayout((current) => ({
              ...current,
              width: Math.max(220, Math.min(520, current.width + delta)),
            }));
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = root.current?.getBoundingClientRect();
            if (rect)
              setLayout((current) => ({
                ...current,
                width: Math.max(
                  220,
                  Math.min(
                    520,
                    side === "left"
                      ? event.clientX - rect.left
                      : rect.right - event.clientX,
                  ),
                ),
              }));
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            setResizing(false);
          }}
          onLostPointerCapture={() => setResizing(false)}
        />
      </div>
    </aside>
  );
}

function SidebarSlot({
  section,
  mounted,
  relevant,
  available,
  still = false,
  visible,
  observeEmpty = false,
  report,
  renderSection,
}: {
  section: SidebarSectionConfig;
  mounted: boolean;
  relevant: boolean;
  available: boolean;
  /**
   * Its panel is hidden or fading away: it keeps the shape it had, since
   * folding it too would move what is leaving, and catches up when shown.
   */
  still?: boolean;
  visible: boolean;
  /** Hidden only for being empty. */
  observeEmpty?: boolean;
  report: (id: string, state: SidebarContentState, droppable: boolean) => void;
  renderSection: (
    section: SidebarSectionConfig,
    visible: boolean,
    report: (state: SidebarContentState, droppable: boolean) => void,
    relevant: boolean,
    /** Hidden for being empty; a section whose emptiness can change
     * behind its back keeps observing. Apps stay idle. */
    observeEmpty: boolean,
  ) => ReactNode;
}) {
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (mounted && relevant) setVisited(true);
  }, [mounted, relevant]);
  const onState = useCallback(
    (state: SidebarContentState, droppable: boolean) =>
      report(section.id, state, droppable),
    [report, section.id],
  );
  // A section that empties collapses before it hides, and one that fills
  // opens from nothing: sections below slide instead of jumping.
  const [shownAvailable, setShownAvailable] = useState(available);
  const [leaving, setLeaving] = useState(false);
  if (!still && available !== shownAvailable) {
    setShownAvailable(available);
    setLeaving(!available);
  }
  const shown = still ? shownAvailable : available;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), motionMs(200));
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <div
      data-sidebar-widget={section.id}
      hidden={!shown && !leaving}
      inert={!available}
    >
      <Collapsible open={shown}>
        {(visited || (mounted && relevant)) &&
          renderSection(
            section,
            visible && relevant && available,
            onState,
            relevant,
            observeEmpty,
          )}
      </Collapsible>
    </div>
  );
}
