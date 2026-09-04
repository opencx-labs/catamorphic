import type { AgentSession } from "@catamorphic/react/types";
import {
  Archive,
  Bot,
  CircleDot,
  Ghost,
  GitBranch,
  GitFork,
  LoaderCircle,
  Server,
} from "lucide-react";
import type { SessionCheckoutInfo } from "../lib/desktop-api.js";
import { ChatGlyph } from "./chat-icon.js";
import { ResourceInspector } from "./resource-inspector.js";

const SOURCE_LABELS: Record<AgentSession["source"], string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  slack: "Slack",
  claude: "Claude",
  mcp: "MCP client",
  api: "API",
};

export function SessionInspector({
  session,
  fallbackTitle,
  agentName,
  checkout,
  incognito,
  openRequest,
  moving,
  moveDisabledReason,
  onMove,
  onFork,
  onArchive,
  archived = false,
  onOpenParent,
}: {
  session: AgentSession | null | undefined;
  fallbackTitle: string;
  agentName: string;
  checkout: SessionCheckoutInfo | null;
  incognito: boolean;
  openRequest?: number;
  moving: boolean;
  moveDisabledReason?: string | null;
  onMove?: () => void;
  onFork?: () => void;
  onArchive?: () => void;
  archived?: boolean;
  onOpenParent?: () => void;
}) {
  const state = archived
    ? "Archived"
    : !session
      ? "New"
      : session.running
        ? "Working"
        : session.attentionRequired
          ? "Needs attention"
          : session.status === "closed"
            ? "Archived"
            : session.resumable
              ? "Paused"
              : "Ready";
  const source = incognito
    ? "This device"
    : session
      ? SOURCE_LABELS[session.source]
      : "Desktop";
  return (
    <ResourceInspector
      label="Session status and actions"
      pinOnClick
      openRequest={openRequest}
      content={
        <SessionInspectorContent
          session={session}
          fallbackTitle={fallbackTitle}
          agentName={agentName}
          checkout={checkout}
          incognito={incognito}
          moving={moving}
          moveDisabledReason={moveDisabledReason}
          onMove={onMove}
          onFork={onFork}
          onArchive={onArchive}
          archived={archived}
          onOpenParent={onOpenParent}
        />
      }
    >
      {(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          aria-label={`Session status: ${agentName}, ${state}, from ${source}`}
          className="flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-fg-muted transition-colors hover:bg-bg-overlay hover:text-fg"
          data-testid="session-inspector-trigger"
        >
          {session?.running ? (
            <LoaderCircle className="size-3 animate-spin text-accent" />
          ) : incognito ? (
            <Ghost className="size-3" />
          ) : (
            <CircleDot className="size-3 text-accent" />
          )}
          <Bot className="size-3" />
          <span className="truncate">{agentName}</span>
          <span className="shrink-0 rounded bg-bg-inset px-1.5 py-0.5 text-[9px] font-medium text-fg-faint">
            {source}
          </span>
        </button>
      )}
    </ResourceInspector>
  );
}

export function SessionInspectorContent({
  session,
  fallbackTitle,
  agentName,
  checkout,
  incognito,
  moving = false,
  moveDisabledReason,
  onMove,
  onFork,
  onArchive,
  archived = false,
  onOpenParent,
}: {
  session: AgentSession | null | undefined;
  fallbackTitle: string;
  agentName: string;
  checkout: SessionCheckoutInfo | null;
  incognito: boolean;
  moving?: boolean;
  moveDisabledReason?: string | null;
  onMove?: () => void;
  onFork?: () => void;
  onArchive?: () => void;
  archived?: boolean;
  onOpenParent?: () => void;
}) {
  const state = archived
    ? "Archived"
    : !session
      ? "New"
      : session.running
        ? "Working"
        : session.attentionRequired
          ? "Needs attention"
          : session.status === "closed"
            ? "Archived"
            : session.resumable
              ? "Paused"
              : "Ready";
  const source = incognito
    ? "This device"
    : session
      ? SOURCE_LABELS[session.source]
      : "Desktop";
  const title = session?.title ?? fallbackTitle;
  const checkoutLabel = checkout
    ? checkout.kind === "external"
      ? "External checkout"
      : (checkout.branch ?? "Worktree")
    : null;
  return (
    <div data-testid="session-inspector-content">
      <header className="flex items-start gap-2.5 border-b border-border pb-3">
        <ChatGlyph
          icon={session?.icon}
          fork={Boolean(session?.parentSessionId)}
          className="mt-0.5 size-4 shrink-0 text-accent"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] font-semibold text-fg">
            {title}
          </h2>
          {session?.activity ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-fg-muted">
              {session.activity}
            </p>
          ) : null}
        </div>
      </header>

      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 py-3 text-[11px]">
        <InspectorRow label="Agent" value={agentName} />
        <InspectorRow label="Source" value={source} />
        <InspectorRow label="Status" value={state} />
        <InspectorRow
          label="Environment"
          value={session?.environment ?? "Default"}
        />
        {checkoutLabel ? (
          <InspectorRow label="Checkout" value={checkoutLabel} />
        ) : null}
        {incognito ? <InspectorRow label="Privacy" value="Incognito" /> : null}
        {session?.handoffStatus === "pending" ? (
          <InspectorRow label="Sync" value="Moving between hosts" />
        ) : session && session.mirrorMessageCount > 0 ? (
          <InspectorRow label="Sync" value="Mirrored conversation" />
        ) : null}
        {session?.parentSessionId ? (
          <InspectorRow label="Lineage" value="Forked conversation" />
        ) : null}
        {session ? (
          <InspectorRow
            label="Updated"
            value={new Date(session.updatedAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          />
        ) : null}
      </dl>

      {(onFork || onArchive || onMove || onOpenParent) && (
        <div className="grid grid-cols-2 gap-1 border-t border-border pt-2">
          {onFork ? (
            <InspectorAction icon={GitFork} label="Fork" onClick={onFork} />
          ) : null}
          {onOpenParent ? (
            <InspectorAction
              icon={GitBranch}
              label="Original"
              onClick={onOpenParent}
            />
          ) : null}
          {onMove ? (
            <InspectorAction
              icon={moving ? LoaderCircle : Server}
              label={moving ? "Moving" : "Move to server"}
              onClick={onMove}
              disabled={Boolean(moveDisabledReason) || moving}
              title={moveDisabledReason ?? undefined}
              spinning={moving}
            />
          ) : null}
          {onArchive ? (
            <InspectorAction
              icon={Archive}
              label={archived ? "Unarchive" : "Archive"}
              onClick={onArchive}
              danger={!archived}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="min-w-0 truncate text-fg" title={value}>
        {value}
      </dd>
    </>
  );
}

function InspectorAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
  danger,
  spinning,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? "text-danger hover:bg-danger/10"
          : "text-fg-muted hover:bg-bg-raised hover:text-fg"
      }`}
    >
      <Icon className={`size-3.5 ${spinning ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}
