import {
  ChevronsRight,
  LoaderCircle,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBinding, useKeybindings } from "../lib/keybindings";
import type { ChatDockEntry } from "./chat-dock";
import { ShortcutHint } from "./shortcut-hint";

export interface ChatBubblesProps {
  /** All chats; tab-mode chats contribute indicators but no strip bubble. */
  entries: ChatDockEntry[];
  labels: Record<string, string>;
  /** The agent is working on the chat (send in flight OR server-side turn). */
  sending: Record<string, boolean>;
  /** Response arrived while the chat was minimized; shown as a dot. */
  unread: Record<string, boolean>;
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
 * Bottom-docked bubble per open chat. Clicking a bubble minimizes its chat
 * if it is the expanded one, otherwise restores it to its last size. The
 * whole strip can collapse into a single right-docked bubble that keeps
 * showing aggregate activity (spinner) and unread indicators.
 */
export function ChatBubbles({
  entries,
  labels,
  sending,
  unread,
  activeLocalId,
  autoCollapse,
  onCollapsedChange,
  onToggle,
  onClose,
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
  const anySending = entries.some((entry) => sending[entry.localId]);
  const anyUnread = entries.some((entry) => unread[entry.localId]);

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
          {display.entries.map((entry) => {
            const exiting = display.exitingIds.includes(entry.localId);
            const expanded =
              entry.mode !== "min" && entry.localId === activeLocalId;
            const isSending = sending[entry.localId];
            const isUnread = unread[entry.localId];
            return (
              <div
                key={entry.localId}
                className={`group relative ${
                  exiting
                    ? "animate-bubble-out pointer-events-none"
                    : freshIds.has(entry.localId)
                      ? "animate-bubble-in"
                      : ""
                }`}
                onAnimationEnd={(event) => {
                  if (event.animationName === "bubble-out") {
                    removeExited(entry.localId);
                  }
                }}
              >
                <button
                  type="button"
                  onClick={() => onToggle(entry.localId)}
                  className={`relative grid size-9 cursor-pointer place-items-center rounded-full border transition-[background-color,border-color,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-95 ${
                    expanded
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-border bg-bg-overlay text-fg-muted hover:border-border-strong hover:text-fg"
                  }`}
                  aria-label={
                    expanded
                      ? `Minimize ${labels[entry.localId] ?? "chat"}`
                      : `Open ${labels[entry.localId] ?? "chat"}`
                  }
                  aria-expanded={expanded}
                  title={labels[entry.localId] ?? "Chat"}
                >
                  {/* Stacked icons cross-fade on the sending transition. */}
                  <span className="relative grid size-4 place-items-center">
                    <MessageSquare
                      className={`col-start-1 row-start-1 size-4 transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                        isSending
                          ? "scale-50 opacity-0"
                          : "scale-100 opacity-100"
                      }`}
                    />
                    <LoaderCircle
                      className={`col-start-1 row-start-1 size-4 animate-spin text-accent transition-[opacity] duration-200 ${
                        isSending ? "opacity-100" : "opacity-0"
                      }`}
                    />
                  </span>
                  <span
                    className={`absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                      isUnread && !isSending
                        ? "scale-100 opacity-100"
                        : "scale-0 opacity-0"
                    }`}
                  />
                </button>
                {!exiting && (
                  <button
                    type="button"
                    onClick={() => onClose(entry.localId)}
                    className="absolute -right-1 -top-1 grid size-4 cursor-pointer place-items-center rounded-full border border-border bg-bg-overlay text-fg-faint opacity-0 transition-opacity duration-150 hover:text-fg group-hover:opacity-100"
                    aria-label={`Close ${labels[entry.localId] ?? "chat"}`}
                  >
                    <X className="size-2.5" />
                  </button>
                )}
              </div>
            );
          })}
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
          <button
            type="button"
            onClick={() => {
              setCollapseOverride(true);
              onCollapse?.();
            }}
            className="grid size-9 cursor-pointer place-items-center rounded-full text-fg-faint transition-colors duration-150 hover:text-fg"
            aria-label="Collapse chat bubbles"
            title="Collapse"
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>

        {/* Collapsed single bubble; carries aggregate indicators. */}
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
          title="Expand chats"
        >
          <span className="relative grid size-4 place-items-center">
            <MessageSquare
              className={`col-start-1 row-start-1 size-4 transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                anySending ? "scale-50 opacity-0" : "scale-100 opacity-100"
              }`}
            />
            <LoaderCircle
              className={`col-start-1 row-start-1 size-4 animate-spin text-accent transition-[opacity] duration-200 ${
                anySending ? "opacity-100" : "opacity-0"
              }`}
            />
          </span>
          {stripEntries.length > 1 && (
            <span className="absolute -bottom-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full border border-border bg-bg-raised px-0.5 text-[9px] font-semibold leading-4 text-fg-muted">
              {stripEntries.length}
            </span>
          )}
          <span
            className={`absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
              anyUnread && !anySending
                ? "scale-100 opacity-100"
                : "scale-0 opacity-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
