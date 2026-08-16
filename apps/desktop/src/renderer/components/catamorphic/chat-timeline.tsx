"use client";

import type { AgentMessage, QueuedAgentMessage } from "@catamorphic/react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronRight,
  ChevronUp,
  ClipboardType,
  FileText,
  GitFork,
  KeyRound,
  Link2,
  LoaderCircle,
  Pencil,
  Radio,
  RotateCcw,
  SquareTerminal,
  TextQuote,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ShortcutHint } from "../shortcut-hint";

const REMARK_PLUGINS = [remarkGfm];

export type ChatTextSourceView =
  | { type: "paste" }
  | {
      type: "selection";
      filePath: string;
      startLine?: number;
      endLine?: number;
    }
  | { type: "url"; url: string }
  | { type: "path"; path: string };

export type ChatAttachmentView =
  | {
      kind: "image" | "document";
      name: string;
      mediaType: string;
      dataBase64: string;
    }
  | {
      /** Text context: a paste, editor selection, URL, or file path. */
      kind: "text";
      name: string;
      text: string;
      source: ChatTextSourceView;
    };

export interface ChatTimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: unknown;
  attachments?: ChatAttachmentView[];
}

/**
 * Sent as the ask_user tool result when the user dismisses the question
 * panel. The timeline recognizes it by content and renders a muted note
 * instead of a user bubble.
 */
export const QUESTIONS_DISMISSED_MESSAGE =
  "The user dismissed these questions without answering them. Continue without their input, using your best judgment.";

export interface AgentQuestionOption {
  label: string;
  description: string;
}

export interface AgentQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

export interface ChatTimelineProps {
  /** Persisted + optimistic messages, in order. */
  messages: ChatTimelineMessage[];
  /** Live activity line ("Thinking...", tool progress) shown under messages. */
  activity?: string;
  /** @deprecated superseded by `queue`; kept for simple hosts. */
  queuedCount?: number;
  /** Messages waiting behind the in-flight turn (editable until sent). */
  queue?: QueuedAgentMessage[];
  onUpdateQueued?: (id: string, content: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** Promote a queued message: front of the line + interrupt the turn. */
  onSendQueuedNow?: (id: string) => void;
  /** A queued message entered/left inline editing (null = none). */
  onHoldQueued?: (id: string | null) => void;
  /** Re-run the last failed turn in place. */
  onRetry?: () => void;
  /**
   * Re-connect the agent's account (auth failures). Only offered when the
   * host can actually run a login flow for the current agent.
   */
  onReauth?: () => void;
  reauthLabel?: string;
  error?: string | null;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  /** Names an agent id (agent-change markers); falls back to the id. */
  resolveAgentName?: (agentId: string) => string | undefined;
  onLinkClick?: (
    url: string,
    modifiers: { metaKey: boolean; shiftKey: boolean },
  ) => void;
  /**
   * A file path in the turn-step log was clicked ("Edited docs/plan.md").
   * Hosts open the file in an editor surface; without it the rows stay
   * inert text.
   */
  onFileClick?: (path: string) => void;
  /**
   * Icon URL for a tool name (MCP tools are `server/tool`; the host maps
   * the server key to its connector icon). Undefined → generic glyph.
   */
  resolveToolIcon?: (toolName: string) => string | undefined;
  /**
   * Fork the conversation from an assistant message (hover action on the
   * message). The host opens the fork as its own chat surface.
   */
  onFork?: (messageId: string) => void;
  /**
   * Hands the host the "jump to my previous message" scroll action, so a
   * composer shortcut (PageUp) triggers the same move as the button.
   */
  registerJumpToPreviousUserMessage?: (jump: () => void) => void;
}

/**
 * Presentational conversation log: message bubbles (user right, agent left
 * — no name tags), media attachments, agent/effort change markers, error
 * cards with recovery actions, the editable outgoing queue, live activity,
 * stick-to-bottom scrolling. Owns no chat state — feed it from
 * `useAgentChat` (see `AgentChat`) or any other source.
 */
export function ChatTimeline({
  messages,
  activity,
  queuedCount = 0,
  queue,
  onUpdateQueued,
  onRemoveQueued,
  onSendQueuedNow,
  onHoldQueued,
  onRetry,
  onReauth,
  reauthLabel,
  error,
  emptyState = "Ask the agent to build or change your project.",
  className = "",
  contentClassName = "",
  resolveAgentName,
  onLinkClick,
  onFileClick,
  resolveToolIcon,
  onFork,
  registerJumpToPreviousUserMessage,
}: ChatTimelineProps) {
  const lastConversationId = [...messages]
    .reverse()
    .find((message) => message.role !== "system")?.id;
  const hasUserMessages = messages.some(
    (message) =>
      message.role === "user" &&
      message.content !== QUESTIONS_DISMISSED_MESSAGE,
  );
  // Retry re-runs the conversation's last user turn; a timeline with no
  // user turn at all has nothing to re-run (the button would be dead).
  const hasRetryableTurn = messages.some((message) => message.role === "user");
  return (
    <StickToBottom
      className={`relative overflow-hidden ${className}`}
      initial="smooth"
      resize="smooth"
      role="log"
    >
      <StickToBottom.Content
        className={`flex min-h-full flex-col gap-3 p-5 ${contentClassName}`}
      >
        {messages.length === 0 && !activity && (
          <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
            {emptyState}
          </div>
        )}
        {(() => {
          const keys = timelineKeys(messages);
          return messages.map((message, index) => (
            <Message
              key={keys[index]}
              message={message}
              isLast={message.id === lastConversationId}
              resolveAgentName={resolveAgentName}
              onLinkClick={onLinkClick}
              onFileClick={onFileClick}
              resolveToolIcon={resolveToolIcon}
              // Retry re-runs the last user turn; without one there is
              // nothing to re-run — hide the button, never show a dead one.
              onRetry={hasRetryableTurn ? onRetry : undefined}
              onReauth={onReauth}
              reauthLabel={reauthLabel}
              onFork={onFork}
            />
          ));
        })()}
        {activity && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            <span className="animate-pulse">{activity}</span>
            {!queue && queuedCount > 0 && (
              <span className="ml-auto text-fg-faint">
                {queuedCount} queued
              </span>
            )}
          </div>
        )}
        {queue && queue.length > 0 && (
          <QueueList
            queue={queue}
            onUpdate={onUpdateQueued}
            onRemove={onRemoveQueued}
            onSendNow={onSendQueuedNow}
            onHold={onHoldQueued}
          />
        )}
        {error && (
          <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
      </StickToBottom.Content>
      {hasUserMessages && (
        <JumpToPreviousUserMessage
          register={registerJumpToPreviousUserMessage}
        />
      )}
      <ScrollToLatest />
    </StickToBottom>
  );
}

/**
 * Walks the conversation upward one user message per click: each press
 * scrolls the nearest user message above the current view to the top —
 * where its answer starts. The everyday use: "what did I even ask?"
 * while multitasking. PageUp in the composer triggers the same move.
 */
function JumpToPreviousUserMessage({
  register,
}: {
  register?: (jump: () => void) => void;
}) {
  const { scrollRef, contentRef, isAtBottom } = useStickToBottomContext();
  // A chat short enough to see whole needs no jump affordance; watch both
  // the scroller and its content so the button appears the moment the
  // conversation outgrows the viewport (and goes away if it shrinks).
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const measure = () =>
      setScrollable(scroller.scrollHeight > scroller.clientHeight + 16);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollRef, contentRef]);
  const jump = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const targets = [
      ...content.querySelectorAll<HTMLElement>("[data-user-message]"),
    ];
    if (targets.length === 0) return;
    const viewTop = scroller.getBoundingClientRect().top;
    // The nearest user message strictly above the view top; from the
    // bottom of the chat the first press lands on the newest one.
    const above = targets.filter(
      (element) => element.getBoundingClientRect().top < viewTop - 8,
    );
    const target = above.at(-1) ?? targets.at(-1);
    if (!target) return;
    const offset = target.getBoundingClientRect().top - viewTop;
    if (above.length === 0 && offset <= 8) return; // already at the oldest
    scroller.scrollTo({
      top: scroller.scrollTop + offset - 12,
      behavior: "smooth",
    });
  }, [scrollRef, contentRef]);

  useEffect(() => {
    register?.(jump);
  }, [register, jump]);

  if (!scrollable) return null;
  return (
    <ShortcutHint label="Jump to your previous message" shortcut="⇞">
      <button
        type="button"
        className={`absolute bottom-4 grid size-8 place-items-center rounded-full border border-border-strong bg-bg-overlay text-fg shadow-xl transition-[right] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          isAtBottom ? "right-4" : "right-14"
        }`}
        onClick={jump}
        aria-label="Jump to your previous message"
        data-testid="chat-jump-previous"
      >
        <ArrowUp className="size-4" />
      </button>
    </ShortcutHint>
  );
}

/**
 * Content-position identity instead of message.id: when an optimistic user
 * message is replaced by its persisted twin, the id flips (uuid → db id) but
 * the rendered content is identical. A content-based key keeps the same DOM
 * node, so the settle is invisible instead of a remount (fade-in replay).
 *
 * The content is HASHED (cached per message object): using the raw text
 * as the React key made key comparison itself scale with transcript
 * bytes, and the old per-message occurrence scan was O(n²).
 */
const contentHashCache = new WeakMap<object, string>();

function contentHash(message: ChatTimelineMessage): string {
  const cached = contentHashCache.get(message);
  if (cached !== undefined) return cached;
  let hash = 0;
  const text = message.content;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  const result = `${text.length.toString(36)}:${(hash >>> 0).toString(36)}`;
  contentHashCache.set(message, result);
  return result;
}

/** One pass over the list; duplicate contents get occurrence suffixes. */
function timelineKeys(messages: ChatTimelineMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const base = `${message.role}:${contentHash(message)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}:${occurrence}`;
  });
}

/**
 * Memoized on data props only: persisted messages never change content
 * (react-query's structural sharing keeps their object identity stable),
 * so a 500ms streaming poll re-renders just the tail instead of
 * re-parsing every message's markdown. Handler props are deliberately
 * excluded from the comparison — hosts recreate those closures every
 * render, but their behavior is stable across renders.
 */
const Message = memo(
  MessageImpl,
  (previous, next) =>
    // System (marker) rows always re-render: their text derives from
    // resolveAgentName, whose roster resolves asynchronously — freezing
    // them shows "Switched to another agent" forever. They're plain
    // one-line rows; re-rendering them is free.
    next.message.role !== "system" &&
    previous.message === next.message &&
    previous.isLast === next.isLast &&
    previous.reauthLabel === next.reauthLabel,
);

function MessageImpl({
  message,
  isLast,
  resolveAgentName,
  onLinkClick,
  onFileClick,
  resolveToolIcon,
  onRetry,
  onReauth,
  reauthLabel,
  onFork,
}: {
  message: ChatTimelineMessage;
  isLast: boolean;
  resolveAgentName?: (agentId: string) => string | undefined;
  onLinkClick?: ChatTimelineProps["onLinkClick"];
  onFileClick?: (path: string) => void;
  resolveToolIcon?: (toolName: string) => string | undefined;
  onRetry?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
  onFork?: (messageId: string) => void;
}) {
  const metadata = asRecord(message.metadata);
  const [entered, setEntered] = useState(false);

  // Double rAF: the first frame aligns with the commit, the second
  // guarantees the browser resolved the hidden pose before it flips —
  // a single rAF can fire before the mount frame ever paints (React
  // flushes effects pre-paint under load, e.g. the 500ms streaming
  // poll), collapsing both poses into one style recalc and skipping
  // the entrance transition entirely.
  useEffect(() => {
    let second: number | undefined;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
    };
  }, []);

  // Agent/effort switches render as a centered divider, not a message.
  const marker = asRecord(metadata?.marker);
  if (message.role === "system" && marker) {
    const text =
      marker.kind === "agent_change" && typeof marker.agentId === "string"
        ? `Switched to ${resolveAgentName?.(marker.agentId) ?? "another agent"}`
        : message.content;
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-fg-faint">
        <span className="h-px flex-1 bg-border" />
        <span>{text}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (
    message.role === "user" &&
    message.content === QUESTIONS_DISMISSED_MESSAGE
  ) {
    return (
      <div className="text-center text-xs italic text-fg-faint">
        Questions dismissed
      </div>
    );
  }

  const attachments = message.attachments ?? attachmentsFromMetadata(metadata);
  const failed = metadata?.status === "failed";
  const enterClasses = `motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"}`;

  // Failed turns render as an error card with recovery actions (the
  // actions only on the latest message — older failures are history).
  if (message.role === "assistant" && failed) {
    if (metadata?.interrupted === true) {
      // An interrupted turn keeps whatever it had said (partial text, or
      // the orphaned-turn explanation) and closes with a quiet divider —
      // it's a user action, not a failure worth a red card.
      const partial = message.content.trim();
      const showPartial = partial && !/^interrupted\.?$/i.test(partial);
      return (
        <div className={`flex flex-col gap-2 ${enterClasses}`}>
          {showPartial && (
            <article className="mr-auto max-w-[85%] whitespace-pre-wrap break-words text-sm leading-6">
              {partial}
            </article>
          )}
          <div className="text-center text-xs italic text-fg-faint">
            Interrupted
          </div>
        </div>
      );
    }
    return (
      <ErrorCard
        message={message}
        actionable={isLast}
        onRetry={onRetry}
        onReauth={onReauth}
        reauthLabel={reauthLabel}
        className={enterClasses}
      />
    );
  }

  return (
    <article
      data-user-message={message.role === "user" || undefined}
      className={`group/msg relative max-w-[85%] text-sm ${enterClasses} ${message.role === "user" ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2" : "mr-auto"}`}
    >
      {attachments.length > 0 && <AttachmentStrip attachments={attachments} />}
      {/* Fork the conversation from this reply: everything up to here is
          copied into a new chat that goes off on a tangent. */}
      {/* The pl-2 bridges the gap between the message edge and the
          button: without it the pointer leaves the group mid-crossing
          and the reveal fades out and back in — a visible blink. */}
      {message.role === "assistant" && onFork && (
        <span className="absolute -right-8 bottom-0 pl-2 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100">
          <ShortcutHint label="Fork the chat from here">
            <button
              type="button"
              onClick={() => onFork(message.id)}
              className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              aria-label="Fork the conversation from this message"
              data-testid="chat-fork"
            >
              <GitFork className="size-3" />
            </button>
          </ShortcutHint>
        </span>
      )}
      {message.role === "assistant" && (
        <TurnSteps
          steps={turnSteps(message)}
          resolveToolIcon={resolveToolIcon}
          onFileClick={onFileClick}
        />
      )}
      {message.role === "user" ? (
        <div className="whitespace-pre-wrap break-words leading-6">
          {message.content}
        </div>
      ) : (
        <div className="cat-markdown min-w-0 break-words leading-6">
          <Markdown
            remarkPlugins={REMARK_PLUGINS}
            components={
              onLinkClick
                ? {
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(event) => {
                          event.preventDefault();
                          if (href) {
                            onLinkClick(href, {
                              metaKey: event.metaKey,
                              shiftKey: event.shiftKey,
                            });
                          }
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }
                : undefined
            }
          >
            {message.content}
          </Markdown>
        </div>
      )}
    </article>
  );
}

/** One row of a turn's expandable event log. */
interface TurnStep {
  kind: "command" | "file_edit" | "tool" | "subagent" | "background";
  /** Row header — the technical detail lives here, not on the live line. */
  label: string;
  /** Monospace label (commands, paths, unrecognized tool names). */
  mono?: boolean;
  /** Edited file path — makes the row a click-through to the editor. */
  filePath?: string;
  /** Tool name as the harness reported it (`server/tool` for MCP). */
  toolName?: string;
  /** Preformatted expandable body (tool input/result, full command). */
  detail?: string;
}

const STEP_ICONS = {
  command: SquareTerminal,
  file_edit: Pencil,
  tool: Wrench,
  subagent: Bot,
  background: Radio,
} as const;

/**
 * Friendly step labels for well-known tools, harness-neutral: Claude
 * Code's built-ins (Read, WebSearch, …), the built-in agent's lowercase
 * kin (read, websearch, …), and the desktop's workspace tools (identical
 * names on every harness). MCP tools arrive as "server/tool" and render
 * as "tool (server)"; anything else falls back to its raw name in mono.
 */
const TOOL_STEP_LABELS: Record<string, string> = {
  // Questions and plans.
  AskUserQuestion: "Asked you a question",
  ask_user: "Asked you a question",
  TodoWrite: "Updated the plan",
  // Reading and searching the project.
  Read: "Read files",
  read: "Read files",
  Glob: "Searched files",
  Grep: "Searched files",
  // The web.
  WebSearch: "Searched the web",
  websearch: "Searched the web",
  WebFetch: "Fetched a page",
  webfetch: "Fetched a page",
  // Delegation, skills, and background work.
  Task: "Ran a subagent",
  Agent: "Ran a subagent",
  Skill: "Used a skill",
  SlashCommand: "Ran a slash command",
  TaskOutput: "Checked a background task",
  BashOutput: "Checked a background task",
  TaskStop: "Stopped a background task",
  KillShell: "Stopped a background task",
  // Workspace tools (the host bridge; same names on every harness).
  run_terminal: "Ran a command",
  read_terminal: "Read the terminal",
  write_terminal: "Typed into the terminal",
  workspace_overview: "Looked at the workspace",
  read_tab: "Read a tab",
  open_browser: "Opened a page",
  browser_snapshot: "Looked at the page",
  browser_act: "Acted on the page",
  surface_control: "Managed a surface",
  open_surface: "Showed you something",
  point_at: "Pointed at something",
  clear_pointers: "Stopped pointing",
  build_app: "Built an app",
  sync_project: "Synced the project",
  create_pull_request: "Opened a pull request",
};

/**
 * Bookkeeping calls, not work the reader cares about — the title/icon
 * change is already visible on the chat itself.
 */
const HIDDEN_STEP_TOOLS = new Set(["set_title", "set_chat_icon"]);

/** Human header for a tool step; mono marks an unrecognized raw name. */
function toolStepLabel(toolName: string): { label: string; mono: boolean } {
  const known = TOOL_STEP_LABELS[toolName];
  if (known) return { label: known, mono: false };
  const slash = toolName.indexOf("/");
  if (slash > 0) {
    return {
      label: `${toolName.slice(slash + 1)} (${toolName.slice(0, slash)})`,
      mono: false,
    };
  }
  return { label: toolName, mono: true };
}

/** Cap for a step's expanded body; full payloads can be megabytes. */
const STEP_DETAIL_MAX = 6_000;

function stepDetailText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text === "{}") return undefined;
  return text.length > STEP_DETAIL_MAX
    ? `${text.slice(0, STEP_DETAIL_MAX)}\n… truncated`
    : text;
}

/**
 * The turn's steps, from the persisted per-message event log
 * (`metadata.events`). The chat keeps its prose calm — this is where the
 * full commands, file paths, and tool payloads live, on demand.
 */
function turnSteps(message: ChatTimelineMessage): TurnStep[] {
  const events = asRecord(message.metadata)?.events;
  if (!Array.isArray(events)) return [];
  const steps: TurnStep[] = [];
  for (const entry of events) {
    const event = asRecord(entry);
    if (!event) continue;
    const content = typeof event.content === "string" ? event.content : "";
    const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
    if (event.type === "command") {
      steps.push({
        kind: "command",
        label: `$ ${firstLine || "(command)"}`,
        mono: true,
        detail: stepDetailText(
          [
            content.includes("\n") ? content : undefined,
            stepDetailText(event.toolResult),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      });
    } else if (event.type === "file_edit") {
      const path = typeof event.filePath === "string" ? event.filePath : "";
      steps.push({
        kind: "file_edit",
        label: `Edited ${path || "a file"}`,
        mono: true,
        filePath: path || undefined,
      });
    } else if (event.type === "tool_call") {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "tool";
      if (HIDDEN_STEP_TOOLS.has(toolName)) continue;
      const pretty = toolStepLabel(toolName);
      const input = stepDetailText(event.toolInput);
      const result = stepDetailText(event.toolResult);
      steps.push({
        kind: "tool",
        label: pretty.label,
        mono: pretty.mono,
        toolName,
        detail: stepDetailText(
          [input && `Input:\n${input}`, result && `Result:\n${result}`]
            .filter(Boolean)
            .join("\n\n"),
        ),
      });
    } else if (event.type === "subagent" && event.status !== "ended") {
      steps.push({
        kind: "subagent",
        label: `Subagent: ${firstLine || "delegated work"}`,
      });
    } else if (event.type === "background" && event.status !== "ended") {
      steps.push({
        kind: "background",
        label: `Background: ${firstLine || "process"}`,
      });
    }
  }
  return steps;
}

/**
 * The expandable event log under an assistant reply: collapsed to a muted
 * "N steps" line; expanded, each step is a row that itself stays collapsed
 * (payloads are long and technical) until clicked. MCP tool rows show the
 * connector's icon when the host can resolve one.
 */
function TurnSteps({
  steps,
  resolveToolIcon,
  onFileClick,
}: {
  steps: TurnStep[];
  resolveToolIcon?: (toolName: string) => string | undefined;
  onFileClick?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className="mb-1.5" data-testid="chat-turn-steps">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex cursor-pointer items-center gap-1 text-[11px] text-fg-faint transition-colors duration-100 hover:text-fg-muted"
        aria-expanded={expanded}
        data-testid="chat-turn-steps-toggle"
      >
        <ChevronRight
          className={`size-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        {steps.length === 1 ? "1 step" : `${steps.length} steps`}
      </button>
      {/* Grid-rows tween (the SidebarSection pattern): the list stays
          mounted, so the collapse mirrors the expansion exactly. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2.5">
            {steps.map((step, index) => (
              <StepRow
                // Steps are append-only within a message; index is stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: static list
                key={index}
                step={step}
                iconUrl={
                  step.toolName ? resolveToolIcon?.(step.toolName) : undefined
                }
                onFileClick={onFileClick}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepRow({
  step,
  iconUrl,
  onFileClick,
}: {
  step: TurnStep;
  iconUrl?: string;
  onFileClick?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICONS[step.kind];
  const expandable = Boolean(step.detail);
  // Edited-file rows click through to the file in an editor surface.
  const opensFile = Boolean(step.filePath && onFileClick);
  const interactive = expandable || opensFile;
  return (
    <div data-testid="chat-step">
      <button
        type="button"
        onClick={
          opensFile
            ? () => onFileClick?.(step.filePath as string)
            : expandable
              ? () => setOpen((value) => !value)
              : undefined
        }
        className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-muted ${
          interactive
            ? "cursor-pointer transition-colors duration-100 hover:bg-bg-inset hover:text-fg"
            : "cursor-default"
        }`}
        aria-expanded={expandable ? open : undefined}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-fg-faint" />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${step.mono ? "font-mono" : ""}`}
        >
          {step.label}
        </span>
        {expandable && (
          <ChevronRight
            className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {/* Same grid-rows tween as the step list: payloads animate open and
          closed instead of popping in and out. */}
      {step.detail && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <pre
              className="mb-1 ml-6 mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted"
              data-testid="chat-step-detail"
            >
              {step.detail}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Image thumbnails and document chips on a (user) message. */
function AttachmentStrip({
  attachments,
}: {
  attachments: ChatAttachmentView[];
}) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment, index) =>
        attachment.kind === "text" ? (
          <SentTextPill
            // Attachments are append-only per message; index is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: static list
            key={index}
            attachment={attachment}
          />
        ) : attachment.kind === "image" ? (
          <img
            key={`${attachment.name}:${attachment.dataBase64.length}:${attachment.dataBase64.slice(-24)}`}
            src={`data:${attachment.mediaType};base64,${attachment.dataBase64}`}
            alt={attachment.name}
            className="max-h-40 max-w-56 rounded-lg border border-border object-cover"
          />
        ) : (
          <span
            key={`${attachment.name}:${attachment.dataBase64.length}:${attachment.dataBase64.slice(-24)}`}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-inset px-2 py-1 text-[11px] text-fg-muted"
          >
            <FileText className="size-3" />
            <span className="max-w-40 truncate">{attachment.name}</span>
          </span>
        ),
      )}
    </div>
  );
}

/**
 * A failed turn: the friendly explanation plus whatever gets the user
 * unstuck — Retry (in place, no re-typing), a re-connect flow for auth
 * failures, and the auto-retry countdown for transient provider trouble.
 */
function ErrorCard({
  message,
  actionable,
  onRetry,
  onReauth,
  reauthLabel,
  className,
}: {
  message: ChatTimelineMessage;
  actionable: boolean;
  onRetry?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
  className?: string;
}) {
  const metadata = asRecord(message.metadata);
  const kind =
    typeof metadata?.errorKind === "string" ? metadata.errorKind : undefined;
  const autoRetry = asRecord(metadata?.autoRetry);
  const nextAtMs =
    typeof autoRetry?.nextAtMs === "number" ? autoRetry.nextAtMs : undefined;
  return (
    <article
      className={`mr-auto max-w-[85%] rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm ${className ?? ""}`}
      data-testid="chat-error-card"
    >
      <div className="whitespace-pre-wrap break-words leading-6 text-fg">
        {message.content}
      </div>
      {actionable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 py-1 text-xs font-medium text-fg transition-colors duration-100 hover:border-border-strong"
              data-testid="chat-retry"
            >
              <RotateCcw className="size-3" />
              {nextAtMs ? "Retry now" : "Retry"}
            </button>
          )}
          {kind === "auth" && onReauth && (
            <button
              type="button"
              onClick={onReauth}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-opacity duration-100 hover:opacity-90"
              data-testid="chat-reauth"
            >
              <KeyRound className="size-3" />
              {reauthLabel ?? "Reconnect"}
            </button>
          )}
          {nextAtMs !== undefined && <AutoRetryCountdown nextAtMs={nextAtMs} />}
        </div>
      )}
    </article>
  );
}

/** "Retrying in Ns" that live-ticks; flips to a spinner when due. */
function AutoRetryCountdown({ nextAtMs }: { nextAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((nextAtMs - now) / 1000));
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-fg-muted"
      data-testid="chat-auto-retry"
    >
      <LoaderCircle className="size-3 animate-spin" />
      {seconds > 0 ? `Retrying in ${seconds}s` : "Retrying…"}
    </span>
  );
}

/** How many queued messages stay visible while collapsed. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

/**
 * The outgoing queue, rendered at the end of the chat as ghost bubbles:
 * dashed, right-aligned, each editable (which pauses its dispatch),
 * deletable, or promotable ("send now" interrupts the running turn). Long
 * queues collapse behind a "N queued" toggle.
 */
function QueueList({
  queue,
  onUpdate,
  onRemove,
  onSendNow,
  onHold,
}: {
  queue: QueuedAgentMessage[];
  onUpdate?: (id: string, content: string) => void;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onHold?: (id: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && queue.length > QUEUE_COLLAPSE_THRESHOLD;
  const visible = collapsed ? queue.slice(0, 1) : queue;
  const hidden = queue.length - visible.length;
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="chat-queue">
      {visible.map((queued) => (
        <QueuedBubble
          key={queued.id}
          queued={queued}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onSendNow={onSendNow}
          onHold={onHold}
        />
      ))}
      {queue.length > QUEUE_COLLAPSE_THRESHOLD && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex cursor-pointer items-center gap-1 rounded-full border border-border bg-bg-inset px-2.5 py-1 text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg"
          aria-expanded={!collapsed}
          data-testid="chat-queue-toggle"
        >
          {collapsed ? `+${hidden} more queued` : "Collapse queue"}
          <ChevronUp
            className={`size-3 transition-transform duration-150 ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
      )}
    </div>
  );
}

function QueuedBubble({
  queued,
  onUpdate,
  onRemove,
  onSendNow,
  onHold,
}: {
  queued: QueuedAgentMessage;
  onUpdate?: (id: string, content: string) => void;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onHold?: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(queued.content);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Refs, not deps: the callbacks are re-created every host render, and an
  // effect keyed on them would run its cleanup constantly — releasing the
  // hold the moment it was taken.
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
  const editingRef = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);
  // True unmount only: if this bubble disappears mid-edit, never leave the
  // queue paused — but don't touch holds owned by other bubbles.
  useEffect(
    () => () => {
      if (editingRef.current) onHoldRef.current?.(null);
    },
    [],
  );

  const beginEdit = () => {
    setDraft(queued.content);
    setEditing(true);
    editingRef.current = true;
    onHold?.(queued.id);
  };
  const commitEdit = () => {
    setEditing(false);
    editingRef.current = false;
    const content = draft.trim();
    if (content && content !== queued.content) {
      onUpdate?.(queued.id, content);
    }
    onHold?.(null);
  };
  const remove = () => {
    // Animate out, then actually delete.
    setLeaving(true);
    if (editingRef.current) {
      editingRef.current = false;
      onHold?.(null);
    }
    window.setTimeout(() => onRemove?.(queued.id), 160);
  };

  const shown = entered && !leaving;
  return (
    <div
      className={`group/queued relative max-w-[85%] motion-safe:transition-[opacity,translate,scale] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0"}`}
      data-testid="chat-queued-message"
    >
      <div className="rounded-xl rounded-br-sm border border-dashed border-info/40 bg-info/5 px-3 py-2 text-sm text-fg-muted">
        {editing ? (
          <textarea
            ref={editRef}
            className="field-sizing-content w-full min-w-48 resize-none bg-transparent leading-6 text-fg outline-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitEdit();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(queued.content);
                setEditing(false);
                editingRef.current = false;
                onHold?.(null);
              }
            }}
            aria-label="Edit queued message"
            data-testid="chat-queued-edit"
          />
        ) : (
          <div className="whitespace-pre-wrap break-words leading-6">
            {queued.content}
          </div>
        )}
        {queued.attachments.length > 0 && (
          <div className="mt-1 text-[11px] text-fg-faint">
            {queued.attachments.length} attachment
            {queued.attachments.length > 1 ? "s" : ""}
          </div>
        )}
        <div className="mt-1 flex items-center justify-end gap-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
          Queued
          <span className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100">
            {!editing && (
              <ShortcutHint label="Edit before it sends">
                <button
                  type="button"
                  onClick={beginEdit}
                  className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                  aria-label="Edit queued message"
                >
                  <Pencil className="size-3" />
                </button>
              </ShortcutHint>
            )}
            <ShortcutHint label="Delete from queue">
              <button
                type="button"
                onClick={remove}
                className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-danger"
                aria-label="Delete queued message"
                data-testid="chat-queued-delete"
              >
                <Trash2 className="size-3" />
              </button>
            </ShortcutHint>
            <ShortcutHint label="Send now (interrupts the agent)">
              <button
                type="button"
                onClick={() => onSendNow?.(queued.id)}
                className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-accent"
                aria-label="Send queued message now"
                data-testid="chat-queued-send-now"
              >
                <Zap className="size-3" />
              </button>
            </ShortcutHint>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Derive the visible timeline from raw agent-session messages: hides
 * in-progress assistant placeholders and surfaces them as an activity line.
 * When the latest assistant message is awaiting user input, its parsed
 * questions are exposed so hosts can render an answer UI.
 */
export function toTimeline(
  persisted: AgentMessage[],
  optimistic: ChatTimelineMessage[],
  isSending: boolean,
): {
  messages: ChatTimelineMessage[];
  activity: string | undefined;
  questions: AgentQuestion[] | undefined;
} {
  const messages = [...persisted, ...optimistic].filter(isConversationMessage);
  const pending = latestPendingAssistant(persisted);
  const activity =
    pending !== undefined
      ? calmActivity(pending.content)
      : isSending && optimistic.length > 0
        ? "Thinking..."
        : undefined;
  return { messages, activity, questions: pendingQuestions(persisted) };
}

/**
 * The live activity line shows only calm verbs ("Working...", "Editing
 * files..."). If a host streams the upcoming message's body into the
 * in-progress row, echoing it here would show the same words twice — once
 * faded beside the spinner, then again as the message itself — so
 * message-shaped content falls back to a generic verb.
 */
function calmActivity(content: string | null | undefined): string {
  const text = (content ?? "").trim();
  if (!text) return "Thinking...";
  if (text.includes("\n") || text.length > 80) return "Working...";
  return text;
}

/**
 * Questions from the latest assistant turn, but only while they are still
 * unanswered — i.e. the awaiting-input assistant message is the last one.
 */
function pendingQuestions(
  persisted: AgentMessage[],
): AgentQuestion[] | undefined {
  const last = persisted.at(-1);
  if (last?.role !== "assistant") return undefined;
  const metadata = asRecord(last.metadata);
  if (metadata?.status !== "awaiting_input") return undefined;
  const raw = metadata.questions;
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((entry): AgentQuestion[] => {
    const question = asRecord(entry);
    if (typeof question?.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): AgentQuestionOption[] => {
          const record = asRecord(option);
          return typeof record?.label === "string"
            ? [
                {
                  label: record.label,
                  description:
                    typeof record.description === "string"
                      ? record.description
                      : "",
                },
              ]
            : [];
        })
      : [];
    return [
      {
        question: question.question,
        header:
          typeof question.header === "string" && question.header.length > 0
            ? question.header
            : "Question",
        multiSelect: question.multiSelect === true,
        options,
      },
    ];
  });
  return questions.length > 0 ? questions : undefined;
}

function latestPendingAssistant(
  messages: AgentMessage[],
): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return asRecord(message.metadata)?.status === "in_progress"
        ? message
        : undefined;
    }
  }
  return undefined;
}

function isConversationMessage(message: ChatTimelineMessage): boolean {
  if (message.role === "system") {
    // Only marker rows render; other system rows are plumbing.
    return asRecord(asRecord(message.metadata)?.marker) !== undefined;
  }
  if (message.role !== "assistant") return true;
  if (asRecord(message.metadata)?.status === "in_progress") return false;
  // Question-only turns have no prose; the question panel is the content.
  return message.content.trim().length > 0;
}

const SENT_PILL_ICONS = {
  paste: ClipboardType,
  selection: TextQuote,
  url: Link2,
  path: FileText,
} as const;

/** A sent text pill: collapsed label, expandable to the full text. */
function SentTextPill({
  attachment,
}: {
  attachment: Extract<ChatAttachmentView, { kind: "text" }>;
}) {
  const [open, setOpen] = useState(false);
  const Icon = SENT_PILL_ICONS[attachment.source.type];
  const isReference =
    attachment.source.type === "url" || attachment.source.type === "path";
  return (
    <div className="min-w-0 max-w-full" data-testid="sent-text-pill">
      <button
        type="button"
        onClick={isReference ? undefined : () => setOpen((value) => !value)}
        title={isReference ? attachment.text : undefined}
        className={`flex max-w-full items-center gap-1.5 rounded-md border border-border bg-bg-inset px-2 py-1 text-[11px] text-fg-muted ${
          isReference
            ? "cursor-default"
            : "cursor-pointer transition-colors duration-100 hover:bg-bg-overlay hover:text-fg"
        }`}
        aria-expanded={isReference ? undefined : open}
      >
        <Icon className="size-3 shrink-0" />
        <span className="max-w-56 truncate">{attachment.name}</span>
        {!isReference && (
          <ChevronRight
            className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {!isReference && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <pre className="mt-1 max-h-56 max-w-md overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 text-left font-mono text-[11px] leading-4 text-fg-muted">
              {attachment.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function textSourceFromMetadata(value: unknown): ChatTextSourceView | null {
  const record = asRecord(value);
  switch (record?.type) {
    case "paste":
      return { type: "paste" };
    case "selection":
      return typeof record.filePath === "string"
        ? {
            type: "selection",
            filePath: record.filePath,
            ...(typeof record.startLine === "number"
              ? { startLine: record.startLine }
              : {}),
            ...(typeof record.endLine === "number"
              ? { endLine: record.endLine }
              : {}),
          }
        : null;
    case "url":
      return typeof record.url === "string"
        ? { type: "url", url: record.url }
        : null;
    case "path":
      return typeof record.path === "string"
        ? { type: "path", path: record.path }
        : null;
    default:
      return null;
  }
}

function attachmentsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ChatAttachmentView[] {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ChatAttachmentView[] => {
    const record = asRecord(entry);
    if (record?.kind === "text" && typeof record.text === "string") {
      const source = textSourceFromMetadata(record.source);
      return source
        ? [
            {
              kind: "text",
              name: typeof record.name === "string" ? record.name : "Text",
              text: record.text,
              source,
            } satisfies ChatAttachmentView,
          ]
        : [];
    }
    return typeof record?.dataBase64 === "string" &&
      typeof record?.mediaType === "string"
      ? [
          {
            kind: record.kind === "document" ? "document" : "image",
            name: typeof record.name === "string" ? record.name : "attachment",
            mediaType: record.mediaType,
            dataBase64: record.dataBase64,
          } satisfies ChatAttachmentView,
        ]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      className="absolute bottom-4 right-4 grid size-8 place-items-center rounded-full border border-border-strong bg-bg-overlay text-fg shadow-xl"
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      <ArrowDown className="size-4" />
    </button>
  );
}
