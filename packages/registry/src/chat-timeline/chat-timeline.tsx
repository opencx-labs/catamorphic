"use client";

import type { AgentMessage } from "@catamorphic/react";
import {
  ArrowDown,
  Bot,
  ChevronRight,
  LoaderCircle,
  Pencil,
  Radio,
  RotateCcw,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

const REMARK_PLUGINS = [remarkGfm];

export interface ChatTimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: unknown;
}

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
  /** Number of queued messages beyond the in-flight one. */
  queuedCount?: number;
  /** Re-run the last failed turn in place. */
  onRetry?: () => void;
  error?: string | null;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  /**
   * A link in an agent message was clicked. Hosts route it to their own
   * surface (e.g. an attached browser tab) instead of the anchor default.
   * Modifier state rides along so hosts can offer alternate flavors
   * (background tab, minimize-and-open, ...).
   */
  onLinkClick?: (
    url: string,
    modifiers: { metaKey: boolean; shiftKey: boolean },
  ) => void;
  /**
   * A changed-file chip was clicked. Hosts open the file (e.g. in an
   * editor surface). Without it the chips stay inert.
   */
  onFileClick?: (path: string) => void;
  /**
   * Icon URL for a tool name (MCP tools are `server/tool`; the host maps
   * the server key to its connector icon). Undefined → generic glyph.
   */
  resolveToolIcon?: (toolName: string) => string | undefined;
}

/**
 * Presentational conversation log: message bubbles, changed-file chips, live
 * activity, error banner, stick-to-bottom scrolling. Owns no chat state —
 * feed it from `useAgentChat` (see `AgentChat`) or any other source. Reused
 * by both the docked chat and full-surface chat hosts.
 */
export function ChatTimeline({
  messages,
  activity,
  queuedCount = 0,
  onRetry,
  error,
  emptyState = "Ask the agent to build or change your project.",
  className = "",
  contentClassName = "",
  onLinkClick,
  onFileClick,
  resolveToolIcon,
}: ChatTimelineProps) {
  const lastConversationId = [...messages]
    .reverse()
    .find((message) => message.role !== "system")?.id;
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
        {messages.map((message, index) => (
          <Message
            key={timelineKey(message, index, messages)}
            message={message}
            onLinkClick={onLinkClick}
            onFileClick={onFileClick}
            resolveToolIcon={resolveToolIcon}
            actionable={message.id === lastConversationId}
            onRetry={hasRetryableTurn ? onRetry : undefined}
          />
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            <span className="animate-pulse">{activity}</span>
            {queuedCount > 0 && (
              <span className="ml-auto text-fg-faint">
                {queuedCount} queued
              </span>
            )}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
      </StickToBottom.Content>
      <ScrollToLatest />
    </StickToBottom>
  );
}

/**
 * Content-position identity instead of message.id: when an optimistic user
 * message is replaced by its persisted twin, the id flips (uuid → db id) but
 * the rendered content is identical. A content-based key keeps the same DOM
 * node, so the settle is invisible instead of a remount (fade-in replay).
 */
function timelineKey(
  message: ChatTimelineMessage,
  index: number,
  messages: ChatTimelineMessage[],
): string {
  let occurrence = 0;
  for (let i = 0; i < index; i += 1) {
    const other = messages[i];
    if (other?.role === message.role && other?.content === message.content) {
      occurrence += 1;
    }
  }
  return `${message.role}:${occurrence}:${message.content}`;
}

function Message({
  message,
  onLinkClick,
  onFileClick,
  resolveToolIcon,
  actionable,
  onRetry,
}: {
  message: ChatTimelineMessage;
  onLinkClick?: (
    url: string,
    modifiers: { metaKey: boolean; shiftKey: boolean },
  ) => void;
  onFileClick?: (path: string) => void;
  resolveToolIcon?: (toolName: string) => string | undefined;
  actionable: boolean;
  onRetry?: () => void;
}) {
  const files = changedFiles(message);
  const metadata = asRecord(message.metadata);
  const [entered, setEntered] = useState(false);

  // Double rAF: the first frame aligns with the commit, the second
  // guarantees the browser resolved the hidden pose before it flips —
  // a single rAF can fire before the mount frame ever paints (React
  // flushes effects pre-paint under load, e.g. a streaming poll),
  // collapsing both poses into one style recalc and skipping the
  // entrance transition entirely.
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

  if (message.role === "assistant" && metadata?.status === "failed") {
    const partialContent =
      typeof metadata.partialContent === "string"
        ? metadata.partialContent.trim()
        : "";
    return (
      <div className="flex flex-col gap-2">
        {partialContent && (
          <article
            className="mr-auto max-w-[85%] text-sm"
            data-testid="chat-partial-response"
          >
            <div className="cat-markdown min-w-0 break-words leading-6">
              <Markdown remarkPlugins={REMARK_PLUGINS}>
                {partialContent}
              </Markdown>
            </div>
          </article>
        )}
        <article
          className="mr-auto max-w-[85%] rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm"
          data-testid="chat-error-card"
        >
          <div className="whitespace-pre-wrap break-words leading-6 text-fg">
            {message.content}
          </div>
          {actionable && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 py-1 text-xs font-medium text-fg"
              data-testid="chat-retry"
            >
              <RotateCcw className="size-3" /> Retry
            </button>
          )}
        </article>
      </div>
    );
  }

  return (
    <article
      // transition-[opacity,translate], not transform: Tailwind v4's
      // translate-y-* sets the individual `translate` property, which a
      // `transform` transition does not cover — the slide half of the
      // entrance would snap while only opacity faded.
      className={`max-w-[85%] text-sm motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"} ${message.role === "user" ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2" : "mr-auto"}`}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
        {message.role === "user" ? "You" : "Agent"}
      </div>
      {message.role === "assistant" && (
        <TurnSteps
          steps={turnSteps(message)}
          resolveToolIcon={resolveToolIcon}
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
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.map((file) =>
            onFileClick ? (
              <button
                key={file}
                type="button"
                onClick={() => onFileClick(file)}
                className="cursor-pointer rounded border border-success/50 bg-success/10 px-1.5 py-0.5 font-mono text-[11px] text-success transition-colors duration-100 hover:bg-success/20"
              >
                {file}
              </button>
            ) : (
              <code
                key={file}
                className="rounded border border-success/50 bg-success/10 px-1.5 py-0.5 text-[11px] text-success"
              >
                {file}
              </code>
            ),
          )}
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
}: {
  steps: TurnStep[];
  resolveToolIcon?: (toolName: string) => string | undefined;
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
      {/* Grid-rows tween: the list stays mounted, so the collapse mirrors
          the expansion exactly. */}
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
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepRow({ step, iconUrl }: { step: TurnStep; iconUrl?: string }) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICONS[step.kind];
  const expandable = Boolean(step.detail);
  return (
    <div data-testid="chat-step">
      <button
        type="button"
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-muted ${
          expandable
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
  if (message.role !== "assistant") return true;
  if (asRecord(message.metadata)?.status === "in_progress") return false;
  // Question-only turns have no prose; the question panel is the content.
  return message.content.trim().length > 0;
}

function changedFiles(message: ChatTimelineMessage): string[] {
  const metadata = asRecord(message.metadata);
  const changes = metadata?.changedFiles;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    const entry = asRecord(change);
    return typeof entry?.path === "string" ? [entry.path] : [];
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
