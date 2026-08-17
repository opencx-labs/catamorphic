"use client";

import type {
  PendingToolPermission,
  ToolPermissionAnswer,
} from "@catamorphic/react";
import { ShieldQuestion } from "lucide-react";
import { useState } from "react";

/**
 * Consent for an MCP tool whose permission policy says "ask" (ADR 0054):
 * which agent, which tool on which connection, exactly what it will send.
 * Three answers — deny this call, allow this call, or always allow this
 * tool (the host persists that as a rule on the connection). Feed it from
 * `useToolPermissions`; the agent's tool call resumes on the answer.
 */
export function ToolPermissionCard({
  permission,
  onAnswer,
  busy = false,
  className,
}: {
  permission: PendingToolPermission;
  onAnswer: (answer: ToolPermissionAnswer) => void;
  busy?: boolean;
  className?: string;
}) {
  const { request, agentLabel } = permission;
  const [showArgs, setShowArgs] = useState(false);
  const hint = request.annotations?.destructiveHint
    ? { text: "May change or delete data", tone: "text-danger" }
    : request.annotations?.readOnlyHint
      ? { text: "Read-only", tone: "text-fg-muted" }
      : null;
  return (
    <div
      className={`rounded-xl border border-border bg-bg-raised p-3 text-sm ${className ?? ""}`}
      data-testid="tool-permission-card"
    >
      <div className="mb-2 flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-bg-overlay">
          <ShieldQuestion className="size-4 text-accent" />
        </span>
        <div className="min-w-0">
          {agentLabel && (
            <p className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              {agentLabel}
            </p>
          )}
          <p className="text-[13px] text-fg">
            wants to use <span className="font-medium">{request.tool}</span> on{" "}
            <span className="font-medium">{request.server}</span>
          </p>
          {request.description && (
            <p className="mt-1 line-clamp-3 text-xs text-fg-muted">
              {request.description}
            </p>
          )}
          {hint && (
            <p className={`mt-1 text-[11px] ${hint.tone}`}>{hint.text}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowArgs((value) => !value)}
        className="mb-1 cursor-pointer text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg"
        aria-expanded={showArgs}
      >
        {showArgs ? "Hide arguments" : "Show arguments"}
      </button>
      {showArgs && (
        <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted">
          {JSON.stringify(request.input, null, 2)}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer({ decision: "allow" })}
          className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          data-testid="tool-permission-allow"
        >
          Allow once
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer({ decision: "allow", remember: "always" })}
          className="h-8 cursor-pointer rounded-md border border-border-strong bg-bg-overlay px-3 text-[13px] text-fg transition-colors duration-150 hover:border-accent disabled:opacity-50"
          data-testid="tool-permission-always"
        >
          Always allow
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAnswer({ decision: "deny" })}
          className="ml-auto h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-50"
          data-testid="tool-permission-deny"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
