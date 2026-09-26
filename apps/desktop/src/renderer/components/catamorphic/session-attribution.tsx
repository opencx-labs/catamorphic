import type { AgentMessage } from "@catamorphic/react";
import type { MouseEvent } from "react";

type OpenLink = (url: string, event: MouseEvent<HTMLAnchorElement>) => void;
/** Compact provenance is shared by desktop, mobile, and embedded chat timelines. */
export function SessionAttribution({
  author,
  metadata,
  onOpen,
}: {
  author?: AgentMessage["author"];
  metadata?: unknown;
  onOpen?: OpenLink;
}) {
  const detail = record(metadata);
  const provenance = record(detail?.provenance);
  const action = record(detail?.sessionAction);
  if (!author || author.kind === "user") return null;
  const actor =
    author.kind === "workflow"
      ? (author.displayName ?? readableName(author.workflowName))
      : author.kind === "watcher"
        ? "Watcher"
        : author.kind === "agent"
          ? "Agent"
          : "System";
  const workflow =
    author.kind === "workflow"
      ? author.workflowName
      : string(provenance?.workflowName);
  const source =
    string(provenance?.watcherId) ??
    (author.kind === "watcher" ? author.watcherId : undefined);
  const sessionId =
    author.kind === "agent" ? author.sessionId : string(provenance?.sessionId);
  const runId =
    author.kind === "workflow" || author.kind === "watcher"
      ? author.runId
      : string(provenance?.runId);
  const href = source
    ? `artifact:${encodeURIComponent(source)}`
    : workflow
      ? `workflow:${encodeURIComponent(workflow)}`
      : sessionId
        ? `session:${encodeURIComponent(sessionId)}`
        : undefined;
  const result = record(action?.result);
  const child = record(result?.session);
  const childId =
    string(child?.id) ??
    (action?.operation === "create" || action?.operation === "fork"
      ? string(result?.id)
      : undefined);
  const link = (url: string, label: string) => (
    <a
      href={url}
      className="rounded underline-offset-2 hover:underline"
      onClick={(event) => {
        if (onOpen) {
          event.preventDefault();
          onOpen(url, event);
        }
      }}
    >
      {label}
    </a>
  );
  return (
    <div
      className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted"
      data-testid="session-attribution"
    >
      {detail?.attention === "required" && (
        <span className="font-medium text-accent">Attention requested</span>
      )}
      {typeof provenance?.scheduledFor === "string" && (
        <span>
          {typeof provenance.firedAt === "string" &&
          Date.parse(provenance.firedAt) - Date.parse(provenance.scheduledFor) >
            60_000
            ? "Delivered late. Scheduled for "
            : "Scheduled for "}
          {new Date(provenance.scheduledFor).toLocaleString()}
        </span>
      )}
      {href ? link(href, actor) : <span>{actor}</span>}
      {runId && link(`run:${encodeURIComponent(runId)}`, "View run")}
      {sessionId &&
        author.kind !== "agent" &&
        link(`session:${encodeURIComponent(sessionId)}`, "Originating chat")}
      {childId && link(`session:${encodeURIComponent(childId)}`, "Open chat")}
      {action && (
        <span className="text-fg-faint">
          {action.status === "failed" ? "Action failed" : "Session action"}
        </span>
      )}
    </div>
  );
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
