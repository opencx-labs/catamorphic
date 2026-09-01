import {
  type AgentChatAttachment,
  type AgentChatTextAttachment,
  messageWithAttachmentNames,
  useAgentChat,
  useEnvironments,
  useWatchers,
} from "@catamorphic/react";
import {
  AppWindow,
  ArrowUp,
  Bot,
  ChevronUp,
  Columns2,
  FileCode,
  Ghost,
  GitBranch,
  GitFork,
  Globe,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Minus,
  Paperclip,
  PictureInPicture2,
  Radio,
  Server,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { commandScore } from "../lib/command-score";
import {
  type AgentInfo,
  desktopApi,
  projectAgentAsInfo,
  type SessionCheckoutInfo,
} from "../lib/desktop-api";
import {
  readEditorSelection,
  selectionFromClipboard,
} from "../lib/editor-selection";
import { useListMotion } from "../lib/list-motion";
import {
  type SkillInfo,
  skillInvocation,
  useProjectSkills,
} from "../lib/skills";
import { TAB_DRAG_TYPE, type TabDragPayload } from "../lib/tab-drag";
import { classifyPastedText, selectionName, textPill } from "../lib/text-pills";
import { AgentQuestionPanel } from "./agent-question-panel";
import { AuthenticationRequiredCard } from "./authentication-required-card.js";
import {
  attachmentsFromMetadata,
  ChatTimeline,
  QUESTIONS_DISMISSED_MESSAGE,
  toTimeline,
} from "./catamorphic/chat-timeline";
import { TodoProgress } from "./catamorphic/todo-progress.js";
import { ChatGlyph } from "./chat-icon";
import type { ChatSignals } from "./chat-signals";
import {
  type ComposerAttachment,
  ComposerInput,
  type ComposerInputHandle,
} from "./composer-input";
import { ContextMeter } from "./context-meter.js";
import { EnvironmentConnections } from "./environment-connections.js";
import { Modal } from "./modal.js";
import { RemoteMessageConnectionGuard } from "./remote-message-connection-guard.js";
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
   * The agent opened this surface in the BACKGROUND (open_surface while
   * the user was on another tab): the chip carries an accent dot with
   * the waiting-state pulse (the question badge's sanctioned loop —
   * indeterminate until the user answers) until the user opens the
   * surface. Dismissal-by-interaction, like point_at's glow.
   */
  attention?: boolean;
  /**
   * Detail lines opened in an upward popover on click. Chips with `info`
   * aren't workspace tabs — the popover IS their surface (a subagent's
   * activity feed, a watcher's command).
   */
  info?: string[];
  /** MCP app chips: the view to open when clicked. */
  mcpApp?: McpAppRef;
  /** The chip owns a workspace resource that can be explicitly disposed. */
  removable?: boolean;
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

/** Stable, complementary empty-state and composer copy for each chat. */
const EMPTY_CHAT_PROMPTS = [
  { empty: "Ready when you are.", composer: "Give me the first move…" },
  { empty: "Where are we headed?", composer: "Name the destination…" },
  { empty: "What are we building?", composer: "Describe the first piece…" },
  { empty: "Let's make something.", composer: "Sketch the idea…" },
  { empty: "Your move.", composer: "Tell me where to start…" },
  { empty: "What's on your mind?", composer: "Drop it here…" },
  { empty: "Big or small, bring it.", composer: "Name the thing to tackle…" },
  { empty: "Let's get into it.", composer: "Point me at the problem…" },
  { empty: "What's next?", composer: "Set the next move…" },
  { empty: "Say the word.", composer: "Give me the word…" },
  { empty: "Blank canvas. Go.", composer: "Draw the first line…" },
  { empty: "What should exist?", composer: "Describe what you want…" },
  { empty: "Start anywhere.", composer: "Give me one thread…" },
  { empty: "I'm all ears.", composer: "Talk me through it…" },
  { empty: "Let's build.", composer: "What comes first?…" },
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

/**
 * Total decoded media budget per message: keeps the request body far below
 * the server's limit. Files past it still attach — as path pills.
 */
const MAX_TOTAL_MEDIA_BYTES = 48 * 1024 * 1024;

/** Server-side attachment cap, mirrored so the composer can refuse early. */
const MAX_ATTACHMENTS = 32;

/** A "/" menu row: a project/host skill, or the harness's own command. */
type SlashEntry = {
  name: string;
  description: string;
} & (
  | { kind: "skill"; skill: SkillInfo }
  | {
      kind: "command";
      command: { name: string; description: string; argumentHint: string };
    }
);

/** A workspace tab dropped on the chat becomes a tab pill. */
function tabPillFromDrag(
  data: DataTransfer | null,
): AgentChatTextAttachment | null {
  const raw = data?.getData(TAB_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<
      Record<keyof TabDragPayload, unknown>
    >;
    if (typeof parsed.key !== "string" || typeof parsed.kind !== "string") {
      return null;
    }
    const title =
      typeof parsed.title === "string" && parsed.title
        ? parsed.title
        : parsed.kind;
    const detail =
      typeof parsed.detail === "string" ? parsed.detail : undefined;
    const source: AgentChatTextAttachment["source"] = {
      type: "tab",
      key: parsed.key,
      kind: parsed.kind,
      title,
      ...(parsed.kind === "browser" && detail ? { url: detail } : {}),
      ...(parsed.kind === "editor" && detail ? { filePath: detail } : {}),
    };
    // What the model reads without a tool call: title + address/path.
    const text = detail ? `${title} — ${detail}` : title;
    return textPill(text, source, title);
  } catch {
    return null;
  }
}

/** Whether a drag carries something the composer can attach. */
function isComposerTransfer(data: DataTransfer | null): boolean {
  const types = [...(data?.types ?? [])];
  return types.includes("Files") || types.includes(TAB_DRAG_TYPE);
}

/** The media kind a file would ship as, or null for unsupported types. */
function mediaKindOf(file: File): "image" | "document" | null {
  return file.type.startsWith("image/")
    ? "image"
    : DOCUMENT_TYPES.has(file.type)
      ? "document"
      : null;
}

async function encodeFile(
  file: File,
  kind: "image" | "document",
): Promise<ComposerAttachment> {
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

/** A file that can't ship as media still reaches the agent as a path. */
function pathPillFor(file: File): ComposerAttachment | null {
  // e2e seam: synthetic Files have no OS path, so tests inject one.
  const lookup =
    (window as { __e2ePathForFile?: (file: File) => string })
      .__e2ePathForFile ?? desktopApi.pathForFile;
  const path = lookup(file);
  if (!path) return null;
  const name = file.name || path.split(/[\\/]/).at(-1) || path;
  return {
    id: crypto.randomUUID(),
    ...textPill(path, { type: "path", path }, name),
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
const emptyChatPromptFor = (localId: string) => {
  let hash = 0;
  for (let i = 0; i < localId.length; i += 1) {
    hash = (hash * 31 + localId.charCodeAt(i)) | 0;
  }
  return (
    EMPTY_CHAT_PROMPTS[Math.abs(hash) % EMPTY_CHAT_PROMPTS.length] ??
    EMPTY_CHAT_PROMPTS[0]
  );
};

/**
 * One surface chip: open on click, tile right on ⌘-click or the button.
 * Chips carrying `info` (subagents, watchers) open their detail popover
 * instead — they have no workspace tab behind them.
 */
/**
 * An anchored popover that enters with pop-in and leaves with pop-out:
 * stays mounted through the exit and unmounts on animationend. `open`
 * drives the direction. The panel owns the exit snapshot — children
 * freeze at the last open render, so callers pass live content (null
 * while closed is fine) and never hand-roll snapshot refs.
 */
function PopPanel({
  open,
  className,
  testId,
  children,
}: {
  open: boolean;
  className: string;
  testId?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const frozenRef = useRef<ReactNode>(children);
  if (open) frozenRef.current = children;
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  if (!mounted) return null;
  return (
    <div
      data-testid={testId}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) setMounted(false);
      }}
      className={`${className} ${open ? "animate-pop-in" : "animate-pop-out"}`}
    >
      {open ? children : frozenRef.current}
    </div>
  );
}

/**
 * The composer's "/" menu: project + host skills and the harness's own
 * slash commands in one list. Pops in/out with the panel vocabulary;
 * rows FLIP/fade as the filter narrows (the palette's list motion).
 * Content snapshots through the exit so the panel never blanks mid-pop.
 */
function SlashMenu({
  open,
  matches,
  selected,
  onHover,
  onCommit,
}: {
  open: boolean;
  matches: SlashEntry[];
  selected: number;
  onHover: (index: number) => void;
  onCommit: (entry: SlashEntry) => void;
}) {
  const sizerRef = useRef<HTMLDivElement>(null);
  const { reset } = useListMotion(
    sizerRef,
    matches.map((entry) => entry.name).join("\u0000"),
    { keepTransitions: "background-color, color" },
  );
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);
  // PopPanel freezes the last open render through the exit, so an
  // emptied match list closes with the previous rows still visible.
  return (
    <PopPanel
      open={open && matches.length > 0}
      className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-bg-raised/95 p-1.5 shadow-2xl backdrop-blur-xl"
      testId="slash-menu"
    >
      <div ref={sizerRef} role="listbox" aria-label="Commands">
        {matches.map((entry, index) => (
          <div
            key={entry.name}
            data-item-id={entry.name}
            role="option"
            tabIndex={-1}
            aria-selected={index === selected}
            data-skill-name={entry.name}
            onMouseDown={(event) => {
              event.preventDefault();
              onCommit(entry);
            }}
            onMouseEnter={() => onHover(index)}
            className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm ${
              index === selected ? "bg-bg-overlay text-fg" : "text-fg-muted"
            }`}
          >
            <span className="shrink-0 font-medium">
              {entry.kind === "skill" ? entry.skill.title : `/${entry.name}`}
            </span>
            {entry.kind === "skill" ? (
              <span className="shrink-0 font-mono text-[11px] text-fg-faint">
                /{entry.name}
              </span>
            ) : (
              entry.command.argumentHint && (
                <span className="shrink-0 font-mono text-[11px] text-fg-faint">
                  {entry.command.argumentHint}
                </span>
              )
            )}
            {entry.description && (
              <span className="min-w-0 truncate text-xs text-fg-faint">
                {entry.description}
              </span>
            )}
            {entry.kind === "skill" && entry.skill.source === "host" && (
              <span className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] text-fg-faint">
                App
              </span>
            )}
            {entry.kind === "command" && (
              <span className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] text-fg-faint">
                Claude Code
              </span>
            )}
          </div>
        ))}
      </div>
    </PopPanel>
  );
}

function SurfaceChip({
  surface,
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
  onToggleInfo,
}: {
  surface: ChatSurface;
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
  onRemoveSurface?: (key: string) => void;
  onOpenMcpApp?: (view: McpAppRef, mode: "tab" | "split") => void;
  onToggleInfo: (key: string) => void;
}) {
  const Icon = SURFACE_ICONS[surface.kind];
  return (
    <span
      className="group/chip relative flex shrink-0 items-center overflow-hidden rounded-md border border-border bg-bg-inset text-[11px] text-fg-muted"
      data-testid="surface-chip"
      data-kind={surface.kind}
      data-active={surface.active || undefined}
      data-attention={surface.attention || undefined}
      // Chips are point_at-addressable ("chip:<surface key>") — the
      // agent can glow one on its own chat.
      data-point-key={`chip:${surface.key}`}
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
        className="flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pl-2 pr-2 transition-colors duration-100 hover:text-fg"
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
          {/* Background-opened surface waiting for the user: the unread
              dot (accent fill) with the waiting-state pulse, cleared by
              opening the chip. */}
          {surface.attention && (
            <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
          )}
        </span>
        <span className="max-w-36 truncate">{surface.label}</span>
      </button>
      {/* The split affordance only exists under the pointer: an overlay
          on the chip's right end that fades over the label's tail (its
          left edge is a gradient into the chip background) instead of
          permanently reserving width on every chip. */}
      {!surface.info && (
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-bg-inset from-70% to-transparent pl-3 pr-0.5 opacity-0 transition-opacity duration-100 group-hover/chip:pointer-events-auto group-hover/chip:opacity-100">
          <ShortcutHint label="Open to the right" shortcut="⌘-click">
            <button
              type="button"
              onClick={() => onOpenSurface(surface.key, "split")}
              className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-100 hover:text-fg"
              aria-label={`Open ${surface.label} to the right`}
            >
              <Columns2 className="size-3" />
            </button>
          </ShortcutHint>
          {surface.removable && onRemoveSurface && (
            <ShortcutHint label="Remove from this chat">
              <button
                type="button"
                onClick={() => onRemoveSurface(surface.key)}
                className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-100 hover:text-fg"
                aria-label={`Remove ${surface.label}`}
              >
                <X className="size-3" />
              </button>
            </ShortcutHint>
          )}
        </span>
      )}
    </span>
  );
}

/** The collapsed "4 terminals" chip a crowded kind folds into. */
function GroupChip({
  kind,
  group,
  open,
  onToggle,
}: {
  kind: ChatSurface["kind"];
  group: ChatSurface[];
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = SURFACE_ICONS[kind];
  const anyActive = group.some((surface) => surface.active);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border py-1 pl-2 pr-1.5 text-[11px] transition-colors duration-100 ${
        open
          ? "border-border-strong bg-bg-overlay text-fg"
          : "border-border bg-bg-inset text-fg-muted hover:text-fg"
      }`}
      aria-expanded={open}
      aria-label={`${group.length} ${SURFACE_GROUP_LABELS[kind]}`}
      data-attention={group.some((surface) => surface.attention) || undefined}
    >
      <span className="relative grid size-3 shrink-0 place-items-center">
        <Icon
          className={`col-start-1 row-start-1 size-3 transition-opacity duration-200 ${anyActive ? "opacity-0" : "opacity-100"}`}
        />
        <LoaderCircle
          className={`col-start-1 row-start-1 size-3 animate-spin text-accent transition-opacity duration-200 ${anyActive ? "opacity-100" : "opacity-0"}`}
        />
        {/* Attention aggregates onto the group chip, like the spinner. */}
        {group.some((surface) => surface.attention) && (
          <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
        )}
      </span>
      {group.length} {SURFACE_GROUP_LABELS[kind]}
      <ChevronUp
        className={`size-3 text-fg-faint transition-transform duration-150 ${
          open ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

/** What one kind renders on the rail: chips, or the collapsed group. */
type RailItem =
  | { id: string; type: "chip"; surface: ChatSurface }
  | { id: string; type: "group"; group: ChatSurface[] };

/**
 * One kind's strip on the rail, with motion: chips (or the group chip
 * they fold into past the threshold) enter with pill-in and leave with
 * pill-out — the collapse reads as chips folding into the group, not a
 * teleport. Removed items linger until their exit animation lands.
 */
function KindStrip({
  kind,
  group,
  animateEnter,
  openGroup,
  onToggleGroup,
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
  onToggleInfo,
}: {
  kind: ChatSurface["kind"];
  group: ChatSurface[];
  /** False on the rail's first paint — pre-existing chips don't animate. */
  animateEnter: boolean;
  openGroup: ChatSurface["kind"] | null;
  onToggleGroup: (kind: ChatSurface["kind"]) => void;
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
  onRemoveSurface?: (key: string) => void;
  onOpenMcpApp?: (view: McpAppRef, mode: "tab" | "split") => void;
  onToggleInfo: (key: string) => void;
}) {
  const collapsed = group.length > SURFACE_GROUP_THRESHOLD;
  const live: RailItem[] = collapsed
    ? [{ id: `group:${kind}`, type: "group", group }]
    : group.map((surface) => ({
        id: `chip:${surface.key}`,
        type: "chip",
        surface,
      }));
  const liveIdsKey = live.map((item) => item.id).join("\u0000");
  const [exiting, setExiting] = useState<RailItem[]>([]);
  const prevIdsRef = useRef<Set<string> | null>(null);
  const prevItemsRef = useRef<RailItem[]>([]);
  // Entered ids keep their pill-in class for the element's lifetime —
  // the animation runs once on insertion, and a mid-flight re-render
  // must not strip the class and snap the tween.
  const enteredRef = useRef(new Set<string>());
  for (const item of live) {
    const prev = prevIdsRef.current;
    if (prev === null) {
      if (animateEnter) enteredRef.current.add(item.id);
    } else if (!prev.has(item.id)) {
      enteredRef.current.add(item.id);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffing is keyed on the id list; item objects are re-derived each render
  useEffect(() => {
    const previous = prevItemsRef.current;
    const liveIds = new Set(live.map((item) => item.id));
    prevIdsRef.current = liveIds;
    prevItemsRef.current = live;
    for (const id of enteredRef.current) {
      if (!liveIds.has(id)) enteredRef.current.delete(id);
    }
    const removed = previous.filter((item) => !liveIds.has(item.id));
    setExiting((current) => {
      const kept = current.filter(
        (item) =>
          !liveIds.has(item.id) && !removed.some((gone) => gone.id === item.id),
      );
      const next = [...kept, ...removed];
      return next.length === current.length &&
        next.every((item, index) => item === current[index])
        ? current
        : next;
    });
  }, [liveIdsKey]);

  const renderItem = (item: RailItem, exitingItem: boolean) => (
    <span
      key={item.id}
      className={`flex shrink-0 items-center overflow-hidden ${
        exitingItem
          ? "animate-pill-out"
          : enteredRef.current.has(item.id)
            ? "animate-pill-in"
            : ""
      }`}
      onAnimationEnd={
        exitingItem
          ? (event) => {
              if (event.animationName === "pill-out") {
                setExiting((current) =>
                  current.filter((gone) => gone.id !== item.id),
                );
              }
            }
          : undefined
      }
    >
      {item.type === "group" ? (
        <GroupChip
          kind={kind}
          group={item.group}
          open={openGroup === kind}
          onToggle={() => onToggleGroup(kind)}
        />
      ) : (
        <SurfaceChip
          surface={item.surface}
          onOpenSurface={onOpenSurface}
          onRemoveSurface={onRemoveSurface}
          onOpenMcpApp={onOpenMcpApp}
          onToggleInfo={onToggleInfo}
        />
      )}
    </span>
  );

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {exiting.map((item) => renderItem(item, true))}
      {live.map((item) => renderItem(item, false))}
    </span>
  );
}

/**
 * The surfaces rail. Kinds with many surfaces collapse into one group
 * chip ("4 pages") whose popover expands upward; kinds with few show
 * individual chips. Active surfaces (agent working, command running)
 * carry a spinner that aggregates onto their group chip. Collapse and
 * expansion animate through KindStrip; the popovers pop in and out.
 */
function SurfacesRail({
  surfaces,
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
}: {
  surfaces: ChatSurface[];
  onOpenSurface: (key: string, mode: "tab" | "split") => void;
  onRemoveSurface?: (key: string) => void;
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
  // PopPanel freezes the last open render through the exit animation,
  // so live (possibly null) content is passed straight in.
  const infoSurface = openInfoSurface?.info ? openInfoSurface : null;
  const groupSurfaces = openGroup ? byKind.get(openGroup) : undefined;
  const firstPaintRef = useRef(true);
  useEffect(() => {
    firstPaintRef.current = false;
  }, []);

  return (
    <div ref={railRef} className="relative mx-3">
      {/* Detail popover for chips that ARE their surface (subagents,
          watchers): the chip's activity feed, expanded upward. */}
      <PopPanel
        open={Boolean(infoSurface)}
        className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-bg-raised/95 p-2 shadow-2xl backdrop-blur-xl"
        testId="surface-info-popover"
      >
        {infoSurface && (
          <>
            <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[11px] font-semibold text-fg">
              {(() => {
                const Icon = SURFACE_ICONS[infoSurface.kind];
                return infoSurface.active ? (
                  <LoaderCircle className="size-3 animate-spin text-accent" />
                ) : (
                  <Icon className="size-3" />
                );
              })()}
              <span className="truncate">{infoSurface.label}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {infoSurface.info?.map((line, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static activity lines
                  key={index}
                  className="truncate px-1 font-mono text-[11px] text-fg-muted"
                >
                  {line}
                </div>
              ))}
            </div>
          </>
        )}
      </PopPanel>
      <PopPanel
        open={Boolean(groupSurfaces)}
        className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-bg-raised/95 p-1 shadow-2xl backdrop-blur-xl"
      >
        {groupSurfaces?.map((surface) => (
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
                {surface.attention && (
                  <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-accent" />
                )}
              </span>
              <span className="truncate">{surface.label}</span>
            </button>
            {!surface.info && (
              <span className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity duration-100 group-hover/chip:opacity-100">
                <ShortcutHint label="Open to the right" shortcut="⌘-click">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSurface(surface.key, "split");
                      setOpenGroup(null);
                    }}
                    className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                    aria-label={`Open ${surface.label} to the right`}
                  >
                    <Columns2 className="size-3" />
                  </button>
                </ShortcutHint>
                {surface.removable && onRemoveSurface && (
                  <ShortcutHint label="Remove from this chat">
                    <button
                      type="button"
                      onClick={() => {
                        onRemoveSurface(surface.key);
                        setOpenGroup(null);
                      }}
                      className="grid size-6 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                      aria-label={`Remove ${surface.label}`}
                    >
                      <X className="size-3" />
                    </button>
                  </ShortcutHint>
                )}
              </span>
            )}
          </div>
        ))}
      </PopPanel>
      <div className="flex items-center gap-1.5 overflow-x-auto pt-1">
        {[...byKind.entries()].map(([kind, group]) => (
          <KindStrip
            key={kind}
            kind={kind}
            group={group}
            animateEnter={!firstPaintRef.current}
            openGroup={openGroup}
            onToggleGroup={(toggled) =>
              setOpenGroup((current) => (current === toggled ? null : toggled))
            }
            onOpenSurface={onOpenSurface}
            onRemoveSurface={onRemoveSurface}
            onOpenMcpApp={onOpenMcpApp}
            onToggleInfo={toggleInfo}
          />
        ))}
      </div>
    </div>
  );
}

export interface ChatDockEntry {
  localId: string;
  sessionId?: string;
  mode: ChatMode;
  /** Local-only session (ADR 0062): never mirrored to a linked remote. */
  incognito?: boolean;
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
  /** Keep this visible chat fresh when another client writes while it is idle. */
  refreshWhileIdle?: boolean;
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
  /**
   * A tab is visible behind the floating dock. While the agent works,
   * the dock lurks: it shrinks vertically to a strip showing the latest
   * activity so the tab stays readable, and expands on hover/focus.
   */
  backdropTab?: boolean;
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
  /** Permanently dispose an attached surface from its chip. */
  onRemoveSurface?: (key: string) => void;
  /** Open an MCP Apps view (a connection tool's ui:// template) as a tab. */
  onOpenMcpApp?: (view: McpAppRef, mode: "tab" | "split") => void;
  /** Set while this tab is the unfocused pane of a split: click focuses. */
  onFocusRequest?: () => void;
  /**
   * Bumped by the host when the user re-invokes "chat" on this already
   * front chat (Cmd+N with a fresh chat open): the dock re-pulls the
   * editor selection as if it had just come to the front.
   */
  pullSelectionNonce?: number;
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
  /** An edited-file row in the turn-step log was clicked — open the file. */
  onFileClick?: (path: string) => void;
  /** Fork the conversation from this assistant message (hover action). */
  onFork?: (messageId: string) => void;
  /** Set on forked chats: reveal the parent conversation. */
  onOpenParent?: () => void;
  onEntryChange: (entry: ChatDockEntry) => void;
  /** Records the tab → floating Escape handoff for an immediate Cmd+W. */
  onEscapeToFloating?: (localId: string) => void;
  /** Close the chat entirely (dismissing an empty chat removes it). */
  onClose: (localId: string) => void;
  /**
   * Hands the host this dock's animated close, so external closers
   * (Cmd+W's close-surface) play the same 250ms collapse as Escape
   * instead of unmounting the dock mid-frame.
   */
  registerClose?: (close: () => void) => void;
  /**
   * Hands the host the staged tab-minimize (collapse tween first, mode
   * flip after), so external minimizers (Cmd+M) read the same as the
   * dock's own dash control.
   */
  registerMinimize?: (minimize: () => void) => void;
  /**
   * Hands the host this chat's live sender (palette skill rows, post-auth
   * continuations). Sends queue behind an in-flight turn like composer
   * sends do.
   */
  registerSend?: (send: (message: string) => void) => void;
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
  placeholder,
  tabActive,
  refreshWhileIdle = false,
  slot = "full",
  splitRatio = 0.5,
  splitResizing = false,
  bubbleClearance,
  backdropTab = false,
  defaultAgentId,
  paletteTargeted,
  surfaces = [],
  onOpenSurface,
  onRemoveSurface,
  onOpenMcpApp,
  onFocusRequest,
  pullSelectionNonce = 0,
  onUnsplit,
  onLinkClick,
  onFileClick,
  onFork,
  onOpenParent,
  onEntryChange,
  onEscapeToFloating,
  onClose,
  registerClose,
  registerMinimize,
  registerSend,
  onSessionCreated,
  onSignalsChange,
}: ChatDockProps) {
  const emptyPrompt = emptyChatPromptFor(entry.localId);
  const composerPlaceholder = placeholder ?? emptyPrompt.composer;
  const environmentQuery = useEnvironments(projectId, {
    workload: "agent",
    ...((entry.agentId ?? defaultAgentId)
      ? { agentId: entry.agentId ?? defaultAgentId }
      : {}),
  });
  const compatibleEnvironments =
    environmentQuery.data?.items.filter((item) => item.compatible) ?? [];
  const [selectedEnvironment, setSelectedEnvironment] = useState<string>();
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  useEffect(() => {
    if (
      compatibleEnvironments.some(
        (environment) => environment.name === selectedEnvironment,
      ) ||
      compatibleEnvironments.length === 0
    ) {
      return;
    }
    setSelectedEnvironment(
      compatibleEnvironments.find((item) => item.preferred)?.name ??
        environmentQuery.data?.defaultEnvironment ??
        compatibleEnvironments[0]?.name,
    );
  }, [compatibleEnvironments, environmentQuery.data, selectedEnvironment]);
  const chat = useAgentChat(projectId, {
    sessionId: entry.sessionId,
    agentId: entry.agentId ?? defaultAgentId,
    environment: selectedEnvironment,
    idleRefetchIntervalMs: refreshWhileIdle ? 3_000 : false,
    onSessionCreated: (sessionId) => {
      // Desktop-local privacy flag (ADR 0062): recorded the moment the
      // lazy session gets its id, well before the first turn can settle
      // (and thus before the mirror could ever consider pushing it).
      if (entry.incognito) {
        void desktopApi.sessionSetIncognito(sessionId, true);
      }
      onSessionCreated(entry.localId, sessionId);
    },
  });
  const watcherQuery = useWatchers(
    projectId,
    chat.sessionId ?? entry.sessionId ?? undefined,
  );
  const visibleWatchers = watcherQuery.data?.items ?? [];
  const activeEnvironment = chat.session?.environment ?? selectedEnvironment;
  const isIncognito = Boolean(entry.incognito);
  const [remoteCheckNonce, setRemoteCheckNonce] = useState(0);
  const wasSendingRef = useRef(chat.isSending);
  useEffect(() => {
    if (chat.isSending && !wasSendingRef.current) {
      setRemoteCheckNonce((current) => current + 1);
    }
    wasSendingRef.current = chat.isSending;
  }, [chat.isSending]);
  const [checkout, setCheckout] = useState<SessionCheckoutInfo | null>(null);
  const activeSessionId = chat.sessionId ?? entry.sessionId;
  const [moveState, setMoveState] = useState<{
    canMove: boolean;
    reason: string | null;
    moving: boolean;
  }>({
    canMove: false,
    reason: "Start the session before moving it",
    moving: false,
  });
  const moveDescriptionId = useId();
  const moveHintLabel = moveState.moving
    ? "Moving session to server…"
    : moveState.canMove
      ? moveState.reason
        ? `${moveState.reason}. Try again`
        : "Move to server"
      : (moveState.reason ?? "Session cannot move to a server");
  useEffect(() => {
    if (chat.isSending) {
      setMoveState({
        canMove: false,
        reason: "Wait for the current work to finish",
        moving: false,
      });
      return;
    }
    if (!activeSessionId) {
      setMoveState({
        canMove: false,
        reason: "Start the session before moving it",
        moving: false,
      });
      return;
    }
    let cancelled = false;
    void desktopApi
      .sessionMoveEligibility(projectId, activeSessionId)
      .then((eligibility) => {
        if (!cancelled) setMoveState({ ...eligibility, moving: false });
      })
      .catch(() => {
        if (!cancelled) {
          setMoveState({
            canMove: false,
            reason: "Could not check the linked server",
            moving: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, chat.isSending, projectId]);
  useEffect(() => {
    const load = () => {
      if (!entry.sessionId) {
        setCheckout(null);
        return;
      }
      void desktopApi.sessionCheckouts(projectId).then((checkouts) => {
        setCheckout(
          checkouts.find(
            (candidate) => candidate.sessionId === entry.sessionId,
          ) ?? null,
        );
      });
    };
    load();
    return desktopApi.onGitChanged((event) => {
      if (event.projectId === projectId) load();
    });
  }, [entry.sessionId, projectId]);
  // The composer's DOM is the source of truth (see ComposerInput); these
  // mirror what it says so the rest of the dock can react — the prose
  // (slash menu, recall gate, emptiness) and how many pills are live.
  const [draft, setDraft] = useState("");
  const [pillCount, setPillCount] = useState(0);
  const composerRef = useRef<ComposerInputHandle>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Set while the dock itself rewrites the prose (recall, slash-complete)
  // so the change handler can tell "the user typed" from "we swapped".
  const rewritingRef = useRef(false);
  const rewriteText = (text: string) => {
    rewritingRef.current = true;
    try {
      composerRef.current?.replaceText(text);
    } finally {
      rewritingRef.current = false;
    }
  };

  // Slash commands (ADR 0052): "/" at the start of the composer lists the
  // project's skills (both tiers, fetched fresh while relevant); a
  // committed command sends the skill's invocation message. The menu shows
  // only while the command token is being typed — a space (arguments)
  // closes it, and submit still resolves `/name args` to the invocation.
  const slashing = draft.startsWith("/");
  const skills = useProjectSkills(projectId, slashing);
  // The harness's OWN slash commands (Claude Code: built-ins,
  // .claude/commands, plugin commands) merge in under the skills — the
  // menu shows what the agent would actually accept, not just skills.
  // Fetched (cached in main) when "/" starts; the effect lives below the
  // roster, which knows the active agent.
  const [harnessCommands, setHarnessCommands] = useState<
    Array<{ name: string; description: string; argumentHint: string }>
  >([]);
  const slashToken = /^\/([^\s/]*)$/.exec(draft)?.[1];
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMatches = useMemo<SlashEntry[]>(() => {
    if (slashToken === undefined) return [];
    const skillNames = new Set(skills.map((skill) => skill.name));
    const all: SlashEntry[] = [
      ...skills.map((skill) => ({
        kind: "skill" as const,
        name: skill.name,
        description: skill.description,
        skill,
      })),
      // A skill can also surface as a CLI command (the host-skills
      // plugin); the skill row wins the name.
      ...harnessCommands
        .filter((command) => !skillNames.has(command.name))
        .map((command) => ({
          kind: "command" as const,
          name: command.name,
          description: command.description,
          command,
        })),
    ];
    if (!slashToken) return all;
    return all
      .map((entry) => ({
        entry,
        score: commandScore(entry.name, slashToken, [entry.description]),
      }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((scored) => scored.entry);
  }, [slashToken, skills, harnessCommands]);
  const slashMenuOpen =
    slashToken !== undefined && !slashDismissed && slashMatches.length > 0;
  const slashSelected = Math.min(slashIndex, slashMatches.length - 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token is the trigger — each command keystroke resets the selection
  useEffect(() => {
    setSlashIndex(0);
  }, [slashToken]);

  /** Commit a slash-menu row: send the invocation (attachments ride along). */
  const runSlash = (entry: SlashEntry) => {
    const files = composerRef.current?.read().attachments ?? [];
    composerRef.current?.clear();
    setRecall(null);
    // Skills send their harness-neutral invocation; harness commands go
    // as the literal "/name" — the CLI executes those natively.
    void chat.send(
      entry.kind === "skill" ? skillInvocation(entry.name) : `/${entry.name}`,
      files,
    );
  };

  /** `/name args` sent as text still resolves to the skill invocation. */
  const resolveSlashMessage = (message: string): string => {
    const match = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(message);
    if (!match?.[1]) return message;
    const skill = skills.find((entry) => entry.name === match[1]);
    return skill ? skillInvocation(skill.name, match[2]) : message;
  };
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

  // Connector icons for the turn event log: `server/tool` names resolve
  // through the connection roster to the connector's icon.
  const [connectorIcons, setConnectorIcons] = useState<Map<string, string>>(
    () => new Map(),
  );
  useEffect(() => {
    void desktopApi
      .connectionsList()
      .then((connections) => {
        const icons = new Map<string, string>();
        for (const connection of connections) {
          if (connection.iconUrl) {
            icons.set(connection.serverKey, connection.iconUrl);
          }
        }
        setConnectorIcons(icons);
      })
      .catch(() => {});
  }, []);
  const resolveToolIcon = useCallback(
    (toolName: string) => {
      const slash = toolName.indexOf("/");
      if (slash <= 0) return undefined;
      return connectorIcons.get(toolName.slice(0, slash));
    },
    [connectorIcons],
  );

  // Subagent, watcher, worked-on-app, and MCP-app-view chips come from
  // the chat's own turn events (every harness reports them through the
  // common event model); workspace-tab chips arrive via the surfaces
  // prop. One rail, all of them.
  const chatActivityChips = useMemo(
    () => activityChips(chat.messages, chat.isWorking, uiTools),
    [chat.messages, chat.isWorking, uiTools],
  );
  const railSurfaces = useMemo(() => {
    // One chip per key: a surface known to both the host and the turn
    // events (an app tab prepared by open_surface AND touched by this
    // turn's file edits) merges — activity animates it, host state
    // (attention) rides along.
    const activityByKey = new Map(
      chatActivityChips.map((chip) => [chip.key, chip]),
    );
    const merged = surfaces.map((surface) => {
      const activity = activityByKey.get(surface.key);
      if (!activity) return surface;
      activityByKey.delete(surface.key);
      return {
        ...activity,
        ...surface,
        active: surface.active || activity.active,
      };
    });
    return [...merged, ...activityByKey.values()];
  }, [surfaces, chatActivityChips]);

  // ↑/↓ in the composer recall previously sent messages, shell-history
  // style: ↑ from an empty (or recalled) draft steps back through what
  // you sent, ↓ steps forward and finally restores the stashed draft.
  // Typing anything exits recall mode.
  // Recalled text names its pills — "fix [sel.md · 3–10]" — since the
  // pills themselves belong to the message that was sent.
  const sentHistory = messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.content !== QUESTIONS_DISMISSED_MESSAGE &&
        message.content.trim() !== "",
    )
    .map((message) =>
      messageWithAttachmentNames(
        message.content,
        message.attachments ??
          attachmentsFromMetadata(
            typeof message.metadata === "object" && message.metadata !== null
              ? (message.metadata as Record<string, unknown>)
              : undefined,
          ),
      ),
    );
  const [recall, setRecall] = useState<{ index: number; stash: string } | null>(
    null,
  );
  // Each direction has two identical animation names. Alternating the name
  // restarts rapid same-direction recalls without dropping the class for a
  // frame, which previously exposed a flicker between text rewrites.
  const [recallMotion, setRecallMotion] = useState<{
    direction: "up" | "down";
    sequence: number;
  } | null>(null);
  const flashRecall = (direction: "up" | "down") => {
    setRecallMotion((current) => ({
      direction,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  };
  const applyRecall = (
    index: number,
    stash: string,
    direction: "up" | "down",
  ) => {
    const content = sentHistory[index];
    if (content === undefined) return;
    setRecall({ index, stash });
    rewriteText(content);
    flashRecall(direction);
  };
  const recallUp = (): boolean => {
    if (sentHistory.length === 0) return false;
    if (recall === null) {
      if (draft.trim() !== "") return false;
      applyRecall(sentHistory.length - 1, draft, "up");
      return true;
    }
    if (recall.index === 0) return true; // at the oldest — swallow the key
    applyRecall(recall.index - 1, recall.stash, "up");
    return true;
  };
  const recallDown = (): boolean => {
    if (recall === null) return false;
    if (recall.index >= sentHistory.length - 1) {
      rewriteText(recall.stash);
      setRecall(null);
      flashRecall("down");
      return true;
    }
    applyRecall(recall.index + 1, recall.stash, "down");
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
  // Refetched when the session's agent changes (a switch may involve an
  // agent created after this dock mounted) and on agents-changed
  // broadcasts (a new default agent must reach already-open docks).
  const sessionAgentId = chat.session?.agentId;
  const [rosterNonce, setRosterNonce] = useState(0);
  useEffect(
    () => desktopApi.onAgentsChanged(() => setRosterNonce((n) => n + 1)),
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionAgentId/rosterNonce are refetch triggers, not body dependencies
  useEffect(() => {
    let cancelled = false;
    // Profile roster + the project's committed agents (ADR 0050), merged:
    // a session on a `project:<id>:<slug>` agent shows the definition's
    // name and capabilities wherever profile agents show theirs.
    void Promise.all([
      desktopApi.agentsList(),
      desktopApi.projectAgentsList(projectId).catch(() => ({ agents: [] })),
    ])
      .then(([data, project]) => {
        if (cancelled) return;
        setRoster({
          agents: [...data.agents, ...project.agents.map(projectAgentAsInfo)],
          defaultAgentId: data.defaultAgentId,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionAgentId, projectId, rosterNonce]);
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
  const isTab = entry.mode === "tab";
  const frontSurface = entry.mode === "partial" || (isTab && tabActive);

  // Lurk mode: while the agent works and a tab is visible behind the
  // floating dock, the dock shrinks VERTICALLY to a strip — header, the
  // tail of the timeline (the latest preambles; the timeline sticks to
  // its bottom), composer — so the user can watch the tab. Hovering or
  // focusing the dock expands it; leaving re-shrinks unless focus is
  // inside; focusing/clicking outside shrinks; questions and the end of
  // the turn expand it for good.
  const sectionRef = useRef<HTMLElement>(null);
  const [dockHovered, setDockHovered] = useState(false);
  // Starts true: the dock claims focus when it opens.
  const [dockEngaged, setDockEngaged] = useState(true);
  // Deferred focus may run much later in a hidden/throttled window. Explicit
  // input and external focus changes after it was scheduled own focus. Only
  // this dock's known autofocus calls are excluded from that authority.
  const userInteractionRef = useRef(0);
  const internalAutofocusDepthRef = useRef(0);
  useLayoutEffect(() => {
    if (!frontSurface) return;
    const inDock = (target: EventTarget | null) =>
      target instanceof Node && sectionRef.current?.contains(target) === true;
    const onFocusIn = (event: FocusEvent) => {
      if (internalAutofocusDepthRef.current === 0) {
        userInteractionRef.current += 1;
      }
      setDockEngaged(inDock(event.target));
    };
    // Clicks on unfocusable chrome (a webview, blank pane space) never
    // fire focusin — the pointer decides too.
    const onPointerDown = (event: PointerEvent) => {
      userInteractionRef.current += 1;
      setDockEngaged(inDock(event.target));
    };
    const onKeyDown = () => {
      userInteractionRef.current += 1;
    };
    // Paste and drop can be the first interaction when invoked through a
    // context menu, accessibility tooling, or automation, so there is no
    // preceding keydown/pointerdown for the autofocus guard to observe.
    // Count the transfer itself before a delayed frame can reclaim focus
    // and reset the contenteditable caret to the start of the draft.
    const onTransfer = () => {
      userInteractionRef.current += 1;
    };
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onTransfer, true);
    window.addEventListener("drop", onTransfer, true);
    return () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onTransfer, true);
      window.removeEventListener("drop", onTransfer, true);
    };
  }, [frontSurface]);

  // Proactive auth health (t3-code-inspired): probed while this chat is
  // the front surface — on agent change, window focus, and OS wake — so
  // an expired session prompts BEFORE a send fails, not after. Only
  // session-auth agents (claude-code/codex account or local logins) get
  // the banner; API keys don't rot on a timer.
  const [authHealth, setAuthHealth] = useState<"ok" | "expired" | "missing">(
    "ok",
  );
  // Main's verdict on whether a one-click re-login flow exists for the
  // active agent; the dock renders it verbatim and never re-derives it.
  const [authReauth, setAuthReauth] = useState(false);
  const [authBannerDismissed, setAuthBannerDismissed] = useState(false);
  // Every re-login-able agent: CLI sessions (claude-code/codex, account
  // or local) and OpenRouter's PKCE key. Plain api-key agents are
  // Settings-only and never bannered.
  const sessionAuthAgent =
    activeAgent &&
    (activeAgent.auth === "account" || activeAgent.auth === "local");
  useEffect(() => {
    if (!frontSurface || !sessionAuthAgent || !activeAgent) {
      setAuthHealth("ok");
      // No probe ran for this agent, so no re-login verdict either — a
      // stale true from the previous agent must not offer a broken flow.
      setAuthReauth(false);
      return;
    }
    let cancelled = false;
    const probe = () => {
      desktopApi
        .agentAuthHealth(activeAgent.id)
        .then((report) => {
          if (cancelled) return;
          setAuthReauth(report.reauth);
          setAuthHealth((previous) => {
            if (previous !== report.health) setAuthBannerDismissed(false);
            return report.health;
          });
        })
        .catch(() => {});
    };
    probe();
    const offWake = desktopApi.onAgentAuthMaybeChanged(probe);
    const offLogin = desktopApi.onAgentLoginFinished((result) => {
      if (result.agentId === activeAgent.id) probe();
    });
    window.addEventListener("focus", probe);
    return () => {
      cancelled = true;
      offWake();
      offLogin();
      window.removeEventListener("focus", probe);
    };
  }, [frontSurface, sessionAuthAgent, activeAgent]);

  // Harness command fetch: when "/" starts, ask main for the CLI's own
  // command list. Main owns the gating (Claude Code agents only — others
  // answer empty) and the cache; the id in the deps clears a stale list
  // on agent switch.
  const commandsAgentId = activeAgent?.id ?? null;
  useEffect(() => {
    setHarnessCommands([]);
    if (!slashing || commandsAgentId === null) return;
    let cancelled = false;
    desktopApi
      .agentCommands(projectId, commandsAgentId)
      .then((commands) => {
        if (!cancelled) setHarnessCommands(commands);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slashing, commandsAgentId, projectId]);

  // Whether a one-click re-login exists is main's verdict (the auth-health
  // probe reports it); the dock only supplies the label and the launcher.
  const reauth =
    activeAgent && authReauth
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
  const hasDraft = draft.trim().length > 0 || pillCount > 0;
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
  const onEscapeToFloatingRef = useRef(onEscapeToFloating);
  onEscapeToFloatingRef.current = onEscapeToFloating;

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

  // Closing an empty chat plays the same 250ms collapse as minimizing.
  // Both use an explicit exit keyframe so interrupting dock-in cannot make
  // Chromium skip the collapse transition before the delayed unmount.
  const [closing, setClosing] = useState(false);
  // Minimizing a chat stages the same way as registered close: the collapse
  // plays first, then the mode flips to "min". For a tab this also keeps the
  // workspace re-render, tab switch, strip tab-out, and bubble-in out of the
  // tween's critical path.
  const [minimizing, setMinimizing] = useState(false);
  const minimizingRef = useRef(false);
  const expanded =
    !closing &&
    !minimizing &&
    (entry.mode === "partial" || (isTab && tabActive));
  // The visual pose: during a staged tab minimize/close the section
  // renders the floating-dock pose while the entry is still mode "tab",
  // so the exit reads as the tab shrinking away toward the bubble strip.
  const presentsAsTab = isTab && !closing && !minimizing;

  const setMode = (mode: ChatMode) => onEntryChange({ ...entry, mode });

  const animatedMinimize = () => {
    if (minimizingRef.current) return;
    minimizingRef.current = true;
    setMinimizing(true);
    window.setTimeout(() => {
      minimizingRef.current = false;
      setMinimizing(false);
      onEntryChangeRef.current({ ...entryRef.current, mode: "min" });
    }, 250);
  };

  // An untouched chat has nothing worth keeping — dismissing it (Escape
  // or the minimize button) closes it instead of parking an empty bubble.
  // A typed-but-unsent draft counts as worth keeping.
  const isEmpty =
    messages.length === 0 &&
    !chat.isSending &&
    chat.queuedMessageCount === 0 &&
    draft.trim() === "" &&
    pillCount === 0;
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
  const animatedMinimizeRef = useRef(animatedMinimize);
  animatedMinimizeRef.current = animatedMinimize;

  useEffect(() => {
    registerClose?.(() => animatedCloseRef.current());
  }, [registerClose]);
  useEffect(() => {
    registerMinimize?.(() => animatedMinimizeRef.current());
  }, [registerMinimize]);
  useEffect(() => {
    registerSend?.((message) => void sendRef.current(message));
  }, [registerSend]);

  const dismiss = () => {
    if (isEmpty) animatedClose();
    else animatedMinimize();
  };

  const takeComposer = (): {
    message: string;
    files: AgentChatAttachment[];
  } | null => {
    const composed = composerRef.current?.read();
    if (!composed) return null;
    const { message, attachments: files } = composed;
    if (!message && files.length === 0) return null;
    composerRef.current?.clear();
    setRecall(null);
    return { message, files };
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const composed = takeComposer();
    if (!composed) return;
    void chat.send(resolveSlashMessage(composed.message), composed.files);
  };

  /** ⌘↵: jump the queue — interrupt the running turn and send this now. */
  const submitNow = () => {
    const composed = takeComposer();
    if (!composed) return;
    void chat.sendNow(resolveSlashMessage(composed.message), composed.files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    // The slash menu owns navigation keys while open (before recall's
    // ArrowUp/Down claim below). Escape closes it and stays in the
    // composer — preventDefault keeps the window listener from stepping
    // the whole chat down.
    if (slashMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((current) => {
          const last = slashMatches.length - 1;
          const at = Math.min(current, last);
          return event.key === "ArrowDown"
            ? Math.min(at + 1, last)
            : Math.max(at - 1, 0);
        });
        return;
      }
      if (event.key === "Tab") {
        // Complete the name, keep typing arguments.
        event.preventDefault();
        const entry = slashMatches[slashSelected];
        if (entry) {
          rewriteText(`/${entry.name} `);
          setRecall(null);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        const entry = slashMatches[slashSelected];
        if (entry) runSlash(entry);
        return;
      }
    }
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
    // Backspace with no prose left pops the newest pill (the palette's
    // chip-pop) — the input already handles a caret sitting right against
    // a pill; this covers a caret parked elsewhere in an otherwise empty
    // composer. emptyButPills, not the trimmed draft: a blank line
    // (Shift+Enter) trims to an empty draft while a deletable break is
    // still under the caret, and that break must win over the pill.
    if (
      event.key === "Backspace" &&
      draft.length === 0 &&
      composerRef.current?.emptyButPills() &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (composerRef.current?.removeLastPill()) event.preventDefault();
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

  /**
   * Add a text pill (paste, selection, URL, path, tab) inline at the caret
   * (or where it was dropped); capped like the server.
   */
  const addTextPill = (
    pill: AgentChatTextAttachment,
    at?: { x: number; y: number },
  ) => {
    const composer = composerRef.current;
    if (!composer) return;
    // The same selection can arrive twice (pulled when the chat came to
    // the front, then pasted): one pill.
    const source = pill.source;
    if (
      source.type === "selection" &&
      composer
        .read()
        .attachments.some(
          (attachment) =>
            attachment.kind === "text" &&
            attachment.source.type === "selection" &&
            attachment.source.filePath === source.filePath &&
            attachment.text.replace(/\r\n?/g, "\n") ===
              pill.text.replace(/\r\n?/g, "\n"),
        )
    ) {
      return;
    }
    composer.insertPills([{ ...pill, id: crypto.randomUUID() }], { at });
  };
  const addTextPillRef = useRef(addTextPill);
  addTextPillRef.current = addTextPill;

  /**
   * Dropped/pasted files become inline pills. Media (image/document) when
   * the agent takes that kind, the file fits the per-file cap, and the
   * message's media budget has room; ANYTHING else — a .pcap, an oversized
   * video, media for a text-only agent — still attaches, as a path pill
   * the agent reads itself. Only a pathless File that can't ship as media
   * (a synthetic clipboard bitmap too big to send) is dropped.
   */
  const addFilesQueueRef = useRef<Promise<void>>(Promise.resolve());
  const addFiles = (files: File[], at?: { x: number; y: number }) => {
    if (files.length === 0) return;
    // Serialized through one chain: the media budget is read from a
    // snapshot of the composer, so a second drop landing while the first
    // is still encoding must wait for its pills to insert or both drops
    // would each be granted the full budget.
    addFilesQueueRef.current = addFilesQueueRef.current.then(async () => {
      const current = composerRef.current?.read().attachments ?? [];
      let budget =
        MAX_TOTAL_MEDIA_BYTES -
        current.reduce(
          (total, attachment) =>
            attachment.kind === "text"
              ? total
              : total + Math.round((attachment.dataBase64.length * 3) / 4),
          0,
        );
      const pills: ComposerAttachment[] = [];
      for (const file of files) {
        const kind = mediaKindOf(file);
        const asMedia =
          kind !== null &&
          accepts.includes(kind) &&
          file.size > 0 &&
          file.size <= MAX_ATTACHMENT_BYTES &&
          file.size <= budget;
        if (asMedia) {
          pills.push(await encodeFile(file, kind));
          budget -= file.size;
          continue;
        }
        const pathPill = pathPillFor(file);
        if (pathPill) pills.push(pathPill);
      }
      if (pills.length > 0) composerRef.current?.insertPills(pills, { at });
    });
  };

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  /**
   * What a paste becomes. Files → media pills (capability-gated); a copy
   * out of one of our editors → a selection pill whatever the size (the
   * file + line range is the point, not the byte count); big text, URLs
   * and file paths → text pills (universal — every harness takes text);
   * ordinary short text → plain text at the caret when the paste is
   * aimed at the composer, nothing otherwise. Returns whether it took
   * the paste.
   */
  const consumePaste = (
    data: DataTransfer | null,
    opts: { intoComposer: boolean },
  ): boolean => {
    const files = filesFrom(data);
    if (files.length > 0) {
      addFilesRef.current(files);
      return true;
    }
    const fromEditor = selectionFromClipboard(data);
    if (fromEditor) {
      addTextPillRef.current(
        textPill(
          fromEditor.text.replace(/\r\n?/g, "\n"),
          {
            type: "selection",
            filePath: fromEditor.filePath,
            ...(fromEditor.startLine !== undefined
              ? { startLine: fromEditor.startLine }
              : {}),
            ...(fromEditor.endLine !== undefined
              ? { endLine: fromEditor.endLine }
              : {}),
          },
          selectionName(fromEditor),
        ),
      );
      return true;
    }
    let text = data?.getData("text/plain") ?? "";
    if (!text) {
      // Copy buttons that write only a text/html flavor (ClipboardItem)
      // must still paste something: take the markup's text. Without this,
      // the unconditional preventDefault would swallow the paste whole.
      const html = data?.getData("text/html") ?? "";
      if (html) {
        text =
          new DOMParser().parseFromString(html, "text/html").body.textContent ??
          "";
      }
    }
    const classified = classifyPastedText(text);
    if (classified.kind === "pill") {
      addTextPillRef.current(
        textPill(
          text.replace(/\r\n?/g, "\n"),
          classified.source,
          classified.name,
        ),
      );
      return true;
    }
    if (!opts.intoComposer || !text) return false;
    // Rich clipboards (HTML from a page) land as plain text — the composer
    // is prose, not a document.
    composerRef.current?.insertText(text.replace(/\r\n?/g, "\n"));
    return true;
  };
  const consumePasteRef = useRef(consumePaste);
  consumePasteRef.current = consumePaste;

  /** Paste aimed at the composer: always ours (plain text, pills, files). */
  const onComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    consumePaste(event.clipboardData, { intoComposer: true });
  };

  // Paste is ALSO handled at the WINDOW while this chat is the front
  // surface: requiring the caret to be exactly in the composer made "copy
  // a screenshot, click the chat, Cmd+V" silently do nothing. Only pastes
  // aimed at no field at all count — pasting a URL into a settings input
  // must stay a plain paste there.
  useEffect(() => {
    if (!frontSurface) return;
    const onWindowPaste = (event: globalThis.ClipboardEvent) => {
      if (event.defaultPrevented) return;
      // Files attach regardless of focus: a text field has no native
      // handling for a file paste, so gating on the target would silently
      // drop "copy a screenshot, Cmd+V" whenever a field had the caret.
      const files = filesFrom(event.clipboardData);
      if (files.length > 0) {
        addFilesRef.current(files);
        event.preventDefault();
        return;
      }
      const target = event.target;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (inField) return;
      if (
        consumePasteRef.current(event.clipboardData, { intoComposer: false })
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [frontSurface]);

  // Editor selection → pill. When this chat BECOMES the front surface
  // (Cmd+N created it, Cmd+M restored it, the user clicked into it) and an
  // editor has a live selection, that selection arrives as a pill: the
  // reference (file · lines) plus the text itself, since files change and
  // the quote pins what was meant. Pull happens on the transition only, so
  // an idle chat never grabs anything; a repeat of the identical selection
  // is not re-added.
  const lastSelectionPillRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the front surface changes only; the pill helpers are stable refs
  useEffect(() => {
    if (!frontSurface) return;
    const selection = readEditorSelection();
    if (!selection) return;
    const key = `${selection.filePath}\u0000${selection.startLine ?? ""}\u0000${selection.text}`;
    if (lastSelectionPillRef.current === key) return;
    lastSelectionPillRef.current = key;
    addTextPillRef.current(
      textPill(
        selection.text,
        {
          type: "selection",
          filePath: selection.filePath,
          ...(selection.startLine !== undefined
            ? { startLine: selection.startLine }
            : {}),
          ...(selection.endLine !== undefined
            ? { endLine: selection.endLine }
            : {}),
        },
        selectionName(selection),
      ),
    );
  }, [frontSurface, pullSelectionNonce]);

  // Drag & drop onto the chat surface attaches too (with a drop cue) —
  // dragging an image in is the first thing many people try.
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);

  // Expanding (bubble click, new chat) should land the user ready to type.
  // rAF waits out the `inert` removal — focus() is a no-op on inert subtrees.
  // The composer's attach button opens this hidden picker.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusComposerInternally = useCallback(() => {
    internalAutofocusDepthRef.current += 1;
    try {
      composerRef.current?.focus();
    } finally {
      internalAutofocusDepthRef.current -= 1;
    }
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const userInteraction = userInteractionRef.current;
    const frame = requestAnimationFrame(() => {
      if (userInteractionRef.current === userInteraction) {
        focusComposerInternally();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, focusComposerInternally]);
  // Stepping down from a tab to the floating dock (Escape) keeps the
  // user IN the chat: the tab that surfaces behind it (a New Tab palette
  // autofocuses its input) must not steal focus — Cmd+W right after
  // should still close the chat, and typing should still land here.
  // The surfacing tab may mount (and focus) a couple of frames later,
  // after its pane-in animation — so claim focus now, next frame, and
  // once more after that animation window (tab-in is 200ms).
  const previousModeRef = useRef(entry.mode);
  useEffect(() => {
    const previous = previousModeRef.current;
    previousModeRef.current = entry.mode;
    if (!(previous === "tab" && entry.mode === "partial")) return;
    const userInteraction = userInteractionRef.current;
    const focus = () => {
      if (userInteractionRef.current === userInteraction) {
        focusComposerInternally();
      }
    };
    focus();
    const frame = requestAnimationFrame(focus);
    const timer = window.setTimeout(focus, 260);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [entry.mode, focusComposerInternally]);

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
      // A staged minimize is already in flight; don't fight its timeout.
      if (minimizingRef.current) return;
      event.preventDefault();
      if (entryRef.current.mode === "tab") {
        // Claim focus before the workspace mode flip. The floating pose can
        // commit before the effect below runs; without this synchronous
        // handoff, a Cmd+W in that frame may be attributed to the tab that
        // just surfaced behind the chat.
        focusComposerInternally();
        onEscapeToFloatingRef.current?.(entryRef.current.localId);
        onEntryChangeRef.current({ ...entryRef.current, mode: "partial" });
      } else if (isEmptyRef.current) {
        // Escaping an untouched floating chat closes it — no empty bubble.
        animatedCloseRef.current();
      } else {
        animatedMinimizeRef.current();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [escapeTarget, focusComposerInternally]);

  // In a split, a tabbed chat occupies only its (ratio-sized) share of
  // the view; floating chats always overlay the full area.
  const splitPane = presentsAsTab && tabActive && slot !== "full";
  const lurking =
    entry.mode === "partial" &&
    expanded &&
    backdropTab &&
    chat.isWorking &&
    !questions &&
    !dockHovered &&
    !dockEngaged &&
    !dropActive;
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
            : presentsAsTab
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
        ref={sectionRef}
        onMouseEnter={() => setDockHovered(true)}
        onMouseLeave={() => setDockHovered(false)}
        onMouseDownCapture={onFocusRequest}
        onDragEnter={(event) => {
          if (!isComposerTransfer(event.dataTransfer)) return;
          event.preventDefault();
          dragDepthRef.current += 1;
          setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!isComposerTransfer(event.dataTransfer)) return;
          event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        }}
        onDrop={(event) => {
          // Acceptance follows the transfer itself, not dropActive: that
          // state only paints the cue and may not have committed yet when a
          // quick dragenter → drop sequence completes in one browser turn.
          if (!isComposerTransfer(event.dataTransfer)) return;
          event.preventDefault();
          dragDepthRef.current = 0;
          setDropActive(false);
          // Dropped onto the composer itself: the pill lands where the
          // pointer let go; anywhere else on the chat: at the caret/end.
          const overComposer =
            event.target instanceof HTMLElement &&
            event.target.closest("[data-composer-input]") !== null;
          const at = overComposer
            ? { x: event.clientX, y: event.clientY }
            : undefined;
          const tab = tabPillFromDrag(event.dataTransfer);
          if (tab) {
            addTextPill(tab, at);
            return;
          }
          addFiles(filesFrom(event.dataTransfer), at);
        }}
        data-palette-target={(paletteTargeted && !isTab) || undefined}
        data-floating-chat={entry.mode === "partial" || undefined}
        data-lurking={lurking || undefined}
        data-chat-local-id={entry.localId}
        className={`pointer-events-auto relative flex w-full origin-bottom flex-col overflow-hidden backdrop-blur-xl transition-[max-width,height,opacity,translate,scale,background-color,border-radius,border-color] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
          presentsAsTab
            ? "h-full max-w-full rounded-none border-0 border-transparent bg-bg"
            : `${
                lurking ? "h-44" : "h-[min(560px,100%)]"
              } max-w-3xl rounded-2xl border bg-bg-raised/95 drop-shadow-2xl ${
                paletteTargeted && !isTab ? "border-accent" : "border-border"
              }`
        } ${
          closing || minimizing
            ? "pointer-events-none translate-y-4 scale-[0.985] opacity-0 animate-dock-out"
            : expanded
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
            presentsAsTab ? "h-0 border-transparent" : "h-11 border-border"
          }`}
          aria-hidden={presentsAsTab}
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
            {chat.session?.environment ? (
              <span
                className="flex shrink-0 items-center gap-1 rounded-full border border-border-strong bg-bg-inset px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
                data-testid="chat-environment-badge"
              >
                <Globe className="size-3" />
                {chat.session.environment}
              </span>
            ) : compatibleEnvironments.length > 1 ? (
              <select
                aria-label="Environment"
                data-testid="chat-environment-select"
                value={selectedEnvironment ?? ""}
                onChange={(event) => setSelectedEnvironment(event.target.value)}
                className="max-w-36 rounded-md border border-border bg-bg-inset px-1.5 py-0.5 text-[10px] font-medium text-fg-muted outline-none"
              >
                {compatibleEnvironments.map((environment) => (
                  <option key={environment.name} value={environment.name}>
                    {environment.label}
                  </option>
                ))}
              </select>
            ) : null}
            {activeEnvironment && (
              <button
                type="button"
                aria-label="Manage Environment connections"
                title="Manage Environment connections"
                onClick={() => setConnectionsOpen(true)}
                className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-muted hover:bg-bg-overlay hover:text-fg"
              >
                <KeyRound className="size-3" />
              </button>
            )}
            {isIncognito && (
              <span
                className="flex shrink-0 items-center gap-1 rounded-full border border-border-strong bg-bg-inset px-1.5 py-0.5 text-[10px] font-medium text-fg-muted"
                title="Incognito: stays on this machine, never synced to a linked server"
                data-testid="chat-incognito-badge"
              >
                <Ghost className="size-3" />
                Incognito
              </span>
            )}
          </span>
        </header>
        {/* Agent progress sits immediately left of the chat control bar;
            both stay above timeline content scrolled beneath them. */}
        <div className="absolute right-2 top-2 z-10 flex items-start gap-1">
          <TodoProgress todos={chat.session?.todos ?? []} />
          <span className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-raised/95 p-0.5 backdrop-blur-sm">
            {checkout ? (
              <span
                className="flex max-w-32 items-center gap-1 truncate rounded-md bg-bg-inset px-1.5 py-1 text-[10px] font-medium text-fg-muted"
                data-testid="chat-checkout-badge"
                title={checkout.branch ?? "External worktree"}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">
                  {checkout.kind === "external"
                    ? "External"
                    : (checkout.branch ?? "Worktree")}
                </span>
              </span>
            ) : null}
            <span id={moveDescriptionId} className="sr-only">
              {moveHintLabel}
            </span>
            <ShortcutHint label={moveHintLabel}>
              <button
                type="button"
                aria-label="Move to server"
                aria-describedby={
                  moveState.reason || moveState.moving
                    ? moveDescriptionId
                    : undefined
                }
                aria-disabled={!moveState.canMove || moveState.moving}
                data-testid="chat-move-to-server"
                className={`grid size-7 place-items-center rounded-md transition-colors duration-150 ${
                  moveState.canMove && !moveState.moving
                    ? "cursor-pointer text-fg-muted hover:bg-bg-overlay hover:text-fg"
                    : "cursor-not-allowed text-fg-faint opacity-45"
                }`}
                onClick={() => {
                  if (
                    !activeSessionId ||
                    !moveState.canMove ||
                    moveState.moving
                  ) {
                    return;
                  }
                  setMoveState((current) => ({ ...current, moving: true }));
                  void desktopApi
                    .sessionMoveToServer(projectId, activeSessionId)
                    .then(() =>
                      setMoveState({
                        canMove: false,
                        reason: "This session now runs on the server",
                        moving: false,
                      }),
                    )
                    .catch((error) =>
                      setMoveState({
                        canMove: true,
                        reason:
                          error instanceof Error
                            ? error.message
                            : "The session could not be moved",
                        moving: false,
                      }),
                    );
                }}
              >
                {moveState.moving ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Server className="size-3.5" />
                )}
              </button>
            </ShortcutHint>
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
        </div>
        {/* In tab mode the scroller spans the full tab (scrollbar at the
            edge) while the content column stays centered and readable. */}
        <div
          className={`flex min-h-0 w-full flex-1 flex-col ${
            isTab ? "" : "mx-auto max-w-3xl"
          }`}
        >
          {visibleWatchers.length > 0 && (
            <div
              className={`flex shrink-0 flex-wrap gap-1 border-b border-border-subtle px-3 py-2 ${
                isTab ? "mx-auto w-full max-w-4xl" : ""
              }`}
              data-testid="chat-watchers"
            >
              {visibleWatchers.map((watcher) => (
                <span
                  key={watcher.id}
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-bg-overlay px-2 py-1 text-[11px] text-fg-muted"
                  title={`${watcher.triggerKinds.join(", ")} · ${watcher.environment ?? "Default environment"}`}
                >
                  <Radio
                    className={`size-3 shrink-0 ${
                      watcher.status === "active"
                        ? "text-accent"
                        : "text-fg-faint"
                    }`}
                  />
                  <span className="max-w-48 truncate">
                    {watcher.workflowName}
                  </span>
                  <span className="text-fg-faint">{watcher.status}</span>
                  {(watcher.status === "active" ||
                    watcher.status === "paused") && (
                    <button
                      type="button"
                      className="ml-0.5 grid size-4 cursor-pointer place-items-center rounded text-fg-faint hover:bg-bg-muted hover:text-fg"
                      aria-label={`Stop watcher ${watcher.workflowName}`}
                      disabled={watcherQuery.stop.isPending}
                      onClick={() => watcherQuery.stop.mutate(watcher.id)}
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
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
            emptyState={emptyPrompt.empty}
            onLinkClick={onLinkClick}
            onFileClick={onFileClick}
            resolveToolIcon={resolveToolIcon}
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
            {/* The rail yields while lurking — the strip's few rows
                belong to the latest activity, not to chips. CSS-collapsed
                (not unmounted) so chip motion state survives the lurk. */}
            {railSurfaces.length > 0 && onOpenSurface && (
              <div
                className={`shrink-0 overflow-hidden transition-[max-height,opacity] duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
                  lurking ? "max-h-0 opacity-0" : "max-h-12 opacity-100"
                }`}
                inert={lurking ? true : undefined}
              >
                <SurfacesRail
                  surfaces={railSurfaces}
                  onOpenSurface={onOpenSurface}
                  onRemoveSurface={onRemoveSurface}
                  onOpenMcpApp={onOpenMcpApp}
                />
              </div>
            )}
            <RemoteMessageConnectionGuard
              projectId={projectId}
              checkNonce={remoteCheckNonce}
            />
            {/* Proactive auth banner: the session is knowably dead
                (probe on focus/wake) — offer the re-login BEFORE a send
                fails. Dismissible; a health change re-arms it. */}
            {authHealth !== "ok" &&
              !authBannerDismissed &&
              sessionAuthAgent &&
              reauth && (
                <div
                  data-testid="auth-health-banner"
                  className="mx-3 mb-1 flex shrink-0 animate-fade-in items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 py-1.5 pl-3 pr-1.5 text-xs text-fg"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {authHealth === "expired"
                      ? `${activeAgent?.name}'s session has expired.`
                      : `${activeAgent?.name} isn't signed in.`}
                  </span>
                  <button
                    type="button"
                    onClick={reauth.run}
                    className="shrink-0 cursor-pointer rounded-md bg-warning/20 px-2 py-1 font-medium transition-colors duration-150 hover:bg-warning/30"
                  >
                    {reauth.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthBannerDismissed(true)}
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                    aria-label="Dismiss"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}
            {chat.authenticationRequired?.requirements.map((requirement) => (
              <AuthenticationRequiredCard
                key={`${chat.authenticationRequired?.environment}:${requirement.alias}`}
                projectId={projectId}
                environment={chat.authenticationRequired?.environment ?? ""}
                requirement={requirement}
                onOpenLink={(url) =>
                  onLinkClick?.(url, { metaKey: true, shiftKey: false })
                }
                onAuthorized={chat.resumeAfterAuthentication}
              />
            ))}
            {questions && !chat.isSending && (
              <AgentQuestionPanel
                questions={questions}
                onSubmit={(answer) => void chat.send(answer)}
                onDismiss={() => void chat.send(QUESTIONS_DISMISSED_MESSAGE)}
                disabled={!expanded}
              />
            )}
            <form
              className="field relative m-3 mt-1 flex shrink-0 flex-col rounded-xl bg-bg-raised/95 p-1.5"
              onSubmit={submit}
            >
              {/* "/" command menu: skills (ADR 0052) merged with the
                  harness's own commands. Rows commit on mousedown like
                  the palette, so the composer never loses focus; the
                  panel pops in/out and rows glide as the filter types. */}
              <SlashMenu
                open={slashMenuOpen}
                matches={slashMatches}
                selected={slashSelected}
                onHover={setSlashIndex}
                onCommit={runSlash}
              />
              <div className="flex items-center gap-2">
                {/* Any file attaches — as media when the agent takes it,
                    as a path pill otherwise — so the picker never filters
                    and never hides. */}
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
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    addFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                {/* Prose and pills in one flow: pastes, selections, links,
                    tabs, images and documents sit inline where they were
                    dropped, enter with pill-in and leave with pill-out. */}
                <ComposerInput
                  ref={composerRef}
                  onAnimationEnd={(event) => {
                    if (event.animationName.startsWith("input-recall-")) {
                      setRecallMotion((current) =>
                        current &&
                        event.animationName ===
                          `input-recall-${current.direction}-${current.sequence % 2 === 0 ? "b" : "a"}`
                          ? null
                          : current,
                      );
                    }
                  }}
                  wrapperClassName="min-w-0 flex-1"
                  className={`max-h-24 min-h-9 overflow-y-auto px-2.5 py-1.5 text-sm leading-6 ${
                    recallMotion
                      ? `animate-input-recall-${recallMotion.direction}-${recallMotion.sequence % 2 === 0 ? "b" : "a"}`
                      : ""
                  }`}
                  onChange={(state) => {
                    setPillCount(state.pillCount);
                    setDraft(state.text);
                    // Typing (or pasting) exits history-recall mode and
                    // revives a dismissed slash menu; the dock's own
                    // rewrites (recall itself) don't count.
                    if (
                      !rewritingRef.current &&
                      state.text !== draftRef.current
                    ) {
                      setRecall(null);
                      setSlashDismissed(false);
                    }
                  }}
                  onKeyDown={onKeyDown}
                  onPaste={onComposerPaste}
                  onOpenTab={
                    onOpenSurface
                      ? (key) => onOpenSurface(key, "tab")
                      : undefined
                  }
                  maxPills={MAX_ATTACHMENTS}
                  placeholder={
                    accepts.length > 0
                      ? composerPlaceholder
                      : `${composerPlaceholder.replace(/…$/, "")} (text only)…`
                  }
                  ariaLabel="Message the assistant"
                />
                {/* Context ring (ADR 0057): quiet until a harness reports
                    occupancy and window size; danger red past 90%. */}
                <ContextMeter messages={chat.messages} />
                <ShortcutHint
                  label={chat.isWorking ? "Queue (⌘↵ sends now)" : "Send"}
                  shortcut="↵"
                >
                  <button
                    type="submit"
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent-fg transition-opacity duration-150 disabled:opacity-35"
                    disabled={!draft.trim() && pillCount === 0}
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
      <Modal
        open={connectionsOpen}
        onClose={() => setConnectionsOpen(false)}
        width={560}
        labelledBy="environment-connections-title"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2
              id="environment-connections-title"
              className="text-sm font-semibold"
            >
              Environment connections
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">{activeEnvironment}</p>
          </div>
          <button
            type="button"
            onClick={() => setConnectionsOpen(false)}
            className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        {activeEnvironment && (
          <EnvironmentConnections
            projectId={projectId}
            environment={activeEnvironment}
            onOpenLink={(url) =>
              onLinkClick?.(url, { metaKey: true, shiftKey: false })
            }
          />
        )}
      </Modal>
    </div>
  );
}
