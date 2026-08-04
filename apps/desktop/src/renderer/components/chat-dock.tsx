import { useAgentChat } from "@catamorphic/react";
import {
  ArrowUp,
  Bot,
  Maximize2,
  Minus,
  PictureInPicture2,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { AgentQuestionPanel } from "./agent-question-panel";
import {
  ChatTimeline,
  QUESTIONS_DISMISSED_MESSAGE,
  toTimeline,
} from "./catamorphic/chat-timeline";

export type ChatMode = "min" | "partial" | "tab";

/** Short, charismatic empty-state openers; one is picked per chat. */
const EMPTY_STATE_PHRASES = [
  "Ready when you are.",
  "Where are we headed?",
  "What are we building?",
  "Let's make something.",
  "Your move.",
  "What's on your mind?",
  "Big or small, bring it.",
  "Let's get into it.",
  "What's next?",
  "Say the word.",
  "Blank canvas. Go.",
  "What should exist?",
  "Start anywhere.",
  "I'm all ears.",
  "Let's build.",
] as const;

/** Stable per-chat pick: hash the id so re-renders don't re-roll. */
const emptyStateFor = (localId: string): string => {
  let hash = 0;
  for (let i = 0; i < localId.length; i += 1) {
    hash = (hash * 31 + localId.charCodeAt(i)) | 0;
  }
  return (
    EMPTY_STATE_PHRASES[Math.abs(hash) % EMPTY_STATE_PHRASES.length] ??
    EMPTY_STATE_PHRASES[0]
  );
};

export interface ChatDockEntry {
  localId: string;
  sessionId?: string;
  mode: ChatMode;
  /** Auto-sent as the first message on mount (palette "Send to agent"). */
  pendingMessage?: string;
  /**
   * Agent picked for this chat before its session exists (palette "Switch
   * agent" on a fresh chat). Once a session is live, the session row owns
   * the choice.
   */
  agentId?: string;
}

export interface ChatDockProps {
  projectId: string;
  entry: ChatDockEntry;
  title: string;
  placeholder?: string;
  /** Whether this chat's workspace tab is the active tab (tab mode only). */
  tabActive: boolean;
  /**
   * How the bubble UI occupies the bottom edge while this chat is a tab:
   * "strip" = expanded centered strip (reserve bottom height), "corner" =
   * single collapsed bubble at the right (side padding only), "none".
   */
  bubbleClearance: "none" | "corner" | "strip";
  /** Profile-default agent for lazily created sessions. */
  defaultAgentId?: string;
  /**
   * A highlighted palette command targets this chat — accent the floating
   * dock's border so the command visibly points at it before Enter.
   */
  paletteTargeted?: boolean;
  onEntryChange: (entry: ChatDockEntry) => void;
  /** Close the chat entirely (dismissing an empty chat removes it). */
  onClose: (localId: string) => void;
  onSessionCreated: (localId: string, sessionId: string) => void;
  /** The agent started/stopped working on this chat (drives indicators). */
  onSendingChange: (localId: string, sending: boolean) => void;
}

/**
 * One chat surface tied to one bottom bubble. Stays mounted while minimized
 * so queued sends and drafts survive; the panel morphs between a floating
 * partial dock and a full workspace tab (the bubble hides while tabbed).
 */
export function ChatDock({
  projectId,
  entry,
  title,
  placeholder = "Describe what you want to build…",
  tabActive,
  bubbleClearance,
  defaultAgentId,
  paletteTargeted,
  onEntryChange,
  onClose,
  onSessionCreated,
  onSendingChange,
}: ChatDockProps) {
  const chat = useAgentChat(projectId, {
    sessionId: entry.sessionId,
    agentId: entry.agentId ?? defaultAgentId,
    onSessionCreated: (sessionId) => onSessionCreated(entry.localId, sessionId),
  });
  const [draft, setDraft] = useState("");
  const { messages, activity, questions } = toTimeline(
    chat.messages,
    chat.optimisticMessages,
    chat.isSending,
  );

  // isWorking, not isSending: it also covers turns this client didn't start
  // (reloads) and can't stick forever — the server settles orphaned turns.
  // The unmount cleanup matters: closing a chat mid-turn must clear its
  // activity flag, or the aggregate bubble spins forever for a chat that
  // no longer exists.
  useEffect(() => {
    onSendingChange(entry.localId, chat.isWorking);
    return () => onSendingChange(entry.localId, false);
  }, [chat.isWorking, entry.localId, onSendingChange]);

  // Fresh values for the window Escape listener without re-subscribing.
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const onEntryChangeRef = useRef(onEntryChange);
  onEntryChangeRef.current = onEntryChange;

  // Palette "Send to agent": the entry arrives with the message attached;
  // fire it once on mount and strip it so remounts don't re-send.
  const sendRef = useRef(chat.send);
  sendRef.current = chat.send;
  const pendingSentRef = useRef(false);
  useEffect(() => {
    const pending = entryRef.current.pendingMessage;
    if (!pending || pendingSentRef.current) return;
    pendingSentRef.current = true;
    void sendRef.current(pending);
    onEntryChangeRef.current({
      ...entryRef.current,
      pendingMessage: undefined,
    });
  }, []);

  const isTab = entry.mode === "tab";
  // Closing an empty chat plays the same 250ms collapse as minimizing —
  // `closing` drops the expanded classes first, the unmount follows.
  const [closing, setClosing] = useState(false);
  const expanded =
    !closing && (entry.mode === "partial" || (isTab && tabActive));

  const setMode = (mode: ChatMode) => onEntryChange({ ...entry, mode });

  // An untouched chat has nothing worth keeping — dismissing it (Escape
  // or the minimize button) closes it instead of parking an empty bubble.
  // A typed-but-unsent draft counts as worth keeping.
  const isEmpty =
    messages.length === 0 &&
    !chat.isSending &&
    chat.queuedMessageCount === 0 &&
    draft.trim() === "";
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const animatedClose = () => {
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(entryRef.current.localId), 250);
  };
  const animatedCloseRef = useRef(animatedClose);
  animatedCloseRef.current = animatedClose;

  const dismiss = () => {
    if (isEmpty) animatedClose();
    else setMode("min");
  };

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

  // Expanding (bubble click, new chat) should land the user ready to type.
  // rAF waits out the `inert` removal — focus() is a no-op on inert subtrees.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  // Window-level so Escape works regardless of what has focus. Escape steps
  // the chat down one size: full tab → floating dock → bubble. At most one
  // chat is the active tab or floating at a time, so at most one listener;
  // open popovers get first dibs via defaultPrevented.
  const escapeTarget = entry.mode === "partial" || (isTab && tabActive);
  useEffect(() => {
    if (!escapeTarget) return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (entryRef.current.mode === "tab") {
        onEntryChangeRef.current({ ...entryRef.current, mode: "partial" });
      } else if (isEmptyRef.current) {
        // Escaping an untouched floating chat closes it — no empty bubble.
        animatedCloseRef.current();
      } else {
        onEntryChangeRef.current({ ...entryRef.current, mode: "min" });
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [escapeTarget]);

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-end transition-[padding] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
        isTab ? "p-0" : "px-6 pb-16 pt-3"
      }`}
    >
      <section
        data-palette-target={(paletteTargeted && !isTab) || undefined}
        className={`pointer-events-auto relative flex w-full origin-bottom flex-col overflow-hidden backdrop-blur-xl transition-[max-width,height,opacity,translate,scale,background-color,border-radius,border-color] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
          isTab
            ? "h-full max-w-full rounded-none border-0 border-transparent bg-bg"
            : `h-[min(560px,100%)] max-w-3xl rounded-2xl border bg-bg-raised/95 drop-shadow-2xl ${
                paletteTargeted ? "border-accent" : "border-border"
              }`
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
        {/* The tab already names the chat — in tab mode the header collapses
            and its controls float over the timeline's top-right corner. */}
        <header
          className={`flex shrink-0 items-center justify-between overflow-hidden border-b px-3 text-xs font-semibold transition-[height,border-color] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
            isTab ? "h-0 border-transparent" : "h-11 border-border"
          }`}
          aria-hidden={isTab}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border-strong bg-bg-overlay">
              <Bot className="size-3.5" />
            </span>
            <span className="truncate">{title}</span>
          </span>
        </header>
        <span className="absolute right-2 top-2 z-10 flex items-center gap-1">
          <button
            type="button"
            className="grid size-7 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
            onClick={() => setMode(isTab ? "partial" : "tab")}
            aria-label={isTab ? "Pop out to floating chat" : "Open as tab"}
            title={isTab ? "Pop out to floating chat" : "Open as tab"}
          >
            {isTab ? (
              <PictureInPicture2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            className="grid size-7 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
            onClick={dismiss}
            aria-label={isEmpty ? "Close chat" : "Minimize chat to bubble"}
            title={isEmpty ? "Close" : "Minimize to bubble"}
          >
            <Minus className="size-3.5" />
          </button>
        </span>
        {/* In tab mode the scroller spans the full tab (scrollbar at the
            edge) while the content column stays centered and readable. */}
        <div
          className={`flex min-h-0 w-full flex-1 flex-col ${
            isTab ? "" : "mx-auto max-w-3xl"
          }`}
        >
          <ChatTimeline
            className="min-h-0 flex-1"
            contentClassName={isTab ? "mx-auto w-full max-w-4xl" : ""}
            messages={messages}
            activity={activity}
            queuedCount={Math.max(0, chat.queuedMessageCount - 1)}
            error={chat.error?.message ?? null}
            emptyState={emptyStateFor(entry.localId)}
          />
          {/* Keep the composer clear of the bubble UI: bottom padding for
              the expanded strip, side padding for the corner bubble. */}
          <div
            className={`flex w-full flex-col transition-[padding] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
              isTab
                ? `mx-auto max-w-4xl ${
                    bubbleClearance === "strip"
                      ? "pb-[52px]"
                      : bubbleClearance === "corner"
                        ? "px-16"
                        : ""
                  }`
                : ""
            }`}
          >
            {questions && !chat.isSending && (
              <AgentQuestionPanel
                questions={questions}
                onSubmit={(answer) => void chat.send(answer)}
                onDismiss={() => void chat.send(QUESTIONS_DISMISSED_MESSAGE)}
                disabled={!expanded}
              />
            )}
            <form
              className="field m-3 mt-1 flex shrink-0 items-center gap-2 rounded-xl bg-bg-raised/95 p-1.5"
              onSubmit={submit}
            >
              <textarea
                ref={inputRef}
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
        </div>
      </section>
    </div>
  );
}
