"use client";

import type {
  AssistantMessageItem,
  RuntimeRequest,
  TimelineTurn,
  Turn,
  WorkItem,
} from "@catamorphic/react";
import {
  Bell,
  Bot,
  Brain,
  ChevronRight,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestionMark,
  MessageSquareText,
  Pencil,
  Radio,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  hrefOf,
  type InputLinkModifiers,
  type SourceHref,
  sourceLabel,
  taskIcon,
  taskTone,
} from "./session-input.js";
import type { StepSource } from "./turn-rows.js";

/**
 * A background command's live state (ADR 0155): the host's view of the
 * process a `run_background_command` step started.
 */
export interface ChatBackgroundCommand {
  /** A background command, or a command watch (ADR 0156). */
  kind: "command" | "watch";
  command: string;
  description: string;
  status: "running" | "finished" | "stopped";
  exitCode: number | null;
}

/** "4s", "2m 14s", "1h 5m": how long something ran, to the second. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The current time, read again every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** One row of a turn's expandable event log. */
export interface TurnStep {
  /**
   * Its message and place in that message's log: stays with the step when
   * earlier work folds in above it, so its row is never relabeled.
   */
  key: string;
  kind:
    | "command"
    | "file_edit"
    | "tool"
    | "subagent"
    | "background"
    | "note"
    | "reasoning"
    | "plan"
    | "request"
    | "notification";
  /** Its own glyph and color (a task notification's), instead of the kind's. */
  icon?: { Icon: LucideIcon; className: string };
  /** Where its expanded detail links to: a notification's task. */
  link?: { href: string; label: string };
  /** A folded note's message id, so focus and deep links still find it. */
  messageId?: string;
  /** Notes expand to rendered Markdown instead of a preformatted payload. */
  markdown?: boolean;
  /** Row header: the technical detail lives here, not on the live line. */
  label: string;
  /** Monospace label (commands, paths, unrecognized tool names). */
  mono?: boolean;
  /** Edited file path: makes the row a click-through to the file. */
  filePath?: string;
  /** Tool name as the harness reported it (`server/tool` for MCP). */
  toolName?: string;
  /** Preformatted expandable body (tool input/result, full command). */
  detail?: string;
  /** Technical payloads use mono; host-tool summaries read as normal prose. */
  detailMono?: boolean;
  /** A background command's or watch's step: its key into the live states, and its words. */
  background?: {
    ref: string;
    kind: ChatBackgroundCommand["kind"];
    description: string;
  };
  /** The work item's own status, when the step is one. */
  status?: WorkItem["status"];
  /** When the step started and when its result arrived (epoch ms). */
  startedAt?: number;
  endedAt?: number;
  /** Its result has arrived, or it has none to wait for. */
  finished?: boolean;
  /** A step whose end is reported (every work item says when it ends). */
  awaitsEnd?: boolean;
  /** Still going: the turn runs and its result has not arrived. */
  running?: boolean;
}

const STEP_ICONS = {
  command: SquareTerminal,
  file_edit: Pencil,
  tool: Wrench,
  subagent: Bot,
  background: Radio,
  note: MessageSquareText,
  reasoning: Brain,
  plan: ListChecks,
  request: MessageCircleQuestionMark,
  notification: Bell,
} as const;

/**
 * Friendly step labels for well-known tools, harness-neutral: Claude
 * Code's built-ins (Read, WebSearch, ...), the built-in agent's lowercase
 * kin (read, websearch, ...), and Work's workspace tools (identical names
 * on every harness). MCP tools arrive as "server/tool" and render as
 * "tool (server)"; anything else falls back to its raw name in mono.
 */
const TOOL_STEP_LABELS: Record<string, string> = {
  // Questions and plans.
  AskUserQuestion: "Asked you a question",
  ask_user: "Asked you a question",
  close_questions: "Closed its questions",
  TodoWrite: "Updated the plan",
  read_todo_list: "Read the todo list",
  update_todo_list: "Updated the todo list",
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
  run_background_command: "Ran command in background",
  read_background_output: "Checked a background command",
  stop_background_command: "Stopped background work",
  watch_command: "Watched for a change",
  write_terminal: "Typed into a terminal",
  workspace_overview: "Looked at the workspace",
  read_tab: "Read a tab",
  open_browser: "Opened a page",
  browser_snapshot: "Looked at the page",
  browser_act: "Acted on the page",
  surface_control: "Managed a surface",
  open_surface: "Showed you something",
  point_at: "Pointed at something",
  build_app: "Built an app",
  sync_project: "Synced the project",
  create_pull_request: "Opened a pull request",
  list_project_sessions: "Listed project chats",
  read_project_session: "Read a project chat",
  send_project_session_message: "Messaged a project chat",
  spawn_subsession: "Started a subsession",
  wait_for_subsessions: "Waited for subsessions",
  interrupt_subsession: "Stopped a subsession",
  request_user_attention: "Requested your attention",
  set_session_activity: "Updated activity",
  list_worktrees: "Listed worktrees",
  create_worktree: "Created a worktree",
  use_worktree: "Switched worktrees",
  request_connection: "Requested a connection",
  read_skill: "Read a skill",
};

/**
 * Work's own tools: the same names on every harness, read by their own
 * name and detailed in plain words rather than as a JSON payload.
 */
const WORKSPACE_STEP_TOOLS = new Set([
  "TodoWrite",
  "list_project_sessions",
  "read_project_session",
  "send_project_session_message",
  "spawn_subsession",
  "wait_for_subsessions",
  "interrupt_subsession",
  "request_user_attention",
  "set_session_activity",
  "read_todo_list",
  "update_todo_list",
  "list_worktrees",
  "create_worktree",
  "use_worktree",
  "build_app",
  "open_surface",
  "point_at",
  "workspace_overview",
  "read_tab",
  "open_browser",
  "browser_snapshot",
  "browser_act",
  "run_background_command",
  "read_background_output",
  "stop_background_command",
  "watch_command",
  "write_terminal",
  "sync_project",
  "create_pull_request",
  "request_connection",
  "read_skill",
  "surface_control",
]);

/**
 * Bookkeeping calls, not work the reader cares about: the title and icon
 * change is already visible on the chat itself.
 */
const HIDDEN_STEP_TOOLS = new Set(["set_title", "set_chat_icon"]);

/** Human header for a tool step; mono marks an unrecognized raw name. */
function toolStepLabel(
  toolName: string,
  input?: unknown,
): { label: string; mono: boolean } {
  if (input && typeof input === "object") {
    if (toolName === "point_at" && "target" in input && input.target === null)
      return { label: "Stopped pointing", mono: false };
    if (toolName === "use_worktree" && "path" in input && input.path === null)
      return { label: "Switched to the project checkout", mono: false };
  }
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

function friendlyFieldLabel(field: string): string {
  const spaced = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function friendlyScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

function friendlyStatus(value: string): string {
  return value === "in_progress"
    ? "In progress"
    : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** Plain-language field list for Work's own tools, never a JSON dump. */
function friendlyDetailLines(value: unknown, indent = "", depth = 0): string[] {
  const scalar = friendlyScalar(value);
  if (scalar !== undefined) return [`${indent}${scalar}`];
  if (value === null || value === undefined) return [];
  if (depth > 3) return [`${indent}More details available`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}None`];
    return value.flatMap((item, index) => {
      const record = asRecord(item);
      if (!record) {
        return friendlyDetailLines(item, `${indent}• `, depth + 1);
      }
      const headlineEntry = ["title", "label", "name", "key", "path", "url"]
        .map((key) => [key, friendlyScalar(record[key])] as const)
        .find((entry) => entry[1] !== undefined);
      const lines = [`${indent}• ${headlineEntry?.[1] ?? `Item ${index + 1}`}`];
      for (const [key, child] of Object.entries(record)) {
        if (key === headlineEntry?.[0] || key === "id") continue;
        const childScalar = friendlyScalar(child);
        if (childScalar !== undefined) {
          lines.push(
            `${indent}  ${friendlyFieldLabel(key)}: ${key === "status" ? friendlyStatus(childScalar) : childScalar}`,
          );
          continue;
        }
        const nested = friendlyDetailLines(child, `${indent}    `, depth + 1);
        if (nested.length > 0) {
          lines.push(`${indent}  ${friendlyFieldLabel(key)}:`);
          lines.push(...nested);
        }
      }
      return lines;
    });
  }
  const record = asRecord(value);
  if (!record) return [];
  if (Object.keys(record).length === 1 && record.ok === true) return ["Done"];
  const lines: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (key === "id") continue;
    const childScalar = friendlyScalar(child);
    if (childScalar !== undefined) {
      lines.push(
        `${indent}${friendlyFieldLabel(key)}: ${key === "status" ? friendlyStatus(childScalar) : childScalar}`,
      );
      continue;
    }
    const nested = friendlyDetailLines(child, `${indent}  `, depth + 1);
    if (nested.length > 0) {
      lines.push(`${indent}${friendlyFieldLabel(key)}:`);
      lines.push(...nested);
    }
  }
  return lines;
}

function friendlyStepDetail(value: unknown): string | undefined {
  const text = friendlyDetailLines(value).join("\n").trim();
  if (!text) return undefined;
  return text.length > STEP_DETAIL_MAX
    ? `${text.slice(0, STEP_DETAIL_MAX)}\n… truncated`
    : text;
}

function statusMarker(status: string | undefined): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "●" : "○";
}

function todoStepDetail(input: unknown, result: unknown): string | undefined {
  const inputRecord = asRecord(input);
  const inputItems = inputRecord?.items ?? inputRecord?.todos;
  const resultRecord = asRecord(result);
  const items = Array.isArray(inputItems)
    ? inputItems
    : Array.isArray(resultRecord?.items)
      ? resultRecord.items
      : undefined;
  if (!items) return friendlyStepDetail(result);
  if (items.length === 0) return "Cleared the todo list.";
  const lines = items.flatMap((item) => {
    const todo = asRecord(item);
    if (!todo) return [];
    const title =
      friendlyScalar(todo.title) ??
      friendlyScalar(todo.content) ??
      "Untitled task";
    const description =
      friendlyScalar(todo.description) ?? friendlyScalar(todo.activeForm);
    return [
      `${statusMarker(friendlyScalar(todo.status))} ${title}`,
      ...(description ? [`  ${description}`] : []),
    ];
  });
  const completed = friendlyScalar(resultRecord?.completed);
  const total = friendlyScalar(resultRecord?.total);
  if (completed && total) lines.push("", `${completed} of ${total} complete`);
  return lines.join("\n");
}

function toolStepDetail(
  toolName: string,
  input: unknown,
  result: unknown,
): string | undefined {
  if (
    toolName === "TodoWrite" ||
    toolName === "update_todo_list" ||
    toolName === "read_todo_list"
  ) {
    return todoStepDetail(input, result);
  }
  if (!WORKSPACE_STEP_TOOLS.has(toolName)) {
    const rawInput = stepDetailText(input);
    const rawResult = stepDetailText(result);
    return stepDetailText(
      [rawInput && `Input:\n${rawInput}`, rawResult && `Result:\n${rawResult}`]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  const friendlyInput = friendlyStepDetail(input);
  const friendlyResult = friendlyStepDetail(result);
  return stepDetailText(
    [
      friendlyInput && `Input\n${friendlyInput}`,
      friendlyResult && `Result\n${friendlyResult}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

/**
 * Marks the live steps still going. A call the harness reports the end of
 * runs until that end arrives; any other step runs only while it is the
 * latest, because nothing will say when it finished.
 */
export function markRunning(steps: TurnStep[]): TurnStep[] {
  return steps.map((step, index) =>
    !step.finished && (step.awaitsEnd || index === steps.length - 1)
      ? { ...step, running: true }
      : step,
  );
}

/**
 * A tool's name as the steps read it: Work's own tools by their own name
 * (the same on every harness), a connector's as `server/tool`. Harnesses
 * name MCP tools `mcp__server__tool`.
 */
export function stepToolName(item: { tool: string; server: string | null }) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.tool);
  const tool = mcp?.[2] ?? item.tool;
  const server = item.server ?? mcp?.[1] ?? null;
  return server && server !== "workspace" && !WORKSPACE_STEP_TOOLS.has(tool)
    ? `${server}/${tool}`
    : tool;
}

const epoch = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

type StepTiming = Pick<
  TurnStep,
  "status" | "startedAt" | "endedAt" | "finished" | "awaitsEnd"
>;

/** When an item started and ended, and whether it has finished. */
function itemTiming(item: WorkItem): StepTiming {
  return {
    status: item.status,
    startedAt: epoch(item.startedAt ?? item.createdAt),
    endedAt: epoch(item.endedAt),
    finished: item.status !== "in_progress",
    // Every item says when it ends: an unfinished one is still running.
    awaitsEnd: true,
  };
}

const firstLineOf = (text: string): string =>
  text.split("\n", 1)[0]?.trim() ?? "";

/**
 * The turn's steps, from its work items. The chat keeps its prose calm:
 * this is where the full commands, file paths and tool payloads live, on
 * demand. Work a harness's private subagent did reads under its step.
 */
export function turnStepsOf(
  sources: StepSource[],
  context: {
    requests: Readonly<Record<string, RuntimeRequest>>;
    sourceHref?: SourceHref;
  },
): TurnStep[] {
  const nested = new Map<string, WorkItem[]>();
  for (const source of sources) {
    if (source.kind !== "work" || !source.item.parentItemId) continue;
    const list = nested.get(source.item.parentItemId) ?? [];
    list.push(source.item);
    nested.set(source.item.parentItemId, list);
  }
  const steps: TurnStep[] = [];
  for (const source of sources) {
    if (source.kind === "note") {
      steps.push(noteStep(source.item));
      continue;
    }
    if (source.item.parentItemId) continue;
    const step = stepOf(source.item, {
      requests: context.requests,
      sourceHref: context.sourceHref,
      nested: nested.get(source.item.id) ?? [],
    });
    if (step) steps.push(step);
  }
  return steps;
}

function stepOf(
  item: WorkItem,
  context: {
    requests: Readonly<Record<string, RuntimeRequest>>;
    sourceHref?: SourceHref;
    nested: WorkItem[];
  },
): TurnStep | undefined {
  const timing = itemTiming(item);
  const key = item.id;
  switch (item.kind) {
    case "command": {
      const description = item.description?.trim() ?? "";
      const first = firstLineOf(item.command);
      // The agent's own words lead; the command itself is one click away.
      return {
        ...timing,
        key,
        kind: "command",
        label: description || `$ ${first || "(command)"}`,
        mono: !description,
        detail: stepDetailText(
          [
            description || item.command.includes("\n")
              ? item.command
              : undefined,
            stepDetailText(item.output || undefined),
            item.exitCode !== null && item.exitCode !== 0
              ? `Exit code ${item.exitCode}`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
        detailMono: true,
      };
    }
    case "file_change": {
      const verb =
        item.change === "created"
          ? "Created"
          : item.change === "deleted"
            ? "Deleted"
            : item.change === "renamed"
              ? "Renamed"
              : "Edited";
      return {
        ...timing,
        key,
        kind: "file_edit",
        label:
          item.change === "renamed" && item.previousPath
            ? `${verb} ${item.previousPath} to ${item.path}`
            : `${verb} ${item.path || "a file"}`,
        mono: true,
        filePath:
          item.path && item.change !== "deleted" ? item.path : undefined,
      };
    }
    case "tool_call": {
      const toolName = stepToolName(item);
      if (HIDDEN_STEP_TOOLS.has(toolName)) return undefined;
      const started = backgroundStart(toolName, item.input);
      if (started)
        return {
          ...timing,
          key,
          finished: true,
          kind: "background",
          label: started.description,
          background: { ref: item.id, ...started },
          detail: started.command,
          detailMono: true,
        };
      const pretty = toolStepLabel(toolName, item.input);
      const description = item.description?.trim();
      // The agent's own words lead here too, over the tool's friendly name.
      return {
        ...timing,
        key,
        kind: "tool",
        label: description || pretty.label,
        mono: !description && pretty.mono,
        toolName,
        detail: toolStepDetail(
          toolName,
          item.input,
          item.error ? { error: item.error } : item.result,
        ),
        detailMono: !WORKSPACE_STEP_TOOLS.has(toolName),
      };
    }
    case "subagent":
      return {
        ...timing,
        key,
        kind: "subagent",
        label: `Subagent: ${firstLineOf(item.title) || "delegated work"}`,
        detail: stepDetailText(
          [
            context.nested
              .map((child) => nestedLine(child))
              .filter(Boolean)
              .join("\n"),
            item.result ?? undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      };
    case "reasoning": {
      const text = item.text.trim();
      if (!text) return undefined;
      return {
        ...timing,
        key,
        kind: "reasoning",
        label: plainLine(firstLineOf(text)) || "Thinking",
        detail: text.includes("\n") ? text : undefined,
        markdown: true,
      };
    }
    case "plan":
      return {
        ...timing,
        key,
        kind: "plan",
        label: "Updated the plan",
        detail: item.steps
          .map((step) => `${statusMarker(step.status)} ${step.text}`)
          .join("\n"),
      };
    case "request":
      return requestStep(item.id, context.requests[item.requestId], timing);
    // News about a task the agent started that reached it while it worked
    // (ADR 0217): part of the work, like a tool's result.
    case "task_notification": {
      const href = item.source
        ? hrefOf(item.source, context.sourceHref)
        : undefined;
      return {
        key,
        status: item.status,
        finished: true,
        kind: "notification",
        label: item.summary,
        icon: {
          Icon: taskIcon(item.task.type),
          className: taskTone(item.task.status),
        },
        detail: stepDetailText(item.detail || undefined),
        detailMono: true,
        ...(href && item.source
          ? { link: { href, label: sourceLabel(item.source) } }
          : {}),
      };
    }
  }
}

/** A request the agent made, and how it ended. */
function requestStep(
  key: string,
  request: RuntimeRequest | undefined,
  timing: StepTiming,
): TurnStep {
  const pending = request?.status === "pending";
  const base = {
    ...timing,
    key,
    kind: "request" as const,
    finished: !pending,
  };
  if (request?.kind === "approval") {
    const tool = request.approval?.tool;
    const what = tool
      ? stepToolName({ tool: tool.name, server: tool.server })
      : (request.approval?.action ?? request.title);
    const answer = request.response;
    const outcome =
      answer?.kind === "approval"
        ? answer.decision === "approved"
          ? answer.remember === "always"
            ? "always allowed"
            : "allowed"
          : "denied"
        : request.status === "pending"
          ? "waiting"
          : "withdrawn";
    return {
      ...base,
      label: `Asked to use ${what} (${outcome})`,
      detail: stepDetailText(
        [
          request.reason ?? undefined,
          tool ? stepDetailText(tool.input) : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      detailMono: true,
    };
  }
  if (request?.kind === "elicitation")
    return {
      ...base,
      label: request.elicitation?.message
        ? `Asked: ${firstLineOf(request.elicitation.message)}`
        : "Asked for your input",
    };
  return {
    ...base,
    label:
      request && request.status !== "pending" && request.status !== "resolved"
        ? "Asked you a question (closed)"
        : "Asked you a question",
    detail: request?.questions?.map((question) => question.question).join("\n"),
  };
}

/** One line of a subagent's own activity, for its step's detail. */
function nestedLine(item: WorkItem): string {
  switch (item.kind) {
    case "command":
      return `$ ${firstLineOf(item.command)}`;
    case "file_change":
      return `Edited ${item.path}`;
    case "tool_call":
      return `Used ${stepToolName(item)}`;
    default:
      return "";
  }
}

/** A note the agent wrote mid-turn, as a row of the turn's steps. */
function noteStep(item: AssistantMessageItem): TurnStep {
  const text = item.text.trim();
  const firstLine =
    text
      .split("\n")
      .map((line) => plainLine(line.replace(/^[#>*\-\s]+/, "")))
      .find(Boolean) ?? "Note";
  return {
    key: `${item.id}:note`,
    kind: "note",
    label: firstLine,
    messageId: item.id,
    // A one-line note is fully read from its row; nothing to expand.
    detail: text === firstLine ? undefined : text,
    markdown: true,
  };
}

/**
 * The step an interruption stopped, and how long it had run: the latest
 * that never finished, timed to when the turn stopped.
 */
export function interruptedStep(
  turn: Turn,
  group: TimelineTurn,
): { label: string; ran?: string } | undefined {
  const work = group.entries.flatMap((entry) =>
    entry.kind === "reply" || entry.kind === "steps" ? entry.steps : [],
  );
  const stopped = [...work]
    .reverse()
    .find(
      (item) =>
        !item.parentItemId &&
        (item.status === "in_progress" || item.status === "cancelled"),
    );
  if (!stopped) return undefined;
  const step = stepOf(stopped, { requests: {}, nested: [] });
  if (!step || step.background) return undefined;
  const stoppedAt = epoch(turn.completedAt ?? turn.updatedAt);
  const ran =
    step.startedAt !== undefined && stoppedAt !== undefined
      ? stoppedAt - step.startedAt
      : undefined;
  return {
    label: step.label,
    ...(ran !== undefined && ran >= 1000 ? { ran: formatElapsed(ran) } : {}),
  };
}

/** A run_background_command or watch_command call's command and words. */
function backgroundStart(
  toolName: string,
  toolInput: unknown,
):
  | {
      kind: ChatBackgroundCommand["kind"];
      command: string;
      description: string;
    }
  | undefined {
  const tool = toolName.slice(toolName.lastIndexOf("/") + 1);
  const kind =
    tool === "run_background_command"
      ? "command"
      : tool === "watch_command"
        ? "watch"
        : undefined;
  if (!kind) return undefined;
  const input = asRecord(toolInput);
  // Normalized the way the host records the process, so the two pair up.
  const command =
    typeof input?.command === "string" ? input.command.trim() : "";
  if (!command) return undefined;
  const description =
    (typeof input?.description === "string"
      ? input.description.replace(/\s+/g, " ").trim()
      : "") || command.replace(/\s+/g, " ").slice(0, 80);
  return { kind, command, description };
}

/**
 * Pairs each background step with the process it started: the n-th step
 * for a command and description matches the n-th process for them.
 */
export function assignBackgroundCommands(
  turns: readonly TimelineTurn[],
  commands: readonly ChatBackgroundCommand[],
): Map<string, ChatBackgroundCommand> {
  const assigned = new Map<string, ChatBackgroundCommand>();
  if (commands.length === 0) return assigned;
  const queues = new Map<string, ChatBackgroundCommand[]>();
  for (const command of commands) {
    const key = `${command.kind}\u0000${command.command}\u0000${command.description}`;
    queues.set(key, [...(queues.get(key) ?? []), command]);
  }
  for (const group of turns)
    for (const entry of group.entries) {
      if (entry.kind !== "reply" && entry.kind !== "steps") continue;
      for (const item of entry.steps) {
        if (item.kind !== "tool_call") continue;
        const started = backgroundStart(stepToolName(item), item.input);
        if (!started) continue;
        const key = `${started.kind}\u0000${started.command}\u0000${started.description}`;
        const match = queues.get(key)?.shift();
        if (match) assigned.set(item.id, match);
      }
    }
  return assigned;
}

/** Each background step's process, by the step's item id. */
export const BackgroundStates = createContext<
  ReadonlyMap<string, ChatBackgroundCommand>
>(new Map());

/** What a background step says: running pulses, then how it ended. */
function backgroundLabel(
  kind: ChatBackgroundCommand["kind"],
  state: ChatBackgroundCommand | undefined,
): string {
  if (kind === "watch") {
    if (state?.status === "running") return "Watching";
    if (state?.status === "finished") return "Watched until done";
    if (state?.status === "stopped") return "Stopped watching";
    return "Watched";
  }
  if (state?.status === "running") return "Running in background";
  if (state?.status === "stopped") return "Stopped command in background";
  if (state?.exitCode)
    return `Command failed in background (exit ${state.exitCode})`;
  return "Ran command in background";
}

/** A note's first line reads as plain text in its row: no `**`, backticks or link syntax. */
export function plainLine(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .trim();
}

/** What the step rows need from the timeline. */
interface StepHandlers {
  resolveToolIcon?: (toolName: string) => string | undefined;
  /** An edited file's row was clicked; without it those rows stay text. */
  onFileClick?: (path: string, modifiers?: InputLinkModifiers) => void;
  /** A step's source link (a notification's task) was clicked. */
  onLinkClick?: (url: string, modifiers: InputLinkModifiers) => void;
  /** A note's or a thought's Markdown, links routed like the replies'. */
  renderMarkdown: (text: string) => ReactNode;
}

/**
 * The expandable event log under an assistant reply: a muted "N steps"
 * line, open while the turn runs so the work reads as it happens, closed
 * once it has answered. Opening or closing it by hand sticks. Each step is
 * a row that itself stays collapsed (payloads are long and technical)
 * until clicked; a lone step is its own row, with no line to open. Folded
 * (`fold`, the person's "Notes only"), the line stays closed until opened,
 * a lone step's included. MCP tool rows show the connector's icon when the
 * host can resolve one.
 */
export function TurnSteps({
  steps,
  live = false,
  fold = false,
  defaultExpanded = false,
  ...handlers
}: {
  steps: TurnStep[];
  /** The turn is still running. */
  live?: boolean;
  /** Keep the steps behind their line until opened. */
  fold?: boolean;
  defaultExpanded?: boolean;
} & StepHandlers) {
  const [chosen, setChosen] = useState<boolean>();
  const backgroundStates = useContext(BackgroundStates);
  useEffect(() => {
    if (defaultExpanded) setChosen(true);
  }, [defaultExpanded]);
  // The rows the list first shows are already there. A row that arrives
  // later plays its own entrance while the rows already shown keep their
  // nodes: a new step at the end, earlier work folding in above, or a
  // background command that ended moving from the running rows into the
  // list.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
  }, []);
  const expanded = chosen ?? (live && !fold);
  if (steps.length === 0) return null;
  // A lone step is its own row. It keeps the list's structure, so a second
  // step grows the line to open it in, rather than swapping the row out.
  const lone = steps.length === 1 && !fold;
  // A command still running in the background stays in view, outside the
  // fold, until it ends; then it folds in with the rest.
  const running = steps.filter(
    (step) =>
      step.background &&
      backgroundStates.get(step.background.ref)?.status === "running",
  );
  const folded = steps.filter((step) => !running.includes(step));
  // No line when it would open onto nothing: a lone step, or only
  // commands still running in view.
  const bare = lone || folded.length === 0;
  const open = bare || expanded;
  return (
    // Steps are chrome around the conversation, not part of its text: a
    // drag across several replies selects the prose and skips these rows.
    // An opened payload is content again, and selectable.
    <div className="mb-1.5 select-none" data-testid="chat-turn-steps">
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          bare ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
        inert={bare}
      >
        <div className="overflow-hidden">
          <button
            type="button"
            onClick={() => setChosen(!expanded)}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-fg-faint transition-colors duration-100 hover:text-fg-muted"
            aria-expanded={expanded}
            data-testid="chat-turn-steps-toggle"
          >
            <ChevronRight
              className={`size-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
            {`${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
          </button>
        </div>
      </div>
      {running.length > 0 && (
        <div
          className={`flex flex-col gap-0.5 border-l transition-[border-color,padding,margin] duration-200 ${bare ? "border-transparent pl-0" : "mt-1 border-border pl-2.5"}`}
        >
          {running.map((step) => (
            <StepRow
              key={step.background?.ref}
              step={step}
              enter={shown.current}
              {...handlers}
            />
          ))}
        </div>
      )}
      {/* Grid-rows tween: the list stays mounted, so the collapse mirrors
          the expansion exactly. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            className={`flex flex-col gap-0.5 border-l transition-[border-color,padding,margin] duration-200 ${bare ? "border-transparent pl-0" : "mt-1 border-border pl-2.5"}`}
          >
            {folded.map((step) => (
              <StepRow
                key={step.key}
                step={step}
                enter={shown.current}
                {...handlers}
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
  enter = false,
  resolveToolIcon,
  onFileClick,
  onLinkClick,
  renderMarkdown,
}: {
  step: TurnStep;
  /** Joined a list already on screen: plays its entrance once. */
  enter?: boolean;
} & StepHandlers) {
  const [open, setOpen] = useState(false);
  // Read once: a row that was already there never gains the entrance.
  const [entering, setEntering] = useState(enter);
  const backgroundStates = useContext(BackgroundStates);
  const background = step.background
    ? backgroundStates.get(step.background.ref)
    : undefined;
  const pulsing = background?.status === "running" || step.running === true;
  const note = step.kind === "note";
  const Icon = step.icon?.Icon ?? STEP_ICONS[step.kind];
  const iconUrl = step.toolName ? resolveToolIcon?.(step.toolName) : undefined;
  const expandable = Boolean(step.detail || step.link);
  // Edited-file rows click through to the file.
  const filePath = onFileClick ? step.filePath : undefined;
  const interactive = expandable || filePath !== undefined;
  return (
    <div
      data-testid="chat-step"
      data-step-kind={step.kind}
      data-step-status={step.status}
      data-running={pulsing || undefined}
      data-file-path={step.filePath}
      className={`${note ? "my-0.5" : ""} ${entering ? "cat-step-in" : ""}`}
      data-message-id={step.messageId}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false);
      }}
    >
      {/* One child: the entrance grows this box from nothing. */}
      <div>
        <button
          type="button"
          onClick={
            filePath !== undefined
              ? (event) =>
                  onFileClick?.(filePath, {
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                  })
              : expandable
                ? () => setOpen((value) => !value)
                : undefined
          }
          className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left ${
            // A note is the agent talking, not a tool row: it reads as prose.
            note ? "text-xs text-fg" : "text-[11px] text-fg-muted"
          } ${
            interactive
              ? "cursor-pointer transition-colors duration-100 hover:bg-bg-inset hover:text-fg"
              : "cursor-default"
          }`}
          aria-expanded={expandable ? open : undefined}
        >
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="size-3.5 shrink-0 rounded-sm"
            />
          ) : (
            <Icon
              className={`size-3.5 shrink-0 transition-colors duration-200 ${pulsing ? "animate-pulse text-accent" : (step.icon?.className ?? "text-fg-faint")}`}
            />
          )}
          {step.background ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
              <span
                className={pulsing ? "animate-pulse text-fg" : undefined}
                data-testid="chat-background-status"
              >
                {backgroundLabel(step.background.kind, background)}
              </span>
              <span className="truncate text-fg-faint">{step.label}</span>
            </span>
          ) : (
            <span
              className={`min-w-0 flex-1 truncate transition-colors duration-200 ${step.mono ? "font-mono" : ""} ${step.running ? "text-fg" : ""}`}
            >
              {step.label}
            </span>
          )}
          {step.status === "failed" && (
            <span className="shrink-0 text-danger">Failed</span>
          )}
          <StepDuration step={step} />
          {expandable && (
            <ChevronRight
              className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            />
          )}
        </button>
        {/* Same grid-rows tween as the step list: payloads animate open and
          closed instead of popping in and out. */}
        {expandable && (
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            }`}
          >
            <div className="overflow-hidden" inert={!open}>
              {!step.detail ? null : step.markdown ? (
                <div
                  className="cat-markdown mb-1 ml-6 mt-0.5 min-w-0 select-text break-words text-xs leading-5 text-fg-muted"
                  data-testid="chat-step-detail"
                >
                  {renderMarkdown(step.detail)}
                </div>
              ) : (
                <pre
                  className={`mb-1 ml-6 mt-0.5 max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 text-[11px] leading-4 text-fg-muted ${step.detailMono ? "font-mono" : "font-sans"}`}
                  data-testid="chat-step-detail"
                >
                  {step.detail}
                </pre>
              )}
              {step.link && (
                <a
                  href={step.link.href}
                  className="mb-1 ml-6 inline-block rounded text-[11px] text-accent underline-offset-2 hover:underline"
                  data-testid="chat-step-source"
                  onClick={(event) => {
                    if (!onLinkClick || !step.link) return;
                    event.preventDefault();
                    onLinkClick(step.link.href, {
                      metaKey: event.metaKey,
                      ctrlKey: event.ctrlKey,
                      altKey: event.altKey,
                      shiftKey: event.shiftKey,
                    });
                  }}
                >
                  {step.link.label}
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How long a step took, once that is worth saying (a second or more), or
 * how long it has been running.
 */
function StepDuration({ step }: { step: TurnStep }) {
  const now = useNow(Boolean(step.running && step.startedAt !== undefined));
  if (step.startedAt === undefined) return null;
  const ms = step.running
    ? now - step.startedAt
    : step.endedAt !== undefined
      ? step.endedAt - step.startedAt
      : undefined;
  if (ms === undefined || ms < 1000) return null;
  return (
    <span
      className="cat-fade-in shrink-0 tabular-nums text-fg-faint"
      data-testid="chat-step-duration"
    >
      {formatElapsed(ms)}
    </span>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
