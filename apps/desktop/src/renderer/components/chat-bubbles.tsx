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
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ChatSessionMenuEntry } from "../lib/chat-session-actions.js";
import { desktopApi } from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import { EASE_STANDARD, motionMs } from "../lib/motion.js";
import type { ChatDockEntry } from "./chat-dock";
import { ChatGlyph } from "./chat-icon";
import { type ChatSignals, SignalBadge, SignalGlyph } from "./chat-signals";
import { ShortcutHint } from "./shortcut-hint";
import { MenuPortal } from "./sidebar-item-row.js";

/** Bubbles identify themselves on hover without delay (unlike buttons,
    whose labels are usually inferable — a bubble is just an icon). */
const BUBBLE_HINT_DELAY_MS = 100;

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
  /**
   * The focused workspace tab wants the bottom edge clear (e.g. a chat tab):
   * the strip folds into one bubble docked at the right. The user can still
   * pull it back open; the fold re-applies next time such a tab gains focus.
   */
  autoCollapse: boolean;
  /** Reports the effective collapsed state so hosts can clear the bottom. */
  onCollapsedChange?: (collapsed: boolean) => void;
  onToggle: (localId: string) => void;
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
  onClose: (localId: string) => void;
  menu?: ChatSessionMenuEntry[];
  nativeMenus?: boolean;
  onMenuAction: (localId: string, action: ChatSessionMenuEntry) => void;
  onExited: (localId: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const prevAwaitingRef = useRef(signals.awaitingInput ?? false);
  if (prevAwaitingRef.current !== (signals.awaitingInput ?? false)) {
    prevAwaitingRef.current = signals.awaitingInput ?? false;
    if (signals.awaitingInput) setAsking(true);
  }
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      ) {
        return;
      }
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [menuOpen]);
  return (
    <div
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
      <ShortcutHint label={label} side="top" delay={BUBBLE_HINT_DELAY_MS}>
        <button
          type="button"
          onClick={() => onToggle(entry.localId)}
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
                  setMenuAt({ x: event.clientX, y: event.clientY });
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
          position={menuAt}
          entries={menu}
          onPick={(action) => {
            setMenuOpen(false);
            onMenuAction(entry.localId, action);
          }}
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
  autoCollapse,
  onCollapsedChange,
  onToggle,
  onClose,
  onMenuAction,
  onNewChat,
  onCollapse,
}: ChatBubblesProps) {
  const keybindings = useKeybindings();
  // Right-click on the collapsed bubble or the arrows: moves the dock
  // between the window and its own always-on-top window for this session.
  const [dockMenuAt, setDockMenuAt] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dockMenuOpen, setDockMenuOpen] = useState(false);
  const dockMenuEntries = [
    {
      label: detached
        ? "Return dock to the window"
        : "Float dock in its own window",
      action: "detach",
    },
  ];
  const openDockMenu = onToggleDetached
    ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        if (nativeMenus) {
          void desktopApi.dockMenu(dockMenuEntries).then((action) => {
            if (action === "detach") onToggleDetached();
          });
          return;
        }
        setDockMenuAt({ x: event.clientX, y: event.clientY });
        setDockMenuOpen(true);
      }
    : undefined;
  useEffect(() => {
    if (!dockMenuOpen) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      )
        return;
      setDockMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDockMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dockMenuOpen]);
  // User override: true = collapsed, false = expanded, null = follow
  // autoCollapse. Re-arms (back to null) whenever autoCollapse turns on, so
  // focusing a chat tab folds the strip again even after a manual expand.
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(
    null,
  );
  const prevAutoRef = useRef(autoCollapse);
  if (prevAutoRef.current !== autoCollapse) {
    prevAutoRef.current = autoCollapse;
    setCollapseOverride(null);
  }
  const collapsed = collapseOverride ?? autoCollapse;

  // Tab-mode chats live in the tab bar; only docked/minimized chats get a
  // bubble in the strip. The pill itself always renders so chats never
  // silently vanish from the screen.
  const stripEntries = entries.filter((entry) => entry.mode !== "tab");

  const onCollapsedChangeRef = useRef(onCollapsedChange);
  onCollapsedChangeRef.current = onCollapsedChange;
  useEffect(() => {
    onCollapsedChangeRef.current?.(collapsed);
  }, [collapsed]);

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
  const spot = collapsed ? side : placement;
  const lastRect = useRef<DOMRect | null>(null);
  const lastSpot = useRef(spot);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const previous = lastRect.current;
    const rect = rail.getBoundingClientRect();
    lastRect.current = rect;
    if (lastSpot.current === spot || dragLeft !== null) {
      lastSpot.current = spot;
      return;
    }
    lastSpot.current = spot;
    if (
      !previous ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    // Compare the edge that anchors the new spot so a width change during
    // the same commit does not read as travel.
    const delta =
      spot === "right"
        ? previous.right - rect.right
        : spot === "left"
          ? previous.left - rect.left
          : (previous.left + previous.right - rect.left - rect.right) / 2;
    if (Math.abs(delta) < 1) return;
    rail.animate(
      [{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }],
      { duration: motionMs(200), easing: EASE_STANDARD, composite: "add" },
    );
  }, [spot, dragLeft]);
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
      type="button"
      {...placementDragHandlers}
      onClick={() => {
        setCollapseOverride(true);
        onCollapse?.();
      }}
      onContextMenu={openDockMenu}
      className="grid size-9 touch-none cursor-grab place-items-center rounded-full text-fg-faint transition-colors duration-150 hover:text-fg active:cursor-grabbing"
      aria-label="Collapse chat bubbles"
      aria-description="Drag to place open chats left, center or right. Arrow keys move them."
      aria-keyshortcuts="ArrowLeft ArrowRight"
      data-dock-arrows={side}
    >
      <Arrows className="size-4" />
    </button>
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-3">
      {/* Resting spots the drag can choose. The one under the pointer glows. */}
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
        className={`pointer-events-auto absolute bottom-3 flex items-center rounded-full border border-border bg-bg-raised shadow-2xl transition-[padding] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${spotClass} ${
          collapsed ? "p-1" : "gap-1.5 p-1.5"
        }`}
      >
        {/* Expanded strip content folds its width away when collapsed. */}
        <div
          className={`flex items-center overflow-hidden transition-[max-width,opacity] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
            collapsed
              ? "pointer-events-none max-w-0 opacity-0"
              : "max-w-[60vw] gap-1.5 opacity-100"
          }`}
          data-bubble-items
          aria-hidden={collapsed}
          inert={collapsed ? true : undefined}
        >
          {side === "left" && arrows}
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
              newChatProjectName
                ? `New chat in ${newChatProjectName}`
                : "New chat"
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
          {side === "right" && arrows}
        </div>

        {/* Collapsed single bubble; carries aggregate indicators. */}
        <button
          type="button"
          {...dragHandlers}
          onClick={() => setCollapseOverride(false)}
          onContextMenu={openDockMenu}
          className={`relative grid touch-none cursor-grab active:cursor-grabbing place-items-center overflow-visible rounded-full border border-border bg-bg-overlay text-fg-muted transition-[max-width,opacity,background-color,border-color] duration-250 ease-[cubic-bezier(0.2,0,0,1)] hover:border-border-strong hover:text-fg ${
            collapsed
              ? "size-9 max-w-9 opacity-100"
              : "pointer-events-none size-9 max-w-0 border-0 opacity-0"
          }`}
          aria-label="Expand chat bubbles"
          aria-description="Drag to either bottom corner. Arrow keys move left or right."
          aria-keyshortcuts="ArrowLeft ArrowRight"
          aria-hidden={!collapsed}
          inert={!collapsed ? true : undefined}
        >
          <SignalGlyph
            working={aggregate.working}
            awaitingInput={aggregate.awaitingInput}
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
            <SignalBadge signals={aggregate} size="md" />
          </span>
        </button>
      </div>
      {dockMenuAt && onToggleDetached && (
        <MenuPortal
          open={dockMenuOpen}
          position={dockMenuAt}
          entries={dockMenuEntries}
          onPick={() => {
            setDockMenuOpen(false);
            onToggleDetached();
          }}
          onExited={() => setDockMenuAt(null)}
        />
      )}
    </div>
  );
}
