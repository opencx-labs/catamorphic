import { type AgentChatAttachment, useAgentChat } from "@catamorphic/react";
import {
  ArrowUp,
  Bot,
  ChevronUp,
  Columns2,
  FileCode,
  FileText,
  Globe,
  LoaderCircle,
  Maximize2,
  Minus,
  PictureInPicture2,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { type AgentInfo, desktopApi } from "../lib/desktop-api";
import { AgentQuestionPanel } from "./agent-question-panel";
import {
  ChatTimeline,
  QUESTIONS_DISMISSED_MESSAGE,
  toTimeline,
} from "./catamorphic/chat-timeline";
import { ShortcutHint } from "./shortcut-hint";

export type ChatMode = "min" | "partial" | "tab";

/**
 * A workspace tab attached to this chat — the agent's working surfaces
 * (browser pages it linked, terminals for its project, files it changed).
 */
export interface ChatSurface {
  /** Workspace tab key ("browser:<id>" / "terminal:<id>" / "editor:<id>"). */
  key: string;
  kind: "browser" | "terminal" | "editor";
  label: string;
  faviconUrl?: string | null;
  /** The agent is actively working here (spinner on the chip). */
  active?: boolean;
}

/** Chips group per kind once a chat collects this many surfaces. */
const SURFACE_GROUP_THRESHOLD = 3;

const SURFACE_GROUP_LABELS = {
  browser: "pages",
  terminal: "terminals",
  editor: "files",
} as const;

const SURFACE_ICONS = {
  browser: Globe,
  terminal: SquareTerminal,
  editor: FileCode,
} as const;

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

/** Document types the composer accepts as pasted/attached files. */
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface ComposerAttachment extends AgentChatAttachment {
  id: string;
}

async function fileToAttachment(
  file: File,
): Promise<ComposerAttachment | null> {
  if (file.size === 0 || file.size > MAX_ATTACHMENT_BYTES) return null;
  const kind = file.type.startsWith("image/")
    ? ("image" as const)
    : DOCUMENT_TYPES.has(file.type)
      ? ("document" as const)
      : null;
  if (!kind) return null;
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    id: crypto.randomUUID(),
    kind,
    name: file.name || (kind === "image" ? "pasted-image.png" : "pasted-file"),
    mediaType: file.type,
    dataBase64: btoa(binary),
  };
}

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

/** One surface chip: open on click, tile right on ⌘-click or the button. */
function SurfaceChip({
  surface,
  onOpenSurface,
}: {
  surface: ChatSurface;
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
}) {
  const Icon = SURFACE_ICONS[surface.kind];
  return (
    <span
      className="group/chip flex shrink-0 items-center overflow-hidden rounded-md border border-border bg-bg-inset text-[11px] text-fg-muted"
      data-testid="surface-chip"
      data-active={surface.active || undefined}
    >
      <button
        type="button"
        onClick={(event) =>
          onOpenSurface(surface.key, event.metaKey ? "split" : "tab")
        }
        className="flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pl-2 pr-1.5 transition-colors duration-100 hover:text-fg"
      >
        <span className="relative grid size-3 shrink-0 place-items-center">
          {surface.kind === "browser" && surface.faviconUrl ? (
            <img
              src={surface.faviconUrl}
              alt=""
              className={`col-start-1 row-start-1 size-3 rounded-[2px] transition-opacity duration-200 ${
                surface.active ? "opacity-0" : "opacity-100"
              }`}
            />
          ) : (
            <Icon
              className={`col-start-1 row-start-1 size-3 transition-opacity duration-200 ${
                surface.active ? "opacity-0" : "opacity-100"
              }`}
            />
          )}
          <LoaderCircle
            className={`col-start-1 row-start-1 size-3 animate-spin text-accent transition-opacity duration-200 ${
              surface.active ? "opacity-100" : "opacity-0"
            }`}
          />
        </span>
        <span className="max-w-36 truncate">{surface.label}</span>
      </button>
      <ShortcutHint label="Open to the right" shortcut="⌘-click">
        <button
          type="button"
          onClick={() => onOpenSurface(surface.key, "split")}
          className="grid size-6 shrink-0 cursor-pointer place-items-center text-fg-faint opacity-60 transition-[color,opacity] duration-100 hover:text-fg group-hover/chip:opacity-100"
          aria-label={`Open ${surface.label} to the right`}
        >
          <Columns2 className="size-3" />
        </button>
      </ShortcutHint>
    </span>
  );
}

/**
 * The surfaces rail. Kinds with many surfaces collapse into one group
 * chip ("4 pages") whose popover expands upward; kinds with few show
 * individual chips. Active surfaces (agent working, command running)
 * carry a spinner that aggregates onto their group chip.
 */
function SurfacesRail({
  surfaces,
  onOpenSurface,
}: {
  surfaces: ChatSurface[];
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
}) {
  const [openGroup, setOpenGroup] = useState<ChatSurface["kind"] | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openGroup) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!railRef.current?.contains(event.target as Node)) {
        setOpenGroup(null);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenGroup(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openGroup]);

  const byKind = new Map<ChatSurface["kind"], ChatSurface[]>();
  for (const surface of surfaces) {
    byKind.set(surface.kind, [...(byKind.get(surface.kind) ?? []), surface]);
  }

  return (
    <div ref={railRef} className="relative mx-3">
      {openGroup && byKind.get(openGroup) && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-bg-raised/95 p-1 shadow-2xl backdrop-blur-xl">
          {(byKind.get(openGroup) ?? []).map((surface) => (
            <div
              key={surface.key}
              className="group/chip flex items-center rounded-md text-[12px] text-fg-muted transition-colors duration-100 hover:bg-bg-overlay"
            >
              <button
                type="button"
                onClick={(event) => {
                  onOpenSurface(surface.key, event.metaKey ? "split" : "tab");
                  setOpenGroup(null);
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:text-fg"
              >
                <span className="relative grid size-3.5 shrink-0 place-items-center">
                  {surface.kind === "browser" && surface.faviconUrl ? (
                    <img
                      src={surface.faviconUrl}
                      alt=""
                      className={`col-start-1 row-start-1 size-3.5 rounded-[2px] ${surface.active ? "opacity-0" : ""}`}
                    />
                  ) : (
                    (() => {
                      const Icon = SURFACE_ICONS[surface.kind];
                      return (
                        <Icon
                          className={`col-start-1 row-start-1 size-3.5 ${surface.active ? "opacity-0" : ""}`}
                        />
                      );
                    })()
                  )}
                  {surface.active && (
                    <LoaderCircle className="col-start-1 row-start-1 size-3.5 animate-spin text-accent" />
                  )}
                </span>
                <span className="truncate">{surface.label}</span>
              </button>
              <ShortcutHint label="Open to the right" shortcut="⌘-click">
                <button
                  type="button"
                  onClick={() => {
                    onOpenSurface(surface.key, "split");
                    setOpenGroup(null);
                  }}
                  className="mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint opacity-0 transition-opacity duration-100 hover:text-fg group-hover/chip:opacity-100"
                  aria-label={`Open ${surface.label} to the right`}
                >
                  <Columns2 className="size-3" />
                </button>
              </ShortcutHint>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
        {[...byKind.entries()].map(([kind, group]) =>
          group.length > SURFACE_GROUP_THRESHOLD ? (
            <button
              key={kind}
              type="button"
              onClick={() =>
                setOpenGroup((current) => (current === kind ? null : kind))
              }
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border py-1 pl-2 pr-1.5 text-[11px] transition-colors duration-100 ${
                openGroup === kind
                  ? "border-border-strong bg-bg-overlay text-fg"
                  : "border-border bg-bg-inset text-fg-muted hover:text-fg"
              }`}
              aria-expanded={openGroup === kind}
              aria-label={`${group.length} ${SURFACE_GROUP_LABELS[kind]}`}
            >
              <span className="relative grid size-3 shrink-0 place-items-center">
                {(() => {
                  const Icon = SURFACE_ICONS[kind];
                  const anyActive = group.some((surface) => surface.active);
                  return (
                    <>
                      <Icon
                        className={`col-start-1 row-start-1 size-3 transition-opacity duration-200 ${anyActive ? "opacity-0" : "opacity-100"}`}
                      />
                      <LoaderCircle
                        className={`col-start-1 row-start-1 size-3 animate-spin text-accent transition-opacity duration-200 ${anyActive ? "opacity-100" : "opacity-0"}`}
                      />
                    </>
                  );
                })()}
              </span>
              {group.length} {SURFACE_GROUP_LABELS[kind]}
              <ChevronUp
                className={`size-3 text-fg-faint transition-transform duration-150 ${
                  openGroup === kind ? "rotate-180" : ""
                }`}
              />
            </button>
          ) : (
            group.map((surface) => (
              <SurfaceChip
                key={surface.key}
                surface={surface}
                onOpenSurface={onOpenSurface}
              />
            ))
          ),
        )}
      </div>
    </div>
  );
}

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
  /**
   * The chat's attached tabs are folded under its tab in the strip
   * (host-managed; only meaningful while the chat is a tab).
   */
  surfacesCollapsed?: boolean;
}

export interface ChatDockProps {
  projectId: string;
  entry: ChatDockEntry;
  title: string;
  placeholder?: string;
  /** Whether this chat's workspace tab occupies a view slot (tab mode). */
  tabActive: boolean;
  /**
   * Where the tab sits in the content view: the full area, or one half
   * of a split. Floating/minimized modes ignore it.
   */
  slot?: "full" | "left" | "right";
  /** Left pane's width fraction while the view is split. */
  splitRatio?: number;
  /** True while the split divider is being dragged (disables tweens). */
  splitResizing?: boolean;
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
  /** Tabs attached to this chat, rendered as the surfaces rail. */
  surfaces?: ChatSurface[];
  /**
   * Open an attached surface: "tab" focuses it as a full tab, "split"
   * tiles it to the right of the current view.
   */
  onOpenSurface?: (key: string, mode: "tab" | "split") => void;
  /** Set while this tab is the unfocused pane of a split: click focuses. */
  onFocusRequest?: () => void;
  /** Set while this tab sits in a split: return it to a full-width tab. */
  onUnsplit?: () => void;
  /**
   * Agent-message link clicked — opens as an attached browser tab. The
   * modifiers follow the palette's grammar: plain opens (a fullscreen
   * chat steps down to the floating dock), ⌘ opens a new tab with the
   * chat untouched, ⌘⇧ tiles it to the side of the current view.
   */
  onLinkClick?: (
    url: string,
    modifiers: { metaKey: boolean; shiftKey: boolean },
  ) => void;
  /** Changed-file chip clicked — opens the file in an attached editor. */
  onFileClick?: (path: string) => void;
  onEntryChange: (entry: ChatDockEntry) => void;
  /** Close the chat entirely (dismissing an empty chat removes it). */
  onClose: (localId: string) => void;
  /**
   * Hands the host this dock's animated close, so external closers
   * (Cmd+W's close-surface) play the same 250ms collapse as Escape
   * instead of unmounting the dock mid-frame.
   */
  registerClose?: (close: () => void) => void;
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
  slot = "full",
  splitRatio = 0.5,
  splitResizing = false,
  bubbleClearance,
  defaultAgentId,
  paletteTargeted,
  surfaces = [],
  onOpenSurface,
  onFocusRequest,
  onUnsplit,
  onLinkClick,
  onFileClick,
  onEntryChange,
  onClose,
  registerClose,
  onSessionCreated,
  onSendingChange,
}: ChatDockProps) {
  const chat = useAgentChat(projectId, {
    sessionId: entry.sessionId,
    agentId: entry.agentId ?? defaultAgentId,
    onSessionCreated: (sessionId) => onSessionCreated(entry.localId, sessionId),
  });
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const { messages, activity, questions } = toTimeline(
    chat.messages,
    chat.optimisticMessages,
    chat.isSending,
  );

  // The agent roster drives composer capabilities (what media this agent
  // accepts), marker names, and the auth-error re-connect action.
  const [roster, setRoster] = useState<{
    agents: AgentInfo[];
    defaultAgentId: string | null;
  }>({ agents: [], defaultAgentId: null });
  // Refetched when the session's agent changes: a switch may involve an
  // agent created after this dock mounted (marker names, capabilities).
  const sessionAgentId = chat.session?.agentId;
  useEffect(() => {
    let cancelled = false;
    void desktopApi
      .agentsList()
      .then((data) => {
        if (!cancelled) setRoster(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionAgentId]);
  const activeAgent = roster.agents.find(
    (agent) =>
      agent.id ===
      (chat.session?.agentId ??
        entry.agentId ??
        defaultAgentId ??
        roster.defaultAgentId),
  );
  // Unknown roster (fetch pending/failed): stay permissive; the server
  // answers with a friendly error if the harness really can't take it.
  const accepts = activeAgent?.accepts ?? ["image", "document"];
  // Auth failures offer a one-click re-login only for account-auth agents
  // (OpenRouter PKCE, Claude Code / Codex logins); API-key agents are
  // pointed at Settings by the error text itself. A successful reconnect
  // retries the failed turn on its own — the user already said what they
  // wanted; fixing the credentials shouldn't cost them a re-send.
  const awaitingReauthRef = useRef<string | null>(null);
  const retryRef = useRef(chat.retry);
  retryRef.current = chat.retry;
  useEffect(
    () =>
      desktopApi.onAgentLoginFinished((result) => {
        if (result.agentId !== awaitingReauthRef.current) return;
        awaitingReauthRef.current = null;
        if (result.ok) void retryRef.current();
      }),
    [],
  );
  const reauth =
    activeAgent && activeAgent.auth === "account"
      ? {
          label:
            activeAgent.provider === "openrouter"
              ? "Reconnect OpenRouter"
              : `Re-login ${activeAgent.name}`,
          run: () => {
            awaitingReauthRef.current = activeAgent.id;
            void desktopApi.agentLogin(activeAgent.id).then((result) => {
              // Login never started (e.g. key-auth agent): stop waiting.
              if (!result.started) awaitingReauthRef.current = null;
            });
          },
        }
      : undefined;

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
    draft.trim() === "" &&
    attachments.length === 0;
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

  useEffect(() => {
    registerClose?.(() => animatedCloseRef.current());
  }, [registerClose]);

  const dismiss = () => {
    if (isEmpty) animatedClose();
    else setMode("min");
  };

  const takeComposer = (): {
    message: string;
    files: AgentChatAttachment[];
  } | null => {
    const message = draft.trim();
    const files = attachments.map(({ id: _id, ...attachment }) => attachment);
    if (!message && files.length === 0) return null;
    setDraft("");
    setAttachments([]);
    return { message, files };
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const composed = takeComposer();
    if (!composed) return;
    void chat.send(composed.message, composed.files);
  };

  /** ⌘↵: jump the queue — interrupt the running turn and send this now. */
  const submitNow = () => {
    const composed = takeComposer();
    if (!composed) return;
    void chat.sendNow(composed.message, composed.files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (event.metaKey) {
      event.preventDefault();
      submitNow();
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map(fileToAttachment)).then((converted) => {
      const usable = converted.filter(
        (attachment): attachment is ComposerAttachment =>
          attachment !== null && accepts.includes(attachment.kind),
      );
      if (usable.length > 0) {
        setAttachments((current) => [...current, ...usable]);
      }
    });
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

  // In a split, a tabbed chat occupies only its (ratio-sized) share of
  // the view; floating chats always overlay the full area.
  const splitPane = isTab && tabActive && slot !== "full";
  return (
    <div
      className={`pointer-events-none absolute z-30 flex flex-col items-center justify-end ${
        splitResizing
          ? "transition-[padding]"
          : "transition-[padding,left,right]"
      } duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
        splitPane && slot === "left"
          ? "inset-y-0 left-0 border-r border-border p-0"
          : splitPane && slot === "right"
            ? "inset-y-0 right-0 p-0"
            : isTab
              ? "inset-0 p-0"
              : "inset-0 px-6 pb-16 pt-3"
      }`}
      style={
        splitPane
          ? slot === "left"
            ? { right: `${(1 - splitRatio) * 100}%` }
            : { left: `${splitRatio * 100}%` }
          : undefined
      }
    >
      <section
        onMouseDownCapture={onFocusRequest}
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
        {/* A snug pill behind the controls so they never blend into (or
            hide) timeline content scrolled beneath them. */}
        <span className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-bg-raised/95 p-0.5 backdrop-blur-sm">
          {isTab && onUnsplit && (
            <ShortcutHint label="Full width">
              <button
                type="button"
                className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                onClick={onUnsplit}
                aria-label="Full width"
              >
                <Columns2 className="size-3.5" />
              </button>
            </ShortcutHint>
          )}
          <ShortcutHint
            label={isTab ? "Pop out to floating chat" : "Open as tab"}
          >
            <button
              type="button"
              className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              onClick={() => setMode(isTab ? "partial" : "tab")}
              aria-label={isTab ? "Pop out to floating chat" : "Open as tab"}
            >
              {isTab ? (
                <PictureInPicture2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
          </ShortcutHint>
          <ShortcutHint label={isEmpty ? "Close chat" : "Minimize to bubble"}>
            <button
              type="button"
              className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              onClick={dismiss}
              aria-label={isEmpty ? "Close chat" : "Minimize chat to bubble"}
            >
              <Minus className="size-3.5" />
            </button>
          </ShortcutHint>
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
            queue={chat.queue}
            onUpdateQueued={chat.updateQueued}
            onRemoveQueued={chat.removeQueued}
            onSendQueuedNow={chat.sendQueuedNow}
            onHoldQueued={chat.holdQueued}
            onRetry={() => void chat.retry()}
            onReauth={reauth?.run}
            reauthLabel={reauth?.label}
            resolveAgentName={(agentId) =>
              roster.agents.find((agent) => agent.id === agentId)?.name
            }
            error={chat.error?.message ?? null}
            emptyState={emptyStateFor(entry.localId)}
            onLinkClick={onLinkClick}
            onFileClick={onFileClick}
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
            {/* The surfaces rail: the agent's working tabs (linked pages,
                terminals, changed files) live with the chat. Click opens
                the tab; the split button (or Cmd+click) tiles it to the
                right of the current view. Only real surfaces earn a chip —
                the new-terminal affordance lives with the header controls. */}
            {surfaces.length > 0 && onOpenSurface && (
              <SurfacesRail surfaces={surfaces} onOpenSurface={onOpenSurface} />
            )}
            {questions && !chat.isSending && (
              <AgentQuestionPanel
                questions={questions}
                onSubmit={(answer) => void chat.send(answer)}
                onDismiss={() => void chat.send(QUESTIONS_DISMISSED_MESSAGE)}
                disabled={!expanded}
              />
            )}
            <form
              className="field m-3 mt-1 flex shrink-0 flex-col rounded-xl bg-bg-raised/95 p-1.5"
              onSubmit={submit}
            >
              {/* Pasted media waits as chips until the message sends. */}
              {attachments.length > 0 && (
                <div
                  className="flex flex-wrap gap-1.5 px-1.5 pb-1 pt-0.5"
                  data-testid="composer-attachments"
                >
                  {attachments.map((attachment) => (
                    <span
                      key={attachment.id}
                      className="group/att relative flex items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-bg-inset text-[11px] text-fg-muted"
                    >
                      {attachment.kind === "image" ? (
                        <img
                          src={`data:${attachment.mediaType};base64,${attachment.dataBase64}`}
                          alt={attachment.name}
                          className="size-10 object-cover"
                        />
                      ) : (
                        <span className="flex items-center gap-1.5 py-2 pl-2">
                          <FileText className="size-3.5" />
                          <span className="max-w-32 truncate">
                            {attachment.name}
                          </span>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((current) =>
                            current.filter(
                              (candidate) => candidate.id !== attachment.id,
                            ),
                          )
                        }
                        className="grid size-5 shrink-0 cursor-pointer place-items-center self-start text-fg-faint hover:text-fg"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <textarea
                  ref={inputRef}
                  className="field-sizing-content max-h-24 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-fg-faint"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={accepts.length > 0 ? onPaste : undefined}
                  placeholder={
                    accepts.length > 0
                      ? placeholder
                      : `${placeholder.replace(/…$/, "")} (text only)…`
                  }
                  rows={1}
                  aria-label="Message the assistant"
                />
                <ShortcutHint
                  label={chat.isWorking ? "Queue (⌘↵ sends now)" : "Send"}
                  shortcut="↵"
                >
                  <button
                    type="submit"
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity duration-150 disabled:opacity-35"
                    disabled={!draft.trim() && attachments.length === 0}
                    aria-label="Send message"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                </ShortcutHint>
              </div>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}
