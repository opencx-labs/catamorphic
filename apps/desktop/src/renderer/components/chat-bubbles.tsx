import {
  ChevronsLeft,
  ChevronsRight,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type DOMAttributes,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { openModeFromEvent } from "../../shared/open-mode.js";
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
import {
  type ChatSignals,
  combineSignals,
  SignalBadge,
  SignalGlyph,
} from "./chat-signals";
import { type MenuAt, MenuPortal, menuAtPointer } from "./menu.js";
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
}: {
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
    // Flex, like every dock slot: the hint's inline anchor in a block would
    // sit on a text line, and its descender space would lift the bubble.
    <div
      ref={rootRef}
      data-chat-bubble={entry.localId}
      data-session-id={entry.sessionId}
      style={theme}
      className={`group relative flex ${
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
      <ShortcutHint label={label} side="top" delay={BUBBLE_HINT_DELAY_MS}>
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
          className={`relative grid size-9 cursor-pointer place-items-center rounded-full border transition-[background-color,border-color,scale] duration-150 ease-standard active:scale-95 ${
            asking ? "animate-bubble-ask " : ""
          }${
            expanded
              ? "border-accent/60 bg-accent/15 text-accent"
              : "border-accent/25 bg-bg-overlay text-accent/80 hover:border-accent/60 hover:text-accent"
          }`}
          aria-label={expanded ? `Minimize ${label}` : `Open ${label}`}
          aria-expanded={expanded}
        >
          <SignalGlyph activity={signals.activity} className="size-4">
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
 * showing the docked chats' activity and unread indicators (chats in tabs
 * show theirs on their tabs).
 */
export function ChatBubbles({
  dragLeft = null,
  placement = "center",
  dragHandlers,
  placementDragHandlers,
  dragTarget = null,
  detached = false,
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
  // Right-click on the collapsed bubble or the arrows: moves the dock
  // between the window and its own always-on-top window for this session.
  const [dockMenuAt, setDockMenuAt] = useState<MenuAt | null>(null);
  const [dockMenuOpen, setDockMenuOpen] = useState(false);
  const dockMenuEntries = [
    ...(onToggleDetached
      ? [
          {
            label: detached
              ? "Return dock to the window"
              : "Float dock in its own window",
            action: "detach",
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

  const signalsFor = (localId: string): ChatSignals => ({
    ...(signals[localId] ?? {}),
    unread: unread[localId] ?? false,
    attention: attention[localId] ?? false,
  });
  // The folded bubble speaks for the chats in the dock only: a chat put
  // there (minimized) is one the person follows by its bubble, while a
  // chat in a tab says what it is doing on its tab.
  const aggregate = combineSignals(
    stripEntries.map((entry) => signalsFor(entry.localId)),
  );

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
  const spot: Spot = collapsed ? side : placement;
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
  const spotClass =
    spot === "left"
      ? "left-8"
      : spot === "right"
        ? "right-8"
        : "left-1/2 -translate-x-1/2";
  // The arrows point at the corner the strip collapses into and sit on that
  // side of the strip. They are also the handle that moves open chats.
  const Arrows = side === "left" ? ChevronsLeft : ChevronsRight;
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
      aria-description="Drag to place open chats left, center or right. Arrow keys move them."
      aria-keyshortcuts="ArrowLeft ArrowRight"
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
            className={`pointer-events-none absolute bottom-3 h-11 rounded-full border transition-[opacity,box-shadow,border-color,background-color] duration-150 ease-standard ${
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
  const items = (
    <div
      key="items"
      id={itemsId}
      className={`flex items-center gap-1.5 overflow-hidden transition-[width,opacity] duration-250 ease-standard ${
        collapsed ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      data-bubble-items
      aria-hidden={collapsed}
      inert={collapsed ? true : undefined}
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
        />
      ))}
      {/* The bubble + opens the floating aside, not a tab. */}
      <ShortcutHint
        label={
          newChatProjectName ? `New chat in ${newChatProjectName}` : "New chat"
        }
        shortcut={formatBinding(keybindings["new-floating-chat"])}
        side="top"
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
  // the dock's gap around the tools, which leaves them empty. The slot is
  // flex: a block would put the microphone's hint on a text line, whose
  // descender space lifted it above the bubbles and grew the dock.
  const voiceSlot = (
    <div
      key="voice"
      data-dock-voice={voiceShown ? "shown" : "hidden"}
      className={`flex transition-[max-width,margin,opacity,scale] duration-200 ease-standard ${
        voiceShown
          ? "max-w-9 opacity-100"
          : `pointer-events-none max-w-0 overflow-hidden opacity-0 scale-40 ${side === "left" ? "-me-1.5" : "-ms-1.5"}`
      }`}
      aria-hidden={!voiceShown}
      inert={!voiceShown ? true : undefined}
    >
      {voice}
    </div>
  );
  const trailingSlot = <Fragment key="trailing">{trailing}</Fragment>;
  const tools = (
    <div
      key="tools"
      className={`flex items-center gap-1.5 transition-[margin] duration-200 ease-standard ${
        side === "left"
          ? collapsed
            ? "ms-1 [&:has(>[data-dock-voice=hidden]:only-child)]:ms-0"
            : "[&:has(>[data-dock-voice=hidden]:only-child)]:-ms-1.5"
          : collapsed
            ? "me-1 [&:has(>[data-dock-voice=hidden]:only-child)]:me-0"
            : "[&:has(>[data-dock-voice=hidden]:only-child)]:-me-1.5"
      }`}
    >
      {side === "left" ? [voiceSlot, trailingSlot] : [trailingSlot, voiceSlot]}
    </div>
  );
  // The arrows fold away with the strip; the collapsed bubble takes their
  // place as the outermost control.
  const arrowsSlot = (
    <div
      key="arrows"
      className={`flex overflow-hidden transition-[max-width,opacity] duration-250 ease-standard ${
        collapsed
          ? "pointer-events-none max-w-0 opacity-0"
          : "max-w-9 opacity-100"
      }`}
      aria-hidden={collapsed}
      inert={collapsed ? true : undefined}
    >
      {arrows}
    </div>
  );
  const collapsedBubble = (
    <button
      key="expand"
      ref={expandRef}
      type="button"
      {...dragHandlers}
      onClick={() => onFoldedChange(false)}
      onContextMenu={openDockMenu}
      // Its edge is a ring, not a border: a border is never thinner than a
      // pixel, so the strip would snap 2px as the bubble comes and goes.
      className={`relative grid touch-none cursor-grab active:cursor-grabbing place-items-center overflow-visible rounded-full bg-bg-overlay text-fg-muted inset-ring inset-ring-border transition-[max-width,opacity,background-color,box-shadow] duration-250 ease-standard hover:text-fg hover:inset-ring-border-strong ${
        collapsed
          ? "size-9 max-w-9 opacity-100"
          : "pointer-events-none size-9 max-w-0 opacity-0"
      }`}
      aria-label="Expand chat bubbles"
      aria-expanded={!collapsed}
      aria-controls={itemsId}
      aria-description="Drag to either bottom corner. Arrow keys move left or right."
      aria-keyshortcuts="ArrowLeft ArrowRight"
      aria-hidden={!collapsed}
      inert={!collapsed ? true : undefined}
    >
      {/* Signals only while shown: the open strip keeps this bubble mounted
          but invisible, and a spinner or pulse there would keep the
          compositor drawing for nothing. */}
      <SignalGlyph
        activity={collapsed ? aggregate.activity : null}
        className="size-4"
      >
        <MessageSquare className="size-4" />
      </SignalGlyph>
      {/* The count takes the lower-left corner: the icon's own lower
          corner says what the chats are doing. */}
      {stripEntries.length > 1 && (
        <span className="absolute -bottom-0.5 -left-0.5 grid min-w-4 place-items-center rounded-full border border-border bg-bg-raised px-0.5 text-[9px] font-semibold leading-4 text-fg-muted">
          {stripEntries.length}
        </span>
      )}
      <span className="absolute -right-0.5 -top-0.5">
        <SignalBadge signals={collapsed ? aggregate : NO_SIGNALS} size="md" />
      </span>
    </button>
  );
  // The outer edge is one slot the arrows and the collapsed bubble share,
  // so folding cross-fades them in place. The strip mirrors for its side
  // by moving its controls, keyed, never by drawing them anew: drawn anew,
  // downloads would vanish until it had read its profile again.
  const edge = (
    <div key="edge" className="flex">
      {side === "left"
        ? [collapsedBubble, arrowsSlot]
        : [arrowsSlot, collapsedBubble]}
    </div>
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-3">
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
        className={`pointer-events-auto absolute bottom-3 flex items-center rounded-full border border-border bg-bg-raised shadow-2xl transition-[padding,gap] duration-250 ease-standard ${spotClass} ${
          collapsed ? "gap-0 p-1" : "gap-1.5 p-1.5"
        }`}
      >
        {side === "left" ? [edge, tools, items] : [items, tools, edge]}
      </div>
      {dockMenuAt && (
        <MenuPortal
          open={dockMenuOpen}
          at={dockMenuAt}
          label="Dock"
          entries={dockMenuEntries}
          onPick={(entry) => {
            setDockMenuOpen(false);
            pickDockMenu(entry.action);
          }}
          onDismiss={() => setDockMenuOpen(false)}
          onExited={() => setDockMenuAt(null)}
        />
      )}
    </div>
  );
}
