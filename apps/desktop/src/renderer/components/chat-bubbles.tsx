import {
  ChevronsDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type DOMAttributes,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { openModeFromEvent } from "../../shared/open-mode.js";
import type { PillEdge } from "../../shared/pill-geometry.js";
import type { ChatSessionMenuEntry } from "../lib/chat-session-actions.js";
import { desktopApi } from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import {
  EASE_STANDARD,
  motionMs,
  prefersReducedMotion,
} from "../lib/motion.js";
import type { ChatDockEntry } from "./chat-dock";
import { ChatGlyph } from "./chat-icon";
import { type ChatSignals, SignalBadge, SignalGlyph } from "./chat-signals";
import { type MenuAt, MenuPortal, menuAtPointer } from "./menu.js";
import { PillIsland } from "./pill-island.js";
import { ShortcutHint } from "./shortcut-hint";

/** Bubbles identify themselves on hover without delay (unlike buttons,
    whose labels are usually inferable — a bubble is just an icon). */
const BUBBLE_HINT_DELAY_MS = 100;
/** What a bubble that is not shown signals: nothing. */
const NO_SIGNALS: ChatSignals = {};

/**
 * The strip folding into its corner and opening again: its slide between
 * resting spots and the width its chats give up or take (duration-250 on
 * the folding parts) run together, so it lands as one motion.
 */
const FOLD_MS = 250;

type Spot = "left" | "center" | "right";

/**
 * Whether the strip shows folded, derived where the dock renders so the
 * fold and what it moves (a chat tab's clearance, the detached window's
 * size) change in one render, never a second one a frame into the motion.
 *
 * A focused chat tab folds it (`autoCollapse`); opened by hand meanwhile,
 * it stays open until such a tab gains focus again. Otherwise it is the
 * person's fold (`folded`), shown open beside an open chat (a closed
 * bubble beside a visible chat reads wrong); a chat on its way out no
 * longer counts, so the strip folds while it leaves.
 */
export function useStripFold({
  autoCollapse,
  folded,
  chatOpen,
}: {
  autoCollapse: boolean;
  folded: boolean;
  chatOpen: boolean;
}): {
  collapsed: boolean;
  /** The person's own controls folded (true) or opened (false) it. */
  choose: (folded: boolean) => void;
} {
  const [peeked, setPeeked] = useState(false);
  const [wasAuto, setWasAuto] = useState(autoCollapse);
  if (wasAuto !== autoCollapse) {
    setWasAuto(autoCollapse);
    if (autoCollapse) setPeeked(false);
  }
  return {
    collapsed: autoCollapse ? !peeked : folded && !chatOpen,
    choose: (next) => setPeeked(!next),
  };
}

export interface ChatBubblesProps {
  dragLeft?: number | null;
  /** Where the expanded strip and open chats sit. */
  placement?: "left" | "center" | "right";
  /** Drag surface of the collapsed bubble: picks its corner. */
  dragHandlers?: DOMAttributes<HTMLButtonElement>;
  /** Drag surface of the expanded strip's arrows: picks the placement. */
  placementDragHandlers?: DOMAttributes<HTMLButtonElement>;
  /** The resting spot the current drag would choose; null when not dragging. */
  dragTarget?: "left" | "center" | "right" | null;
  /** Whether the dock lives in its own window; the bubble menu flips it. */
  detached?: boolean;
  /**
   * The screen edge the pill rests on (ADR 0242): the bottom in a
   * workspace window; in its own window, any edge.
   */
  edge?: PillEdge;
  /** At the top of a display with a camera cutout, the island wraps it. */
  notch?: { width: number; height: number } | null;
  /** The island opens when the pointer reaches it. */
  islandHover?: boolean;
  /** Docks the pill at an edge, from its menu (in its own window). */
  onDockAt?: (edge: PillEdge) => void;
  /** The detached window is too small for in-page menus; use native ones. */
  nativeMenus?: boolean;
  onToggleDetached?: () => void;
  newChatProjectName?: string;
  side?: "left" | "right";
  themes?: Record<string, CSSProperties>;
  /** All chats; tab-mode chats contribute indicators but no strip bubble. */
  entries: ChatDockEntry[];
  labels: Record<string, string>;
  /** Agent-chosen conversation icons ("<name>:<color>") per chat. */
  icons: Record<string, string | null>;
  /** Chats that are forks of another conversation (fork glyph default). */
  forks: Record<string, boolean>;
  /** Live signals per chat (working / draft / awaiting-input). */
  signals: Record<string, ChatSignals>;
  /** Response arrived while the chat was minimized; shown as a dot. */
  unread: Record<string, boolean>;
  /** A workflow asked the user to open this session; shown as a pulse. */
  attention: Record<string, boolean>;
  /** Session actions shared verbatim with the matching sidebar row. */
  menus: Record<string, ChatSessionMenuEntry[]>;
  activeLocalId?: string;
  /** Whether the strip shows folded into one bubble (`useStripFold`). */
  collapsed: boolean;
  /**
   * The person's own fold (the arrows) or open (the folded bubble), kept
   * across windows and launches (prefs `dockCollapsed`). Nothing else
   * calls it.
   */
  onFoldedChange: (folded: boolean) => void;
  /** Rendered beside the chat strip, inside the arrows: the downloads bubble. */
  trailing?: ReactNode;
  /**
   * The voice microphone (ADR 0216): shown collapsed or not, right inside
   * the arrows so they stay the outermost control.
   */
  voice?: ReactNode;
  /** Whether the microphone is in the dock; it grows in and out. */
  voiceShown?: boolean;
  /**
   * The person's choice to keep the microphone in the dock, offered in the
   * arrows' menu whether it shows or not.
   */
  voiceInDock?: boolean;
  onVoiceInDockChange?: (inDock: boolean) => void;
  onToggle: (localId: string) => void;
  /**
   * A bubble click with the app's open modifiers (⌘ = tab, ⌘⇧ = to the
   * side) opens the chat as a workspace tab instead of floating it.
   */
  onOpenAs?: (localId: string, mode: "tab" | "side") => void;
  onClose: (localId: string) => void;
  onMenuAction: (localId: string, action: ChatSessionMenuEntry) => void;
  onNewChat: () => void;
  /** Manual strip collapse (>>) also minimizes any open floating chat. */
  onCollapse?: () => void;
}

/**
 * Rendered bubble list. Lags behind `entries` on removal: closed bubbles
 * stay as exiting snapshots until their collapse animation ends.
 */
interface Display {
  entries: ChatDockEntry[];
  exitingIds: string[];
}

/**
 * One strip bubble. Owns the "agent is asking" arrival animation: when the
 * chat's awaiting-input signal rises, the bubble plays a one-shot scale +
 * ring nudge so the user can tell WHICH agent asked without opening
 * anything (the persistent "?" badge carries the state afterwards).
 */
function Bubble({
  entry,
  label,
  icon,
  fork,
  signals,
  exiting,
  fresh,
  expanded,
  onToggle,
  onOpenAs,
  onClose,
  menu,
  nativeMenus = false,
  onMenuAction,
  onExited,
  theme,
  hintSide = "top",
}: {
  hintSide?: "top" | "bottom" | "left" | "right";
  theme?: CSSProperties;
  entry: ChatDockEntry;
  label: string;
  icon: string | null;
  fork: boolean;
  signals: ChatSignals;
  exiting: boolean;
  fresh: boolean;
  expanded: boolean;
  onToggle: (localId: string) => void;
  onOpenAs?: (localId: string, mode: "tab" | "side") => void;
  onClose: (localId: string) => void;
  menu?: ChatSessionMenuEntry[];
  nativeMenus?: boolean;
  onMenuAction: (localId: string, action: ChatSessionMenuEntry) => void;
  onExited: (localId: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [menuAt, setMenuAt] = useState<MenuAt | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevAwaitingRef = useRef(signals.awaitingInput ?? false);
  if (prevAwaitingRef.current !== (signals.awaitingInput ?? false)) {
    prevAwaitingRef.current = signals.awaitingInput ?? false;
    if (signals.awaitingInput) setAsking(true);
  }
  return (
    <div
      ref={rootRef}
      data-chat-bubble={entry.localId}
      data-session-id={entry.sessionId}
      style={theme}
      className={`group relative ${
        exiting
          ? "animate-bubble-out pointer-events-none"
          : fresh
            ? "animate-bubble-in"
            : ""
      }`}
      onAnimationEnd={(event) => {
        if (event.animationName === "bubble-out") onExited(entry.localId);
        if (event.animationName === "bubble-ask") setAsking(false);
      }}
    >
      <ShortcutHint label={label} side={hintSide} delay={BUBBLE_HINT_DELAY_MS}>
        <button
          type="button"
          onClick={(event) => {
            const mode = openModeFromEvent(event, "floating");
            if ((mode === "tab" || mode === "side") && onOpenAs) {
              onOpenAs(entry.localId, mode);
              return;
            }
            onToggle(entry.localId);
          }}
          onContextMenu={
            menu && menu.length > 0
              ? (event) => {
                  event.preventDefault();
                  if (nativeMenus) {
                    void desktopApi.dockMenu(menu).then((action) => {
                      const picked = menu.find(
                        (entry) => entry.action === action,
                      );
                      if (picked) onMenuAction(entry.localId, picked);
                    });
                    return;
                  }
                  setMenuAt(menuAtPointer(event));
                  setMenuOpen(true);
                }
              : undefined
          }
          className={`relative grid size-9 cursor-pointer place-items-center rounded-full border transition-[background-color,border-color,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-95 ${
            asking ? "animate-bubble-ask " : ""
          }${
            expanded
              ? "border-accent/60 bg-accent/15 text-accent"
              : "border-accent/25 bg-bg-overlay text-accent/80 hover:border-accent/60 hover:text-accent"
          }`}
          aria-label={expanded ? `Minimize ${label}` : `Open ${label}`}
          aria-expanded={expanded}
        >
          <SignalGlyph
            working={signals.working}
            awaitingInput={signals.awaitingInput}
            className="size-4"
          >
            <ChatGlyph icon={icon} fork={fork} className="size-4" />
          </SignalGlyph>
          <span className="absolute -right-0.5 -top-0.5">
            <SignalBadge signals={signals} size="md" />
          </span>
        </button>
      </ShortcutHint>
      {!exiting && (
        <button
          type="button"
          onClick={() => onClose(entry.localId)}
          className="row-reveal absolute -left-1 -top-1 grid size-4 cursor-pointer place-items-center rounded-full border border-border bg-bg-overlay text-fg-faint hover:text-fg"
          aria-label={`Close ${label}`}
        >
          <X className="size-2.5" />
        </button>
      )}
      {menuAt && menu && (
        <MenuPortal
          open={menuOpen}
          at={menuAt}
          // Only a scroll that carries the bubble detaches the menu from
          // it. A streaming chat keeps its timeline following new output,
          // and those scrolls must not close a menu the person just opened.
          anchor={rootRef}
          label={label}
          entries={menu}
          onPick={(action) => {
            setMenuOpen(false);
            onMenuAction(entry.localId, action);
          }}
          onDismiss={() => setMenuOpen(false)}
          onExited={() => setMenuAt(null)}
        />
      )}
    </div>
  );
}

/**
 * Bottom-docked bubble per open chat. Clicking a bubble minimizes its chat
 * if it is the expanded one, otherwise restores it to its last size. The
 * whole strip can collapse into a single right-docked bubble that keeps
 * showing aggregate activity (spinner) and unread indicators.
 */
export function ChatBubbles({
  dragLeft = null,
  placement = "center",
  dragHandlers,
  placementDragHandlers,
  dragTarget = null,
  detached = false,
  edge = "bottom",
  notch = null,
  islandHover = true,
  onDockAt,
  nativeMenus = false,
  onToggleDetached,
  newChatProjectName,
  side = "right",
  themes,
  entries,
  labels,
  icons,
  forks,
  signals,
  unread,
  attention,
  menus,
  activeLocalId,
  collapsed,
  onFoldedChange,
  trailing,
  voice,
  voiceShown = true,
  voiceInDock,
  onVoiceInDockChange,
  onToggle,
  onOpenAs,
  onClose,
  onMenuAction,
  onNewChat,
  onCollapse,
}: ChatBubblesProps) {
  const keybindings = useKeybindings();
  const vertical = edge === "left" || edge === "right";
  const island = edge === "top" && notch !== null;
  // Hints open away from the edge the pill rests on.
  const hintSide =
    edge === "bottom"
      ? "top"
      : edge === "top"
        ? "bottom"
        : edge === "left"
          ? "right"
          : "left";
  const [islandHovered, setIslandHovered] = useState(false);
  // Right-click on the collapsed bubble or the arrows: moves the pill
  // between the window and its own always-on-top window for this session,
  // and in its own window to any edge of the screen.
  const [dockMenuAt, setDockMenuAt] = useState<MenuAt | null>(null);
  const [dockMenuOpen, setDockMenuOpen] = useState(false);
  const dockMenuEntries = [
    ...(onToggleDetached
      ? [
          {
            label: detached
              ? "Put the pill back in the window"
              : "Pop the pill out onto the desktop",
            action: "detach",
          },
        ]
      : []),
    ...(detached && onDockAt
      ? [
          {
            label: "Dock at",
            action: "dock-at",
            submenu: (
              [
                ["bottom", "Bottom"],
                ["left", "Left"],
                ["right", "Right"],
                ["top", notch ? "The notch" : "Top"],
              ] as const
            ).map(([value, label]) => ({
              label,
              action: `dock-at:${value}`,
              checked: edge === value,
            })),
          },
        ]
      : []),
    ...(onVoiceInDockChange
      ? [
          {
            label: "Show voice in dock",
            action: "voice-in-dock",
            checked: voiceInDock === true,
            setting: true,
          },
        ]
      : []),
  ];
  const pickDockMenu = (action: string | null) => {
    if (action === "detach") onToggleDetached?.();
    if (action?.startsWith("dock-at:"))
      onDockAt?.(action.slice("dock-at:".length) as PillEdge);
    if (action === "voice-in-dock") onVoiceInDockChange?.(!voiceInDock);
  };
  const openDockMenu =
    dockMenuEntries.length > 0
      ? (event: MouseEvent<HTMLElement>) => {
          event.preventDefault();
          if (nativeMenus) {
            void desktopApi.dockMenu(dockMenuEntries).then(pickDockMenu);
            return;
          }
          setDockMenuAt(menuAtPointer(event));
          setDockMenuOpen(true);
        }
      : undefined;
  // Tab-mode chats live in the tab bar; only docked/minimized chats get a
  // bubble in the strip. The pill itself always renders so chats never
  // silently vanish from the screen.
  const stripEntries = entries.filter((entry) => entry.mode !== "tab");

  // Bubbles present on mount appear statically; bubbles added later pop in.
  // Once an id qualifies, the animation class sticks — removing it mid-run
  // (e.g. on a quick follow-up render) would cancel the CSS animation, and a
  // kept class never replays. Seen-tracking commits in an effect so the
  // idempotent render-time union survives StrictMode double-renders.
  const seenIdsRef = useRef(new Set<string>());
  const animatedIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  if (mountedRef.current) {
    for (const entry of stripEntries) {
      if (!seenIdsRef.current.has(entry.localId)) {
        animatedIdsRef.current.add(entry.localId);
      }
    }
  }
  const freshIds = animatedIdsRef.current;
  useEffect(() => {
    mountedRef.current = true;
    for (const entry of stripEntries) seenIdsRef.current.add(entry.localId);
  }, [stripEntries]);

  // Derived-state-during-render keeps removed bubbles visible (in place) as
  // exiting snapshots; onAnimationEnd drops them for real.
  const [display, setDisplay] = useState<Display>({
    entries: stripEntries,
    exitingIds: [],
  });
  const liveIds = new Set(stripEntries.map((entry) => entry.localId));
  const prevIds = new Set(display.entries.map((entry) => entry.localId));
  const needsSync =
    stripEntries.some((entry) => {
      const prev = display.entries.find(
        (candidate) => candidate.localId === entry.localId,
      );
      return !prev || prev !== entry;
    }) ||
    display.entries.some(
      (entry) =>
        !liveIds.has(entry.localId) &&
        !display.exitingIds.includes(entry.localId),
    );
  if (needsSync) {
    const exitingIds = display.entries
      .map((entry) => entry.localId)
      .filter((id) => !liveIds.has(id));
    setDisplay({
      entries: [
        ...display.entries.map(
          (entry) =>
            stripEntries.find(
              (candidate) => candidate.localId === entry.localId,
            ) ?? entry,
        ),
        ...stripEntries.filter((entry) => !prevIds.has(entry.localId)),
      ],
      exitingIds,
    });
  }
  const removeExited = (localId: string) =>
    setDisplay((current) => ({
      entries: current.entries.filter((entry) => entry.localId !== localId),
      exitingIds: current.exitingIds.filter((id) => id !== localId),
    }));

  // Indicators aggregate across ALL chats (including tab-mode ones) so the
  // collapsed bubble never hides activity.
  const signalsFor = (localId: string): ChatSignals => ({
    ...(signals[localId] ?? {}),
    unread: unread[localId] ?? false,
    attention: attention[localId] ?? false,
  });
  const aggregate: ChatSignals = {
    working: entries.some((entry) => signals[entry.localId]?.working),
    unread: entries.some((entry) => unread[entry.localId]),
    attention: entries.some((entry) => attention[entry.localId]),
    draft: entries.some((entry) => signals[entry.localId]?.draft),
    awaitingInput: entries.some(
      (entry) => signals[entry.localId]?.awaitingInput,
    ),
  };

  // The rail rests at a corner (collapsed) or at its placement (expanded),
  // anchored by its own edge so growing or shrinking never moves that edge.
  // Moving between resting spots is a FLIP slide: measure, switch anchors,
  // animate the difference. Nothing else in the rail transitions position.
  const railRef = useRef<HTMLDivElement>(null);
  const railWidthRef = useRef(0);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      railWidthRef.current = rail.getBoundingClientRect().width;
    });
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);
  // Only the bottom has spots along it; every other edge centres the pill.
  const spot: Spot =
    edge === "bottom" ? (collapsed ? side : placement) : "center";
  // The spot and drag the DOM shows: what this render may move it from.
  const shownSpot = useRef(spot);
  const shownDragged = useRef(false);
  // The slide under way: the spot it left, and how much of a whole fold's
  // time it was given.
  const slide = useRef<{
    animation: Animation;
    from: Spot;
    shortening: number;
  } | null>(null);
  // A dropped strip slides to its spot from where it was let go, the spot
  // it started from included; a strip changing spots, from where it is
  // drawn. Read before this render reaches the DOM, so it is where the
  // strip is on screen now (mid-slide, mid-fold, after chats came and went
  // or the region moved), never where it was when it last changed spots.
  const slideFrom =
    dragLeft === null && (shownSpot.current !== spot || shownDragged.current)
      ? (railRef.current?.getBoundingClientRect() ?? null)
      : null;
  useLayoutEffect(() => {
    const rail = railRef.current;
    const previous = shownSpot.current;
    shownSpot.current = spot;
    shownDragged.current = dragLeft !== null;
    // A drag moves the strip from where the slide had drawn it (where the
    // press measured it), so the slide stops rather than carry the dragged
    // strip away from the pointer.
    if (dragLeft !== null) {
      slide.current?.animation.cancel();
      slide.current = null;
      return;
    }
    if (!rail || !slideFrom || prefersReducedMotion()) return;
    // The slide under way, if any, is part of where the strip is drawn.
    const running = slide.current;
    slide.current = null;
    // Turned back mid-way, the fold's transitions take only as long as the
    // way back (CSS shortens a reversed transition by how far it had got,
    // in eased progress); the slide back takes the same, so both land
    // together. Anything else starts a whole fold from where it is drawn.
    const progress = running?.animation.effect?.getComputedTiming().progress;
    const shortening =
      running && running.from === spot && progress != null
        ? Math.min(
            1,
            Math.abs(progress * running.shortening + 1 - running.shortening),
          )
        : 1;
    running?.animation.cancel();
    const rect = rail.getBoundingClientRect();
    // Compare the edge that anchors the new spot so a width change during
    // the same commit does not read as travel.
    const delta =
      spot === "right"
        ? slideFrom.right - rect.right
        : spot === "left"
          ? slideFrom.left - rect.left
          : (slideFrom.left + slideFrom.right - rect.left - rect.right) / 2;
    if (Math.abs(delta) < 1) return;
    slide.current = {
      animation: rail.animate(
        [
          { transform: `translateX(${delta}px)` },
          { transform: "translateX(0)" },
        ],
        { duration: motionMs(FOLD_MS) * shortening, easing: EASE_STANDARD },
      ),
      from: previous,
      shortening,
    };
  }, [spot, dragLeft, slideFrom]);
  // Folding or opening makes the control pressed go inert. Read before this
  // render reaches the DOM: when it held focus, the control that takes its
  // place takes focus, so the keyboard keeps its place instead of falling
  // to the page.
  const arrowsRef = useRef<HTMLButtonElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const focusedControl =
    arrowsRef.current !== null && document.activeElement === arrowsRef.current
      ? "arrows"
      : expandRef.current !== null &&
          document.activeElement === expandRef.current
        ? "expand"
        : null;
  useLayoutEffect(() => {
    if (collapsed && focusedControl === "arrows")
      expandRef.current?.focus({ preventScroll: true });
    else if (!collapsed && focusedControl === "expand")
      arrowsRef.current?.focus({ preventScroll: true });
  }, [collapsed, focusedControl]);
  const itemsId = useId();
  const spotClass = vertical
    ? ""
    : spot === "left"
      ? "left-8"
      : spot === "right"
        ? "right-8"
        : "left-1/2 -translate-x-1/2";
  // The arrows point at the corner the strip collapses into and sit on that
  // side of the strip. They are also the handle that moves open chats. On
  // a side the strip folds down into its bubble; at the notch, up into it.
  const Arrows = vertical
    ? ChevronsDown
    : island
      ? ChevronsUp
      : side === "left"
        ? ChevronsLeft
        : ChevronsRight;
  const arrows = (
    <button
      ref={arrowsRef}
      type="button"
      {...placementDragHandlers}
      onClick={() => {
        onFoldedChange(true);
        onCollapse?.();
      }}
      onContextMenu={openDockMenu}
      className="grid size-9 touch-none cursor-grab place-items-center rounded-full text-fg-faint transition-colors duration-150 hover:text-fg active:cursor-grabbing"
      aria-label="Collapse chat bubbles"
      aria-expanded={!collapsed}
      aria-controls={itemsId}
      aria-description={
        detached
          ? "Drag to dock the pill at any edge of the screen. Arrow keys move it."
          : "Drag to place open chats left, center or right. Arrow keys move them."
      }
      aria-keyshortcuts={
        detached
          ? "ArrowLeft ArrowRight ArrowUp ArrowDown"
          : "ArrowLeft ArrowRight"
      }
      data-dock-arrows={side}
    >
      <Arrows className="size-4" />
    </button>
  );
  // Resting spots the drag can choose. The one under the pointer glows.
  const targets = (
    <>
      {dragTarget !== null &&
        (collapsed
          ? (["left", "right"] as const)
          : (["left", "center", "right"] as const)
        ).map((target) => (
          <span
            key={target}
            aria-hidden="true"
            data-dock-target={target}
            data-active={target === dragTarget || undefined}
            className={`pointer-events-none absolute bottom-3 h-11 rounded-full border transition-[opacity,box-shadow,border-color,background-color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
              target === "left"
                ? "left-8"
                : target === "right"
                  ? "right-8"
                  : "left-1/2 -translate-x-1/2"
            } ${
              target === dragTarget
                ? "border-accent/70 bg-accent/10 opacity-100 shadow-[0_0_0_1px_var(--color-accent),0_0_18px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
                : "border-dashed border-border-strong/60 bg-bg-raised/40 opacity-70"
            }`}
            style={{
              width: collapsed ? 44 : Math.max(44, railWidthRef.current),
            }}
          />
        ))}
    </>
  );
  // Expanded strip content folds its width away when collapsed: from the
  // width it shows to none and back (styles.css), so the strip narrows
  // from the first frame as it slides into its corner.
  // At the notch the row shows whenever the island is open, folded or not.
  const itemsHidden = island ? false : collapsed;
  const items = (
    <div
      id={itemsId}
      className={`flex items-center gap-1.5 overflow-hidden duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
        vertical
          ? "flex-col transition-[height,opacity]"
          : "transition-[width,opacity]"
      } ${itemsHidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
      data-bubble-items
      aria-hidden={itemsHidden}
      inert={itemsHidden ? true : undefined}
    >
      {display.entries.map((entry) => (
        <Bubble
          theme={themes?.[entry.localId]}
          key={entry.localId}
          entry={entry}
          label={labels[entry.localId] ?? "Chat"}
          icon={icons[entry.localId] ?? null}
          fork={forks[entry.localId] ?? false}
          signals={signalsFor(entry.localId)}
          exiting={display.exitingIds.includes(entry.localId)}
          fresh={freshIds.has(entry.localId)}
          expanded={entry.mode !== "min" && entry.localId === activeLocalId}
          onToggle={onToggle}
          onOpenAs={onOpenAs}
          onClose={onClose}
          menu={menus[entry.localId]}
          nativeMenus={nativeMenus}
          onMenuAction={onMenuAction}
          onExited={removeExited}
          hintSide={hintSide}
        />
      ))}
      {/* The bubble + opens the floating aside, not a tab. */}
      <ShortcutHint
        label={
          newChatProjectName ? `New chat in ${newChatProjectName}` : "New chat"
        }
        shortcut={formatBinding(keybindings["new-floating-chat"])}
        side={hintSide}
      >
        <button
          type="button"
          onClick={onNewChat}
          className="grid size-9 cursor-pointer place-items-center rounded-full border border-dashed border-border text-fg-faint transition-colors duration-150 hover:border-border-strong hover:text-fg"
          aria-label="New chat"
        >
          <Plus className="size-4" />
        </button>
      </ShortcutHint>
    </div>
  );
  // Downloads and the microphone sit between the chats and the arrows,
  // the microphone next to the arrows; both stay when the strip folds.
  // Kept out of the dock, the microphone shrinks to nothing in place and
  // takes its gap with it: beside downloads, the gap between them; alone,
  // the dock's gap around the tools, which leaves them empty.
  const voiceSlot = (
    <div
      data-dock-voice={voiceShown ? "shown" : "hidden"}
      className={`duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
        vertical
          ? `transition-[max-height,margin,opacity,scale] ${
              voiceShown
                ? "max-h-9 opacity-100"
                : "pointer-events-none max-h-0 overflow-hidden opacity-0 scale-40 -mt-1.5"
            }`
          : `transition-[max-width,margin,opacity,scale] ${
              voiceShown
                ? "max-w-9 opacity-100"
                : `pointer-events-none max-w-0 overflow-hidden opacity-0 scale-40 ${side === "left" ? "-me-1.5" : "-ms-1.5"}`
            }`
      }`}
      aria-hidden={!voiceShown}
      inert={!voiceShown ? true : undefined}
    >
      {voice}
    </div>
  );
  const tools = vertical ? (
    <div
      className={`flex flex-col items-center gap-1.5 transition-[margin] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
        collapsed
          ? "mb-1 [&:has(>[data-dock-voice=hidden]:only-child)]:mb-0"
          : "[&:has(>[data-dock-voice=hidden]:only-child)]:-mt-1.5"
      }`}
    >
      {trailing}
      {voiceSlot}
    </div>
  ) : (
    <div
      className={`flex items-center gap-1.5 transition-[margin] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
        side === "left"
          ? collapsed
            ? "ms-1 [&:has(>[data-dock-voice=hidden]:only-child)]:ms-0"
            : "[&:has(>[data-dock-voice=hidden]:only-child)]:-ms-1.5"
          : collapsed
            ? "me-1 [&:has(>[data-dock-voice=hidden]:only-child)]:me-0"
            : "[&:has(>[data-dock-voice=hidden]:only-child)]:-me-1.5"
      }`}
    >
      {side === "left" ? (
        <>
          {voiceSlot}
          {trailing}
        </>
      ) : (
        <>
          {trailing}
          {voiceSlot}
        </>
      )}
    </div>
  );
  // The arrows fold away with the strip; the collapsed bubble takes their
  // place as the outermost control.
  const arrowsSlot = (
    <div
      className={`flex overflow-hidden duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
        vertical
          ? `transition-[max-height,opacity] ${
              collapsed
                ? "pointer-events-none max-h-0 opacity-0"
                : "max-h-9 opacity-100"
            }`
          : `transition-[max-width,opacity] ${
              collapsed
                ? "pointer-events-none max-w-0 opacity-0"
                : "max-w-9 opacity-100"
            }`
      }`}
      aria-hidden={collapsed}
      inert={collapsed ? true : undefined}
    >
      {arrows}
    </div>
  );
  const collapsedBubble = (
    <button
      ref={expandRef}
      type="button"
      {...dragHandlers}
      onClick={() => onFoldedChange(false)}
      onContextMenu={openDockMenu}
      // Its edge is a ring, not a border: a border is never thinner than a
      // pixel, so the strip would snap 2px as the bubble comes and goes.
      className={`relative grid touch-none cursor-grab active:cursor-grabbing place-items-center overflow-visible rounded-full bg-bg-overlay text-fg-muted inset-ring inset-ring-border duration-250 ease-[cubic-bezier(0.2,0,0,1)] hover:text-fg hover:inset-ring-border-strong ${
        vertical
          ? `transition-[max-height,opacity,background-color,box-shadow] ${
              collapsed
                ? "size-9 max-h-9 opacity-100"
                : "pointer-events-none size-9 max-h-0 opacity-0"
            }`
          : `transition-[max-width,opacity,background-color,box-shadow] ${
              collapsed
                ? "size-9 max-w-9 opacity-100"
                : "pointer-events-none size-9 max-w-0 opacity-0"
            }`
      }`}
      aria-label="Expand chat bubbles"
      aria-expanded={!collapsed}
      aria-controls={itemsId}
      aria-description={
        detached
          ? "Drag to dock the pill at any edge of the screen. Arrow keys move it."
          : "Drag to either bottom corner. Arrow keys move left or right."
      }
      aria-keyshortcuts={
        detached
          ? "ArrowLeft ArrowRight ArrowUp ArrowDown"
          : "ArrowLeft ArrowRight"
      }
      aria-hidden={!collapsed}
      inert={!collapsed ? true : undefined}
    >
      {/* Signals only while shown: the open strip keeps this bubble mounted
          but invisible, and a spinner or pulse there would keep the
          compositor drawing for nothing. */}
      <SignalGlyph
        working={collapsed && aggregate.working}
        awaitingInput={collapsed && aggregate.awaitingInput}
        className="size-4"
      >
        <MessageSquare className="size-4" />
      </SignalGlyph>
      {stripEntries.length > 1 && (
        <span className="absolute -bottom-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full border border-border bg-bg-raised px-0.5 text-[9px] font-semibold leading-4 text-fg-muted">
          {stripEntries.length}
        </span>
      )}
      <span className="absolute -right-0.5 -top-0.5">
        <SignalBadge signals={collapsed ? aggregate : NO_SIGNALS} size="md" />
      </span>
    </button>
  );
  const dockMenu = dockMenuAt && (
    <MenuPortal
      open={dockMenuOpen}
      at={dockMenuAt}
      label="Pill"
      entries={dockMenuEntries}
      onPick={(entry) => {
        setDockMenuOpen(false);
        pickDockMenu(entry.action);
      }}
      onDismiss={() => setDockMenuOpen(false)}
      onExited={() => setDockMenuAt(null)}
    />
  );
  if (island && notch) {
    // The island's own handle in its right wing: the chats' bubble, always
    // shown, opening or folding the strip; it peels the island off the
    // notch when dragged.
    const handle = (
      <button
        ref={expandRef}
        type="button"
        {...dragHandlers}
        onClick={() => onFoldedChange(!collapsed)}
        onContextMenu={openDockMenu}
        className="relative grid size-7 touch-none cursor-grab place-items-center rounded-full text-fg-muted transition-colors duration-150 hover:text-fg active:cursor-grabbing"
        aria-label={collapsed ? "Open the pill" : "Fold the pill"}
        aria-expanded={!collapsed}
        aria-controls={itemsId}
        aria-description="Drag to dock the pill at any edge of the screen. Arrow keys move it."
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
        data-island-handle
      >
        <SignalGlyph
          working={aggregate.working}
          awaitingInput={aggregate.awaitingInput}
          className="size-4"
        >
          <MessageSquare className="size-4" />
        </SignalGlyph>
        {stripEntries.length > 1 && (
          <span className="absolute -bottom-1 -right-1.5 grid min-w-4 place-items-center rounded-full bg-bg-overlay px-0.5 text-[9px] font-semibold leading-4 text-fg">
            {stripEntries.length}
          </span>
        )}
        <span className="absolute -right-1 -top-1">
          <SignalBadge signals={aggregate} size="md" />
        </span>
      </button>
    );
    return (
      <div
        data-dock-edge={edge}
        className="pointer-events-none absolute inset-0 z-40"
      >
        <div
          ref={railRef}
          data-dock-rail
          data-dock-collapsed={collapsed}
          className="contents"
        >
          <PillIsland
            notch={notch}
            open={!collapsed}
            hoverOpens={islandHover}
            hovered={islandHovered}
            onHoverChange={setIslandHovered}
            leftWing={voiceShown ? voice : null}
            rightWing={handle}
            row={
              <>
                {items}
                {trailing}
                {arrows}
              </>
            }
          />
        </div>
        {dockMenu}
      </div>
    );
  }
  const rootClass =
    edge === "top"
      ? "pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center pt-3"
      : edge === "left"
        ? "pointer-events-none absolute inset-y-0 left-0 z-40 flex items-center pl-3"
        : edge === "right"
          ? "pointer-events-none absolute inset-y-0 right-0 z-40 flex items-center pr-3"
          : "pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-3";
  const railPlace =
    edge === "top"
      ? `top-3 flex-row ${spotClass}`
      : edge === "left"
        ? "left-3 top-1/2 -translate-y-1/2 flex-col"
        : edge === "right"
          ? "right-3 top-1/2 -translate-y-1/2 flex-col"
          : `bottom-3 ${spotClass}`;
  return (
    <div data-dock-edge={edge} className={rootClass}>
      {targets}
      <div
        ref={railRef}
        data-dock-rail
        data-dock-collapsed={collapsed}
        data-dock-dragging={dragLeft !== null || undefined}
        style={
          dragLeft === null
            ? undefined
            : { left: dragLeft, right: "auto", translate: "0" }
        }
        className={`pointer-events-auto absolute flex items-center rounded-full border border-border bg-bg-raised shadow-2xl transition-[padding,gap] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${railPlace} ${
          collapsed ? "gap-0 p-1" : "gap-1.5 p-1.5"
        }`}
      >
        {/* The outer edge is one slot the arrows and the collapsed bubble
            share, so folding cross-fades them in place. On a side the
            column ends in it, at the bottom. */}
        {vertical ? (
          <>
            {items}
            {tools}
            <div className="flex flex-col">
              {arrowsSlot}
              {collapsedBubble}
            </div>
          </>
        ) : side === "left" ? (
          <>
            <div className="flex">
              {collapsedBubble}
              {arrowsSlot}
            </div>
            {tools}
            {items}
          </>
        ) : (
          <>
            {items}
            {tools}
            <div className="flex">
              {arrowsSlot}
              {collapsedBubble}
            </div>
          </>
        )}
      </div>
      {dockMenu}
    </div>
  );
}
