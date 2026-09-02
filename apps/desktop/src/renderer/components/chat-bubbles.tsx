import { ChevronsRight, MessageSquare, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatSessionMenuEntry } from "../lib/chat-session-actions.js";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import type { ChatDockEntry } from "./chat-dock";
import { ChatGlyph } from "./chat-icon";
import { type ChatSignals, SignalBadge, SignalGlyph } from "./chat-signals";
import { ShortcutHint } from "./shortcut-hint";
import { MenuPortal } from "./sidebar-item-row.js";

/** Bubbles identify themselves on hover without delay (unlike buttons,
    whose labels are usually inferable — a bubble is just an icon). */
const BUBBLE_HINT_DELAY_MS = 100;

export interface ChatBubblesProps {
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
  onMenuAction,
  onExited,
}: {
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
  onMenuAction: (localId: string, action: ChatSessionMenuEntry) => void;
  onExited: (localId: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const prevAwaitingRef = useRef(signals.awaitingInput ?? false);
  if (prevAwaitingRef.current !== (signals.awaitingInput ?? false)) {
    prevAwaitingRef.current = signals.awaitingInput ?? false;
    if (signals.awaitingInput) setAsking(true);
  }
  useEffect(() => {
    if (!menuAt) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-menu]")
      ) {
        return;
      }
      setMenuAt(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuAt(null);
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
  }, [menuAt]);
  return (
    <div
      data-session-id={entry.sessionId}
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
                  setMenuAt({ x: event.clientX, y: event.clientY });
                }
              : undefined
          }
          className={`relative grid size-9 cursor-pointer place-items-center rounded-full border transition-[background-color,border-color,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-95 ${
            asking ? "animate-bubble-ask " : ""
          }${
            expanded
              ? "border-accent/60 bg-accent/15 text-accent"
              : "border-border bg-bg-overlay text-fg-muted hover:border-border-strong hover:text-fg"
          }`}
          aria-label={expanded ? `Minimize ${label}` : `Open ${label}`}
          aria-expanded={expanded}
        >
          <SignalGlyph working={signals.working} className="size-4">
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
          className="absolute -left-1 -top-1 grid size-4 cursor-pointer place-items-center rounded-full border border-border bg-bg-overlay text-fg-faint opacity-0 transition-opacity duration-150 hover:text-fg group-hover:opacity-100"
          aria-label={`Close ${label}`}
        >
          <X className="size-2.5" />
        </button>
      )}
      {menuAt && menu && (
        <MenuPortal
          position={menuAt}
          entries={menu}
          onPick={(action) => {
            setMenuAt(null);
            onMenuAction(entry.localId, action);
          }}
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
  entries,
  labels,
  icons,
  forks,
  signals,
  unread,
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
  });
  const aggregate: ChatSignals = {
    working: entries.some((entry) => signals[entry.localId]?.working),
    unread: entries.some((entry) => unread[entry.localId]),
    draft: entries.some((entry) => signals[entry.localId]?.draft),
    awaitingInput: entries.some(
      (entry) => signals[entry.localId]?.awaitingInput,
    ),
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-3">
      {/* The pill slides between centered (expanded) and right-docked
          (collapsed) via left+transform, both animatable. */}
      <div
        className={`pointer-events-auto absolute bottom-3 flex items-center rounded-full border border-border bg-bg-raised/95 shadow-2xl backdrop-blur-xl transition-[left,translate,padding] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
          collapsed
            ? "left-full -translate-x-[calc(100%+12px)] p-1"
            : "left-1/2 -translate-x-1/2 gap-1.5 p-1.5"
        }`}
      >
        {/* Expanded strip content folds its width away when collapsed. */}
        <div
          className={`flex items-center overflow-hidden transition-[max-width,opacity] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
            collapsed
              ? "pointer-events-none max-w-0 opacity-0"
              : "max-w-[60vw] gap-1.5 opacity-100"
          }`}
          aria-hidden={collapsed}
          inert={collapsed ? true : undefined}
        >
          {display.entries.map((entry) => (
            <Bubble
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
              onMenuAction={onMenuAction}
              onExited={removeExited}
            />
          ))}
          {/* The bubble + opens the floating aside, not a tab. */}
          <ShortcutHint
            label="New chat"
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
          <ShortcutHint label="Collapse chat bubbles" side="top">
            <button
              type="button"
              onClick={() => {
                setCollapseOverride(true);
                onCollapse?.();
              }}
              className="grid size-9 cursor-pointer place-items-center rounded-full text-fg-faint transition-colors duration-150 hover:text-fg"
              aria-label="Collapse chat bubbles"
            >
              <ChevronsRight className="size-4" />
            </button>
          </ShortcutHint>
        </div>

        {/* Collapsed single bubble; carries aggregate indicators. */}
        <ShortcutHint
          label="Expand chat bubbles"
          side="top"
          delay={BUBBLE_HINT_DELAY_MS}
        >
          <button
            type="button"
            onClick={() => setCollapseOverride(false)}
            className={`relative grid cursor-pointer place-items-center overflow-visible rounded-full border border-border bg-bg-overlay text-fg-muted transition-[max-width,opacity,background-color,border-color] duration-250 ease-[cubic-bezier(0.2,0,0,1)] hover:border-border-strong hover:text-fg ${
              collapsed
                ? "size-9 max-w-9 opacity-100"
                : "pointer-events-none size-9 max-w-0 border-0 opacity-0"
            }`}
            aria-label="Expand chat bubbles"
            aria-hidden={!collapsed}
            inert={!collapsed ? true : undefined}
          >
            <SignalGlyph working={aggregate.working} className="size-4">
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
        </ShortcutHint>
      </div>
    </div>
  );
}
