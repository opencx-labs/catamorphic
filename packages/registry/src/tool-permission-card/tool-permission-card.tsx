"use client";

import type {
  RuntimeRequest,
  RuntimeRequestResponse,
} from "@catamorphic/react";
import { ExternalLink, ShieldQuestion } from "lucide-react";
import { useState } from "react";

/**
 * A runtime request that is not a question panel (ADR 0196): an approval
 * for a tool call whose permission policy says "ask" (ADR 0054), or an MCP
 * elicitation. Approvals show which agent, which tool on which connection,
 * and exactly what it will send, with Allow once, Always allow (the host
 * persists the rule) and Deny. Feed it from `useAgentChat().requests` and
 * answer with `respond(request.id, response)`.
 *
 * A request whose attempt is gone (`answerable: false`) shows why and no
 * buttons. One with named approvers that exclude `viewerId` shows who it
 * waits for; without a `viewerId` the viewer is treated as allowed.
 */
export function ToolPermissionCard({
  request,
  onRespond,
  busy = false,
  viewerId,
  resolveName = (id) => id,
  className,
}: {
  request: RuntimeRequest;
  onRespond: (response: RuntimeRequestResponse) => void;
  busy?: boolean;
  /** The viewing person's external user id, to honor `approvers`. */
  viewerId?: string;
  /** A person's display name for an approver id. */
  resolveName?: (externalUserId: string) => string;
  className?: string;
}) {
  const [showArgs, setShowArgs] = useState(false);
  const tool = request.approval?.tool;
  const waitingFor =
    viewerId !== undefined &&
    request.approvers.length > 0 &&
    !request.approvers.includes(viewerId)
      ? request.approvers.map(resolveName)
      : null;
  const actionable = request.answerable && !waitingFor;
  const agentLabel = request.origin.displayName;
  const description =
    request.description ??
    request.approval?.details ??
    request.elicitation?.message ??
    null;
  const elicitationUrl = request.elicitation?.url;
  return (
    <div
      className={`rounded-xl border border-border bg-bg-raised p-3 text-sm ${className ?? ""}`}
      data-testid="tool-permission-card"
      data-request-kind={request.kind}
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
          {tool ? (
            <p className="text-[13px] text-fg">
              wants to use <span className="font-medium">{tool.name}</span>
              {tool.server && (
                <>
                  {" "}
                  on <span className="font-medium">{tool.server}</span>
                </>
              )}
            </p>
          ) : (
            <p className="text-[13px] font-medium text-fg">
              {request.approval?.action ?? request.title}
            </p>
          )}
          {description && (
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-fg-muted">
              {description}
            </p>
          )}
        </div>
      </div>
      {tool && (
        <>
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
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
        </>
      )}
      {!request.answerable ? (
        <p
          className="mt-2 text-xs text-fg-muted"
          data-testid="tool-permission-unanswerable"
        >
          {request.reason ?? "This can no longer be answered."}
        </p>
      ) : waitingFor ? (
        <p
          className="mt-2 text-xs text-fg-muted"
          data-testid="tool-permission-waiting"
        >
          Waiting for {waitingFor.join(", ")}
        </p>
      ) : null}
      {actionable && request.kind === "approval" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onRespond({ kind: "approval", decision: "approved" })
            }
            className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
            data-testid="tool-permission-allow"
          >
            Allow once
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onRespond({
                kind: "approval",
                decision: "approved",
                remember: "always",
              })
            }
            className="h-8 cursor-pointer rounded-md border border-border-strong bg-bg-overlay px-3 text-[13px] text-fg transition-colors duration-150 hover:border-accent disabled:opacity-50"
            data-testid="tool-permission-always"
          >
            Always allow
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRespond({ kind: "approval", decision: "denied" })}
            className="ml-auto h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-50"
            data-testid="tool-permission-deny"
          >
            Deny
          </button>
        </div>
      )}
      {actionable && request.kind === "elicitation" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {elicitationUrl ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                window.open(elicitationUrl, "_blank", "noopener,noreferrer");
                onRespond({ kind: "elicitation", action: "accept" });
              }}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
              data-testid="elicitation-open"
            >
              Open <ExternalLink className="size-3.5" />
            </button>
          ) : (
            <span className="text-xs text-fg-muted">
              This asks for details this view cannot collect.
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onRespond({ kind: "elicitation", action: "decline" })
            }
            className="ml-auto h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:opacity-50"
            data-testid="elicitation-decline"
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
