"use client";

import type {
  InboundMessageItem,
  InboundSender,
  InputSource,
  NoticeItem,
  QueuedMessage,
  TaskNotificationItem,
} from "@catamorphic/react";
import {
  Bell,
  Bot,
  ChevronRight,
  Eye,
  History,
  type LucideIcon,
  MessagesSquare,
  Sparkles,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

/** Modifier keys a link click carries, for hosts that open in place or aside. */
export interface InputLinkModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

type OpenLink = (url: string, modifiers: InputLinkModifiers) => void;

/** A host's own address for a source (a chat in another project, say). */
export type SourceHref = (source: InputSource) => string | undefined;

/**
 * Where a person opens what an input came from (ADR 0217): a chat, a
 * workflow run, or a surface of the host's workspace such as a terminal.
 */
export function defaultSourceHref(source: InputSource): string {
  switch (source.kind) {
    case "session":
      return `session:${encodeURIComponent(source.sessionId)}`;
    case "workflow_run":
      return `run:${encodeURIComponent(source.runId)}`;
    case "surface":
      return source.key;
  }
}

/** A source's address: the host's own when it has one, else the default. */
export function hrefOf(source: InputSource, sourceHref?: SourceHref): string {
  return sourceHref?.(source) ?? defaultSourceHref(source);
}

/** The words on a source's link. */
export function sourceLabel(source: InputSource): string {
  switch (source.kind) {
    case "session":
      return "Open chat";
    case "workflow_run":
      return "Open run";
    case "surface":
      return source.key.startsWith("terminal:") ? "Open terminal" : "Open";
  }
}

/** Where an inbound message's sender lives, when a person can open it. */
export function senderSource(from: InboundSender): InputSource | null {
  switch (from.kind) {
    case "agent":
      return {
        kind: "session",
        sessionId: from.sessionId,
        ...(from.projectId ? { projectId: from.projectId } : {}),
      };
    case "workflow":
      return {
        kind: "workflow_run",
        runId: from.runId,
        workflowName: from.workflowName,
      };
    case "assistant":
      return null;
  }
}

/** Who sent an inbound message, in a person's words. */
export function senderName(
  from: InboundSender,
  resolveAgentName?: (agentId: string) => string | undefined,
): string {
  switch (from.kind) {
    case "agent":
      return (
        (from.agentId ? resolveAgentName?.(from.agentId) : undefined) ??
        "Another agent"
      );
    case "assistant":
      return "Assistant";
    case "workflow":
      return from.displayName ?? readableName(from.workflowName);
  }
}

/**
 * A session action's notice, naming who took it: "Pr review: Archived
 * this session". Other notices read as written.
 */
export function noticeText(
  item: NoticeItem,
  resolveAgentName?: (agentId: string) => string | undefined,
): string {
  const actor = record(item.data.actor);
  if (item.code !== "session_action" || !actor) return item.text;
  const name =
    actor.kind === "workflow" && typeof actor.workflowName === "string"
      ? (string(actor.displayName) ?? readableName(actor.workflowName))
      : actor.kind === "agent"
        ? ((typeof actor.agentId === "string"
            ? resolveAgentName?.(actor.agentId)
            : undefined) ?? "An agent")
        : actor.kind === "assistant"
          ? "Assistant"
          : undefined;
  return name ? `${name}: ${item.text}` : item.text;
}

const SENDER_ICONS: Record<InboundSender["kind"], LucideIcon> = {
  agent: Bot,
  assistant: Sparkles,
  workflow: Workflow,
};

const TASK_ICONS: Record<string, LucideIcon> = {
  background_command: SquareTerminal,
  command_watch: Eye,
  subsession: Bot,
  followed_session: MessagesSquare,
};

/** A task's glyph: its kind's, or a bell for a host's own kinds. */
export function taskIcon(type: string): LucideIcon {
  return TASK_ICONS[type] ?? Bell;
}

/** The icon's color for how the task stands. */
export function taskTone(status: TaskNotificationItem["task"]["status"]) {
  switch (status) {
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "needs_input":
      return "text-warning";
    case "update":
      return "text-accent";
    case "stopped":
      return "text-fg-faint";
  }
}

/**
 * Work's notifications about tasks the agent started, as rows like its
 * steps (ADR 0217): the task's icon, how it stands, one line, and the
 * detail the agent read one click away, ending in a link to the task.
 * Repeated news from one task folds into its latest row.
 */
export function TaskNotificationRows({
  items,
  onOpen,
  sourceHref,
  focusMessageId,
}: {
  items: readonly TaskNotificationItem[];
  onOpen?: OpenLink;
  sourceHref?: SourceHref;
  /** A notification to outline and open (a deep link to it). */
  focusMessageId?: string;
}) {
  const groups: TaskNotificationItem[][] = [];
  for (const item of items) {
    const last = groups.at(-1)?.at(-1);
    if (
      last &&
      last.task.type === item.task.type &&
      last.task.id === item.task.id
    )
      groups.at(-1)?.push(item);
    else groups.push([item]);
  }
  return (
    <div className="mr-auto flex w-full max-w-[85%] flex-col gap-0.5">
      {groups.map((group) => (
        <TaskNotificationRow
          key={group[0]?.id}
          items={group}
          onOpen={onOpen}
          sourceHref={sourceHref}
          focused={group.some((item) => item.id === focusMessageId)}
        />
      ))}
    </div>
  );
}

function TaskNotificationRow({
  items,
  onOpen,
  sourceHref,
  focused,
}: {
  items: readonly TaskNotificationItem[];
  onOpen?: OpenLink;
  sourceHref?: SourceHref;
  focused: boolean;
}) {
  const latest = items.at(-1);
  if (!latest) return null;
  const Icon = taskIcon(latest.task.type);
  const detail =
    items.length === 1
      ? latest.detail.trim()
      : items
          .map((item) =>
            [`${timeOf(item.createdAt)}  ${item.summary}`, item.detail.trim()]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n");
  const href = latest.source ? hrefOf(latest.source, sourceHref) : undefined;
  return (
    <InputRow
      messageId={latest.id}
      focused={focused}
      testId="chat-task-notification"
      data={{
        "data-task-type": latest.task.type,
        "data-task-status": latest.task.status,
      }}
      icon={
        <Icon className={`size-3.5 shrink-0 ${taskTone(latest.task.status)}`} />
      }
      label={latest.summary}
      meta={items.length > 1 ? `${items.length} times` : undefined}
      unread={items.some((item) => item.status === "in_progress")}
      detail={
        detail ? (
          <pre className="max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted">
            {detail}
          </pre>
        ) : undefined
      }
      links={
        href && latest.source
          ? [{ href, label: sourceLabel(latest.source) }]
          : []
      }
      onOpen={onOpen}
    />
  );
}

/**
 * Words another agent, the person's assistant or a workflow sent this chat
 * (ADR 0217): never the person's bubble. One row names the sender with
 * the message's first line; it opens to the whole message, where it came
 * from, and a link to it.
 */
export function InboundMessageRow({
  item,
  onOpen,
  resolveAgentName,
  sourceHref,
  renderContent,
  focused = false,
}: {
  item: InboundMessageItem;
  onOpen?: OpenLink;
  resolveAgentName?: (agentId: string) => string | undefined;
  sourceHref?: SourceHref;
  /** The message body; defaults to its text. */
  renderContent?: (item: InboundMessageItem) => ReactNode;
  /** Outlined and open: a deep link to it (a reminder's alert). */
  focused?: boolean;
}) {
  const Icon = SENDER_ICONS[item.from.kind];
  const provenance = record(item.metadata.provenance);
  const source = senderSource(item.from);
  const firstLine = item.text.trim().split("\n", 1)[0] ?? "";
  const links: { href: string; label: string }[] = [];
  const own = source ? hrefOf(source, sourceHref) : undefined;
  if (own && source) links.push({ href: own, label: sourceLabel(source) });
  if (item.from.kind === "workflow")
    links.push({
      href: `workflow:${encodeURIComponent(item.from.workflowName)}`,
      label: "Open workflow",
    });
  const originating = string(provenance?.sessionId);
  if (originating && item.from.kind !== "agent")
    links.push({
      href: `session:${encodeURIComponent(originating)}`,
      label: "Originating chat",
    });
  const scheduledFor = string(provenance?.scheduledFor);
  const firedAt = string(provenance?.firedAt);
  const late =
    scheduledFor !== undefined &&
    firedAt !== undefined &&
    Date.parse(firedAt) - Date.parse(scheduledFor) > 60_000;
  return (
    <InputRow
      messageId={item.id}
      focused={focused}
      testId="chat-inbound-message"
      data={{ "data-sender-kind": item.from.kind }}
      icon={<Icon className="size-3.5 shrink-0 text-fg-faint" />}
      label={senderName(item.from, resolveAgentName)}
      preview={firstLine}
      attention={item.attention === "required"}
      unread={item.status === "in_progress"}
      detail={
        <div className="flex flex-col gap-1.5">
          <div className="select-text whitespace-pre-wrap break-words text-xs leading-5 text-fg">
            {renderContent ? renderContent(item) : item.text}
          </div>
          {scheduledFor && (
            <div className="text-[11px] text-fg-faint">
              {late ? "Delivered late. Scheduled for " : "Scheduled for "}
              {new Date(scheduledFor).toLocaleString()}
            </div>
          )}
        </div>
      }
      links={links}
      onOpen={onOpen}
    />
  );
}

/**
 * What a waiting turn will take in when it is not the person's own words:
 * one quiet line for the queue (ADR 0217). Only a person's message is
 * edited; these are withdrawn or run now.
 */
export function QueuedInputLine({
  queued,
  resolveAgentName,
}: {
  queued: QueuedMessage;
  resolveAgentName?: (agentId: string) => string | undefined;
}) {
  const { item } = queued;
  if (item?.kind === "task_notification") {
    const Icon = taskIcon(item.task.type);
    const more = queued.joined.length;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={`size-3.5 shrink-0 ${taskTone(item.task.status)}`} />
        <span className="min-w-0 truncate">{item.summary}</span>
        {more > 0 && (
          <span className="shrink-0 text-fg-faint">
            {more === 1 ? "and 1 more" : `and ${more} more`}
          </span>
        )}
      </span>
    );
  }
  if (item?.kind === "inbound_message") {
    const Icon = SENDER_ICONS[item.from.kind];
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-fg-faint" />
        <span className="shrink-0 font-medium">
          {senderName(item.from, resolveAgentName)}
        </span>
        <span className="min-w-0 truncate text-fg-faint">
          {item.text.trim().split("\n", 1)[0]}
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <History className="size-3.5 shrink-0 text-fg-faint" />
      <span className="min-w-0 truncate">Carry on where it stopped</span>
    </span>
  );
}

/** A row like a turn's step that opens to its detail and its links. */
function InputRow({
  messageId,
  focused,
  testId,
  data,
  icon,
  label,
  preview,
  meta,
  attention = false,
  unread = false,
  detail,
  links,
  onOpen,
}: {
  messageId: string;
  focused: boolean;
  testId: string;
  data: Record<`data-${string}`, string>;
  icon: ReactNode;
  label: string;
  /** Muted text after the label: a message's first line. */
  preview?: string;
  /** A quiet count or note at the end of the row. */
  meta?: string;
  attention?: boolean;
  /** Delivered without waking the agent, and not read yet. */
  unread?: boolean;
  detail?: ReactNode;
  links: readonly { href: string; label: string }[];
  onOpen?: OpenLink;
}) {
  const [open, setOpen] = useState(focused);
  const expandable = Boolean(detail) || links.length > 0;
  // Opened when a link to it arrives after it was already on screen.
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  return (
    <div
      data-testid={testId}
      data-message-id={messageId}
      tabIndex={-1}
      className={`rounded-md ${focused ? "outline outline-1 outline-accent/50" : ""}`}
      {...data}
    >
      <button
        type="button"
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-fg-muted ${
          expandable
            ? "cursor-pointer transition-colors duration-100 hover:bg-bg-inset hover:text-fg"
            : "cursor-default"
        }`}
        aria-expanded={expandable ? open : undefined}
      >
        {icon}
        <span className="shrink-0 truncate font-medium text-fg-muted">
          {label}
        </span>
        {preview && (
          <span className="min-w-0 flex-1 truncate text-fg-faint">
            {preview}
          </span>
        )}
        {!preview && <span className="flex-1" />}
        {attention && (
          <span className="shrink-0 text-[11px] font-medium text-accent">
            Attention requested
          </span>
        )}
        {unread && (
          <span className="shrink-0 text-[11px] text-fg-faint">
            For the next turn
          </span>
        )}
        {meta && (
          <span className="shrink-0 text-[11px] text-fg-faint">{meta}</span>
        )}
        {expandable && (
          <ChevronRight
            className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {/* Grid-rows tween like a step's: the detail opens and closes in place. */}
      {expandable && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden" inert={!open}>
            <div className="mb-1 ml-6 mt-0.5 flex flex-col gap-1.5">
              {detail}
              {links.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]"
                  data-testid="chat-input-source"
                >
                  {links.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      className="rounded text-accent underline-offset-2 hover:underline"
                      onClick={(event) => {
                        if (!onOpen) return;
                        event.preventDefault();
                        onOpen(link.href, {
                          metaKey: event.metaKey,
                          ctrlKey: event.ctrlKey,
                          altKey: event.altKey,
                          shiftKey: event.shiftKey,
                        });
                      }}
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** `staleChatNudge` reads as "Stale chat nudge" when no display name is known. */
function readableName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function string(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
