import { useAgentChat } from "@catamorphic/react";
import { ArrowUp, Bot, Maximize2, Minimize2, Minus } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChatTimeline, toTimeline } from "./catamorphic/chat-timeline";

export type ChatMode = "min" | "partial" | "full";

export interface ChatDockEntry {
  localId: string;
  sessionId?: string;
  mode: ChatMode;
  /** Mode to restore when the bubble un-minimizes the chat. */
  lastExpandedMode: "partial" | "full";
}

export interface ChatDockProps {
  projectId: string;
  entry: ChatDockEntry;
  title: string;
  placeholder?: string;
  onEntryChange: (entry: ChatDockEntry) => void;
  onSessionCreated: (localId: string, sessionId: string) => void;
  onSendingChange: (localId: string, sending: boolean) => void;
}

/**
 * One chat surface tied to one bottom bubble. Stays mounted while minimized
 * so queued sends and drafts survive; the panel morphs between a floating
 * partial dock and a near-fullscreen sheet.
 */
export function ChatDock({
  projectId,
  entry,
  title,
  placeholder = "Describe what you want to build…",
  onEntryChange,
  onSessionCreated,
  onSendingChange,
}: ChatDockProps) {
  const chat = useAgentChat(projectId, {
    sessionId: entry.sessionId,
    onSessionCreated: (sessionId) => onSessionCreated(entry.localId, sessionId),
  });
  const [draft, setDraft] = useState("");
  const { messages, activity } = toTimeline(
    chat.messages,
    chat.optimisticMessages,
    chat.isSending,
  );

  useEffect(() => {
    onSendingChange(entry.localId, chat.isSending);
  }, [chat.isSending, entry.localId, onSendingChange]);

  // Fresh values for the window Escape listener without re-subscribing.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const onEntryChangeRef = useRef(onEntryChange);
  onEntryChangeRef.current = onEntryChange;

  const expanded = entry.mode !== "min";
  const sizeMode = entry.mode === "min" ? entry.lastExpandedMode : entry.mode;
  const isFull = sizeMode === "full";

  const setMode = (mode: ChatMode) =>
    onEntryChange({
      ...entry,
      mode,
      lastExpandedMode: mode === "min" ? entry.lastExpandedMode : mode,
    });

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    void chat.send(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  // Window-level so Escape minimizes the expanded chat regardless of what
  // has focus. Only one chat is expanded at a time, so at most one dock
  // attaches this listener; open popovers get first dibs via defaultPrevented.
  useEffect(() => {
    if (!expanded) return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      onEntryChangeRef.current({
        ...entryRef.current,
        mode: "min",
      });
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [expanded]);

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-end px-6 pb-16 pt-3">
      <section
        className={`pointer-events-auto flex w-full origin-bottom flex-col overflow-hidden rounded-2xl border border-border backdrop-blur-xl transition-[max-width,height,opacity,transform,background-color] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          isFull
            ? "h-full max-w-full bg-bg/90"
            : "h-[min(560px,100%)] max-w-3xl bg-bg-raised/95 drop-shadow-2xl"
        } ${
          expanded
            ? "translate-y-0 scale-100 opacity-100 animate-dock-in"
            : "pointer-events-none translate-y-4 scale-[0.985] opacity-0"
        }`}
        aria-label={title}
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
      >
        <span className="sr-only" aria-live="polite">
          {activity ?? messages.at(-1)?.content}
        </span>
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3 text-xs font-semibold">
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border-strong bg-bg-overlay">
              <Bot className="size-3.5" />
            </span>
            <span className="truncate">{title}</span>
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="grid size-7 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              onClick={() => setMode(isFull ? "partial" : "full")}
              aria-label={isFull ? "Exit fullscreen" : "Fullscreen"}
              title={isFull ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFull ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              className="grid size-7 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              onClick={() => setMode("min")}
              aria-label="Minimize chat"
              title="Minimize"
            >
              <Minus className="size-3.5" />
            </button>
          </span>
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          <ChatTimeline
            className="min-h-0 flex-1"
            messages={messages}
            activity={activity}
            queuedCount={Math.max(0, chat.queuedMessageCount - 1)}
            error={chat.error?.message ?? null}
          />
          <form
            className="m-3 mt-1 flex shrink-0 items-center gap-2 rounded-xl border border-border bg-bg-raised/95 p-1.5"
            onSubmit={submit}
          >
            <textarea
              className="field-sizing-content max-h-24 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-fg-faint"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              rows={1}
              aria-label="Message the assistant"
            />
            <button
              type="submit"
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity duration-150 disabled:opacity-35"
              disabled={!draft.trim()}
              aria-label="Send message"
            >
              <ArrowUp className="size-4" />
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
