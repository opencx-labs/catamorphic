import { LoaderCircle, MessageSquare, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatDockEntry } from "./chat-dock";

export interface ChatBubblesProps {
  entries: ChatDockEntry[];
  labels: Record<string, string>;
  sending: Record<string, boolean>;
  /** Response arrived while the chat was minimized; shown as a dot. */
  unread: Record<string, boolean>;
  activeLocalId?: string;
  onToggle: (localId: string) => void;
  onClose: (localId: string) => void;
  onNewChat: () => void;
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
 * if it is the expanded one, otherwise restores it to its last size.
 */
export function ChatBubbles({
  entries,
  labels,
  sending,
  unread,
  activeLocalId,
  onToggle,
  onClose,
  onNewChat,
}: ChatBubblesProps) {
  // Bubbles present on mount appear statically; bubbles added later pop in.
  // Once an id qualifies, the animation class sticks — removing it mid-run
  // (e.g. on a quick follow-up render) would cancel the CSS animation, and a
  // kept class never replays. Seen-tracking commits in an effect so the
  // idempotent render-time union survives StrictMode double-renders.
  const seenIdsRef = useRef(new Set<string>());
  const animatedIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(false);
  if (mountedRef.current) {
    for (const entry of entries) {
      if (!seenIdsRef.current.has(entry.localId)) {
        animatedIdsRef.current.add(entry.localId);
      }
    }
  }
  const freshIds = animatedIdsRef.current;
  useEffect(() => {
    mountedRef.current = true;
    for (const entry of entries) seenIdsRef.current.add(entry.localId);
  }, [entries]);

  // Derived-state-during-render keeps removed bubbles visible (in place) as
  // exiting snapshots; onAnimationEnd drops them for real.
  const [display, setDisplay] = useState<Display>({
    entries,
    exitingIds: [],
  });
  const liveIds = new Set(entries.map((entry) => entry.localId));
  const prevIds = new Set(display.entries.map((entry) => entry.localId));
  const needsSync =
    entries.some((entry) => {
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
            entries.find((candidate) => candidate.localId === entry.localId) ??
            entry,
        ),
        ...entries.filter((entry) => !prevIds.has(entry.localId)),
      ],
      exitingIds,
    });
  }
  const removeExited = (localId: string) =>
    setDisplay((current) => ({
      entries: current.entries.filter((entry) => entry.localId !== localId),
      exitingIds: current.exitingIds.filter((id) => id !== localId),
    }));

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center pb-3">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-bg-raised/95 p-1.5 shadow-2xl backdrop-blur-xl">
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
                className={`relative grid size-9 cursor-pointer place-items-center rounded-full border transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-95 ${
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
                    className={`col-start-1 row-start-1 size-4 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                      isSending ? "scale-50 opacity-0" : "scale-100 opacity-100"
                    }`}
                  />
                  <LoaderCircle
                    className={`col-start-1 row-start-1 size-4 animate-spin text-accent transition-[opacity] duration-200 ${
                      isSending ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </span>
                <span
                  className={`absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
                    isUnread && !isSending
                      ? "scale-100 opacity-100"
                      : "scale-0 opacity-0"
                  }`}
                />
              </button>
              {entries.length > 1 && !exiting && (
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
        <button
          type="button"
          onClick={onNewChat}
          className="grid size-9 cursor-pointer place-items-center rounded-full border border-dashed border-border text-fg-faint transition-colors duration-150 hover:border-border-strong hover:text-fg"
          aria-label="New chat"
          title="New chat"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}
