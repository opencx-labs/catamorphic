import { type AgentChatAttachment, useAgentChat } from "@catamorphic/react";
import {
  AppWindow,
  ArrowUp,
  Bot,
  ChevronUp,
  Columns2,
  FileCode,
  FileText,
  GitFork,
  Globe,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Minus,
  Paperclip,
  PictureInPicture2,
  Radio,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
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
import { ChatGlyph } from "./chat-icon";
import type { ChatSignals } from "./chat-signals";
import { ShortcutHint } from "./shortcut-hint";

export type ChatMode = "min" | "partial" | "tab";

/**
 * A workspace tab attached to this chat — the agent's working surfaces
 * (browser pages it linked, terminals for its project, files it changed) —
 * or a live activity the chat itself tracks (subagents at work, background
 * processes the agent started or left running).
 */
export interface ChatSurface {
  /** Workspace tab key ("browser:<id>" / "terminal:<id>" / "chat:<id>"). */
  key: string;
  kind:
    | "browser"
    | "terminal"
    | "editor"
    | "chat"
    | "subagent"
    | "watcher"
    | "app"
    | "mcpapp";
  label: string;
  faviconUrl?: string | null;
  /** The agent is actively working here (spinner on the chip). */
  active?: boolean;
  /**
   * Detail lines opened in an upward popover on click. Chips with `info`
   * aren't workspace tabs — the popover IS their surface (a subagent's
   * activity feed, a watcher's command).
   */
  info?: string[];
  /** MCP app chips: the view to open when clicked. */
  mcpApp?: McpAppRef;
}

/** An MCP Apps view reachable from a chat's tool call. */
export interface McpAppRef {
  toolKey: string;
  toolUseId: string;
  title: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

/** Chips group per kind once a chat collects this many surfaces. */
const SURFACE_GROUP_THRESHOLD = 3;

const SURFACE_GROUP_LABELS = {
  browser: "pages",
  terminal: "terminals",
  editor: "files",
  chat: "forks",
  subagent: "subagents",
  watcher: "watchers",
  app: "apps",
  mcpapp: "app views",
} as const;

const SURFACE_ICONS = {
  browser: Globe,
  terminal: SquareTerminal,
  editor: FileCode,
  chat: GitFork,
  subagent: Bot,
  watcher: Radio,
  app: LayoutGrid,
  mcpapp: AppWindow,
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

/**
 * Files from a DataTransfer, robust across sources: `files` covers
 * screenshots and copied images; the `items` fallback covers sources
 * that only populate the item list.
 */
function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length > 0) return files;
  return [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** Structural view of one persisted turn event (metadata.events entries). */
interface TurnEvent {
  type?: string;
  content?: string;
  status?: string;
  subagentId?: string;
  subagentType?: string;
  backgroundId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolUseId?: string;
  filePath?: string;
}

/** Project-app name from a file path under apps/<name>/, if any. */
const appNameFromPath = (filePath: string | undefined): string | undefined =>
  filePath?.match(/(?:^|\/)apps\/([a-z0-9][a-z0-9-]*)\//)?.[1];

const firstLine = (value: string | undefined): string =>
  (value ?? "").split("\n", 1)[0]?.trim() ?? "";

const activityLine = (event: TurnEvent): string => {
  if (event.type === "command") return `$ ${firstLine(event.content)}`;
  if (event.type === "file_edit") return `Edited ${event.filePath ?? "a file"}`;
  if (event.type === "tool_call") return `Used ${event.toolName ?? "a tool"}`;
  return firstLine(event.content);
};

/**
 * Chips derived from the chat's own turn events (not workspace tabs):
 * subagents from the latest turn that delegated work — spinning while the
 * turn runs, inspectable after — and background watchers (processes the
 * agent started in the background or demonstrably left running), which
 * persist across turns until an event ends them.
 */
function activityChips(
  messages: Array<{ role: string; metadata?: unknown }>,
  working: boolean,
  uiTools: Record<string, string>,
): ChatSurface[] {
  let lastSubagentEvents: TurnEvent[] | undefined;
  const watchers = new Map<string, { label: string; ended: boolean }>();
  // Apps the agent worked on (file edits under apps/<name>/); active while
  // the CURRENT turn touches them.
  const apps = new Map<string, { active: boolean }>();
  // Tool calls whose tool declares an MCP Apps view; later events with the
  // same toolUseId merge in the result.
  const mcpApps = new Map<string, McpAppRef>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const metadata = message.metadata as {
      events?: TurnEvent[];
      status?: string;
    } | null;
    const events = metadata?.events;
    if (!Array.isArray(events)) continue;
    const inProgress = metadata?.status === "in_progress";
    if (events.some((event) => event.type === "subagent")) {
      lastSubagentEvents = events;
    }
    for (const event of events) {
      if (event.type === "file_edit") {
        const appName = appNameFromPath(event.filePath);
        if (appName) apps.set(appName, { active: inProgress && working });
        continue;
      }
      if (
        event.type === "tool_call" &&
        event.toolUseId &&
        event.toolName &&
        uiTools[event.toolName] !== undefined
      ) {
        const existing = mcpApps.get(event.toolUseId);
        mcpApps.set(event.toolUseId, {
          toolKey: event.toolName,
          toolUseId: event.toolUseId,
          title: event.toolName.split("/").pop() ?? event.toolName,
          toolInput: event.toolInput ?? existing?.toolInput,
          toolResult:
            event.toolResult !== undefined
              ? event.toolResult
              : existing?.toolResult,
        });
        continue;
      }
      if (event.type !== "background" || !event.backgroundId) continue;
      if (event.status === "ended") {
        const watcher = watchers.get(event.backgroundId);
        if (watcher) watcher.ended = true;
      } else {
        watchers.set(event.backgroundId, {
          label: firstLine(event.content) || "background process",
          ended: false,
        });
      }
    }
  }

  const chips: ChatSurface[] = [];
  if (lastSubagentEvents) {
    const subagents = new Map<
      string,
      { label: string; ended: boolean; info: string[] }
    >();
    for (const event of lastSubagentEvents) {
      if (!event.subagentId) continue;
      if (event.type === "subagent") {
        const entry = subagents.get(event.subagentId) ?? {
          label: "subagent",
          ended: false,
          info: [],
        };
        if (event.status === "ended") entry.ended = true;
        else {
          entry.label =
            firstLine(event.content) || event.subagentType || "subagent";
        }
        subagents.set(event.subagentId, entry);
      } else {
        const line = activityLine(event);
        if (line) subagents.get(event.subagentId)?.info.push(line);
      }
    }
    for (const [id, entry] of subagents) {
      chips.push({
        key: `subagent:${id}`,
        kind: "subagent",
        label: entry.label,
        active: !entry.ended && working,
        info:
          entry.info.length > 0
            ? entry.info.slice(-20)
            : ["No visible activity yet."],
      });
    }
  }
  for (const [id, watcher] of watchers) {
    if (watcher.ended) continue;
    chips.push({
      key: `watcher:${id}`,
      kind: "watcher",
      label: watcher.label,
      info: [
        watcher.label,
        "Running in the background — read the terminals, or ask the agent to stop it.",
      ],
    });
  }
  for (const [name, app] of apps) {
    chips.push({
      key: `app:${name}`,
      kind: "app",
      label: name,
      active: app.active,
    });
  }
  // Newest app views first; older ones age off the rail.
  for (const ref of [...mcpApps.values()].slice(-4)) {
    chips.push({
      key: `mcpapp:${ref.toolUseId}`,
      kind: "mcpapp",
      label: ref.title,
      mcpApp: ref,
    });
  }
  return chips;
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

/**
 * One surface chip: open on click, tile right on ⌘-click or the button.
 * Chips carrying `info` (subagents, watchers) open their detail popover
 * instead — they have no workspace tab behind them.
 */
function SurfaceChip({
  surface,
  onOpenSurface,
  onOpenMcpApp,
  onToggleInfo,
}: {
  surface: ChatSurface;
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
  onOpenMcpApp?: (view: McpAppRef, mode: "tab" | "split") => void;
  onToggleInfo: (key: string) => void;
}) {
  const Icon = SURFACE_ICONS[surface.kind];
  return (
    <span
      className="group/chip flex shrink-0 items-center overflow-hidden rounded-md border border-border bg-bg-inset text-[11px] text-fg-muted"
      data-testid="surface-chip"
      data-kind={surface.kind}
      data-active={surface.active || undefined}
    >
      <button
        type="button"
        onClick={(event) =>
          surface.mcpApp
            ? onOpenMcpApp?.(surface.mcpApp, event.metaKey ? "split" : "tab")
            : surface.info
              ? onToggleInfo(surface.key)
              : onOpenSurface(surface.key, event.metaKey ? "split" : "tab")
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
      {!surface.info && (
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
      )}
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
  onOpenMcpApp,
}: {
  surfaces: ChatSurface[];
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
  onOpenMcpApp?: (view: McpAppRef, mode: "tab" | "split") => void;
}) {
  const [openGroup, setOpenGroup] = useState<ChatSurface["kind"] | null>(null);
  const [openInfoKey, setOpenInfoKey] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openGroup && !openInfoKey) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!railRef.current?.contains(event.target as Node)) {
        setOpenGroup(null);
        setOpenInfoKey(null);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenGroup(null);
        setOpenInfoKey(null);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openGroup, openInfoKey]);

  const byKind = new Map<ChatSurface["kind"], ChatSurface[]>();
  for (const surface of surfaces) {
    byKind.set(surface.kind, [...(byKind.get(surface.kind) ?? []), surface]);
  }

  const toggleInfo = (key: string) => {
    setOpenGroup(null);
    setOpenInfoKey((current) => (current === key ? null : key));
  };
  const openInfoSurface = openInfoKey
    ? surfaces.find((surface) => surface.key === openInfoKey)
    : undefined;

  return (
    <div ref={railRef} className="relative mx-3">
      {/* Detail popover for chips that ARE their surface (subagents,
          watchers): the chip's activity feed, expanded upward. */}
      {openInfoSurface?.info && (
        <div
          className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-bg-raised/95 p-2 shadow-2xl backdrop-blur-xl"
          data-testid="surface-info-popover"
        >
          <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-semibold text-fg">
            {(() => {
              const Icon = SURFACE_ICONS[openInfoSurface.kind];
              return openInfoSurface.active ? (
                <LoaderCircle className="size-3 animate-spin text-accent" />
              ) : (
                <Icon className="size-3" />
              );
            })()}
            <span className="truncate">{openInfoSurface.label}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            {openInfoSurface.info.map((line, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static activity lines
                key={index}
                className="truncate px-1 font-mono text-[11px] text-fg-muted"
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
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
                  if (surface.mcpApp) {
                    onOpenMcpApp?.(
                      surface.mcpApp,
                      event.metaKey ? "split" : "tab",
                    );
                    setOpenGroup(null);
                    return;
                  }
                  if (surface.info) {
                    toggleInfo(surface.key);
                    return;
                  }
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
              {!surface.info && (
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
              )}
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
                onOpenMcpApp={onOpenMcpApp}
                onToggleInfo={toggleInfo}
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
  /**
   * The chat this one was forked from, when the parent is (or was) open
   * in this workspace — puts the fork on the parent's surfaces rail.
   */
  parentLocalId?: string;
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
  /** Open an MCP Apps view (a connection tool's ui:// template) as a tab. */
  onOpenMcpApp?: (view: McpAppRef, mode: "tab" | "split") => void;
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
  /** Fork the conversation from this assistant message (hover action). */
  onFork?: (messageId: string) => void;
  /** Set on forked chats: reveal the parent conversation. */
  onOpenParent?: () => void;
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
  /**
   * The chat's live signals changed: the agent started/stopped working,
   * the composer gained/lost an unsent draft, or a question is waiting.
   * Drives every indicator surface (bubbles, tabs, notifications).
   */
  onSignalsChange: (
    localId: string,
    signals: Required<Pick<ChatSignals, "working" | "draft" | "awaitingInput">>,
  ) => void;
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
  onOpenMcpApp,
  onFocusRequest,
  onUnsplit,
  onLinkClick,
  onFileClick,
  onFork,
  onOpenParent,
  onEntryChange,
  onClose,
  registerClose,
  onSessionCreated,
  onSignalsChange,
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

  // Which connection tools carry an MCP Apps view — chips for those tool
  // calls open the embedded app.
  const [uiTools, setUiTools] = useState<Record<string, string>>({});
  useEffect(() => {
    void desktopApi
      .mcpAppsUiTools()
      .then(setUiTools)
      .catch(() => {});
  }, []);

  // Subagent, watcher, worked-on-app, and MCP-app-view chips come from
  // the chat's own turn events (every harness reports them through the
  // common event model); workspace-tab chips arrive via the surfaces
  // prop. One rail, all of them.
  const chatActivityChips = useMemo(
    () => activityChips(chat.messages, chat.isWorking, uiTools),
    [chat.messages, chat.isWorking, uiTools],
  );
  const railSurfaces = useMemo(
    () => [...surfaces, ...chatActivityChips],
    [surfaces, chatActivityChips],
  );

  // ↑/↓ in the composer recall previously sent messages, shell-history
  // style: ↑ from an empty (or recalled) draft steps back through what
  // you sent, ↓ steps forward and finally restores the stashed draft.
  // Typing anything exits recall mode.
  const sentHistory = messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.content !== QUESTIONS_DISMISSED_MESSAGE &&
        message.content.trim() !== "",
    )
    .map((message) => message.content);
  const [recall, setRecall] = useState<{ index: number; stash: string } | null>(
    null,
  );
  // One-shot recall animation, re-armed per step: drop the class for a
  // frame, then re-apply so the keyframe replays (same dance as the
  // pane-motion nudge in app.tsx).
  const [recallAnimating, setRecallAnimating] = useState(false);
  const flashRecall = () => {
    setRecallAnimating(false);
    requestAnimationFrame(() => setRecallAnimating(true));
  };
  const applyRecall = (index: number, stash: string) => {
    const content = sentHistory[index];
    if (content === undefined) return;
    setRecall({ index, stash });
    setDraft(content);
    flashRecall();
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const recallUp = (): boolean => {
    if (sentHistory.length === 0) return false;
    if (recall === null) {
      if (draft.trim() !== "") return false;
      applyRecall(sentHistory.length - 1, draft);
      return true;
    }
    if (recall.index === 0) return true; // at the oldest — swallow the key
    applyRecall(recall.index - 1, recall.stash);
    return true;
  };
  const recallDown = (): boolean => {
    if (recall === null) return false;
    if (recall.index >= sentHistory.length - 1) {
      setDraft(recall.stash);
      setRecall(null);
      flashRecall();
      return true;
    }
    applyRecall(recall.index + 1, recall.stash);
    return true;
  };

  // PageUp jumps the timeline to your previous message (same action as
  // the timeline's ↑ button); the timeline registers the scroll here.
  const jumpToPreviousRef = useRef<(() => void) | null>(null);

  // The agent roster drives composer capabilities (what media this agent
  // accepts), marker names, and the auth-error re-connect action.
  const [roster, setRoster] = useState<{
    agents: AgentInfo[];
    defaultAgentId: string | null;
  }>({ agents: [], defaultAgentId: null });
  // Refetched when the session's agent changes: a switch may involve an
  // agent created after this dock mounted (marker names, capabilities).
  const sessionAgentId = chat.session?.agentId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionAgentId is the refetch trigger, not a body dependency
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
  // Draft and awaiting-input ride along so every indicator surface shares
  // one signal set. Reported only when a value actually flips (the host
  // dedups too), and cleared on true unmount — closing a chat mid-turn
  // must clear its flags, or the aggregate bubble spins forever for a
  // chat that no longer exists. The unmount cleanup is a separate effect:
  // a combined effect's cleanup would fire on every dep change, flapping
  // working false→true and producing phantom "finished" notifications.
  const hasDraft = draft.trim().length > 0 || attachments.length > 0;
  const awaitingInput = Boolean(questions) && !chat.isWorking;
  useEffect(() => {
    onSignalsChange(entry.localId, {
      working: chat.isWorking,
      draft: hasDraft,
      awaitingInput,
    });
  }, [chat.isWorking, hasDraft, awaitingInput, entry.localId, onSignalsChange]);
  const onSignalsChangeRef = useRef(onSignalsChange);
  onSignalsChangeRef.current = onSignalsChange;
  useEffect(
    () => () =>
      onSignalsChangeRef.current(entry.localId, {
        working: false,
        draft: false,
        awaitingInput: false,
      }),
    [entry.localId],
  );

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
    setRecall(null);
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
    if (event.nativeEvent.isComposing) return;
    if (event.key === "PageUp") {
      event.preventDefault();
      jumpToPreviousRef.current?.();
      return;
    }
    if (
      event.key === "ArrowUp" &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      if (recallUp()) event.preventDefault();
      return;
    }
    if (
      event.key === "ArrowDown" &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      if (recallDown()) event.preventDefault();
      return;
    }
    if (event.key !== "Enter") return;
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

  /** Convert dropped/pasted files into composer chips (capability-gated). */
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
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

  const acceptsMediaRef = useRef(accepts.length > 0);
  acceptsMediaRef.current = accepts.length > 0;
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  // Paste is handled at the WINDOW while this chat is the front surface:
  // requiring the caret to be exactly in the textarea made "copy a
  // screenshot, click the chat, Cmd+V" silently do nothing. Text pastes
  // stay native — only pastes that carry files are intercepted.
  const frontSurface = entry.mode === "partial" || (isTab && tabActive);
  useEffect(() => {
    if (!frontSurface) return;
    const onWindowPaste = (event: globalThis.ClipboardEvent) => {
      if (!acceptsMediaRef.current || event.defaultPrevented) return;
      const files = filesFrom(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      addFilesRef.current(files);
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [frontSurface]);

  // Drag & drop onto the chat surface attaches too (with a drop cue) —
  // dragging an image in is the first thing many people try.
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);

  // Expanding (bubble click, new chat) should land the user ready to type.
  // rAF waits out the `inert` removal — focus() is a no-op on inert subtrees.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The composer's attach button opens this hidden picker.
  const fileInputRef = useRef<HTMLInputElement>(null);
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
        onDragEnter={(event) => {
          if (!acceptsMediaRef.current) return;
          if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
          event.preventDefault();
          dragDepthRef.current += 1;
          setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!dropActive) return;
          event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        }}
        onDrop={(event) => {
          if (!dropActive) return;
          event.preventDefault();
          dragDepthRef.current = 0;
          setDropActive(false);
          addFiles(filesFrom(event.dataTransfer));
        }}
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
        {/* Drop cue: an accent dashed veil while files hover the chat. */}
        {dropActive && (
          <div className="pointer-events-none absolute inset-2 z-20 grid animate-fade-in place-items-center rounded-xl border-2 border-dashed border-accent/60 bg-accent/5">
            <span className="rounded-full border border-border bg-bg-raised/95 px-3 py-1.5 text-xs text-fg">
              Drop to attach
            </span>
          </div>
        )}
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
              {chat.session?.icon ? (
                <ChatGlyph icon={chat.session.icon} className="size-3.5" />
              ) : (
                <Bot className="size-3.5" />
              )}
            </span>
            <span className="truncate">{title}</span>
          </span>
        </header>
        {/* A snug pill behind the controls so they never blend into (or
            hide) timeline content scrolled beneath them. */}
        <span className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-bg-raised/95 p-0.5 backdrop-blur-sm">
          {onOpenParent && (
            <ShortcutHint label="Go to the original chat">
              <button
                type="button"
                className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                onClick={onOpenParent}
                aria-label="Go to the original chat"
                data-testid="chat-open-parent"
              >
                <GitFork className="size-3.5" />
              </button>
            </ShortcutHint>
          )}
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
            onFork={entry.sessionId ? onFork : undefined}
            registerJumpToPreviousUserMessage={(jump) => {
              jumpToPreviousRef.current = jump;
            }}
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
            {railSurfaces.length > 0 && onOpenSurface && (
              <SurfacesRail
                surfaces={railSurfaces}
                onOpenSurface={onOpenSurface}
                onOpenMcpApp={onOpenMcpApp}
              />
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
                {accepts.length > 0 && (
                  <ShortcutHint label="Attach files">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                      aria-label="Attach files"
                    >
                      <Paperclip className="size-4" />
                    </button>
                  </ShortcutHint>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={[
                    ...(accepts.includes("image") ? ["image/*"] : []),
                    ...(accepts.includes("document")
                      ? [...DOCUMENT_TYPES]
                      : []),
                  ].join(",")}
                  className="hidden"
                  onChange={(event) => {
                    addFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <textarea
                  ref={inputRef}
                  onAnimationEnd={(event) => {
                    if (event.animationName === "input-recall") {
                      setRecallAnimating(false);
                    }
                  }}
                  className={`field-sizing-content max-h-24 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-fg-faint ${
                    recallAnimating ? "animate-input-recall" : ""
                  }`}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    // Typing exits history-recall mode.
                    setRecall(null);
                  }}
                  onKeyDown={onKeyDown}
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
