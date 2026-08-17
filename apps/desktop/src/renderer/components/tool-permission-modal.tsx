import { ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { Modal } from "./modal.js";

/**
 * Consent for an MCP tool whose policy says "ask": which agent, which
 * tool on which connection, and exactly what it's about to send. Three
 * answers — deny this call, allow this call, or always allow this tool
 * (which becomes a rule on the connection's policy, the profile ceiling).
 * Read-only/destructive hints are shown so the choice is informed. One at
 * a time; the harness waits (with a long timeout) on the answer.
 */

export interface ToolPermissionRequestView {
  server: string;
  tool: string;
  description?: string;
  input: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type ToolPermissionDecisionView =
  | { decision: "allow"; remember?: "always" }
  | { decision: "deny" };

export interface PendingToolPermission {
  id: string;
  /** The asking agent's name. */
  label?: string;
  request: ToolPermissionRequestView;
  resolve: (decision: ToolPermissionDecisionView) => void;
}

export function ToolPermissionModal({
  pending,
}: {
  pending: PendingToolPermission | null;
}) {
  if (!pending) return null;
  return (
    <Modal open onClose={() => pending.resolve({ decision: "deny" })}>
      <PermissionCard key={pending.id} pending={pending} />
    </Modal>
  );
}

function PermissionCard({ pending }: { pending: PendingToolPermission }) {
  const { request, label, resolve } = pending;
  const [showArgs, setShowArgs] = useState(false);
  const args = JSON.stringify(request.input, null, 2);
  const hint = request.annotations?.destructiveHint
    ? { text: "May change or delete data", tone: "text-danger" }
    : request.annotations?.readOnlyHint
      ? { text: "Read-only", tone: "text-fg-muted" }
      : null;
  return (
    <div
      className="w-[min(460px,90vw)] p-5"
      data-testid="tool-permission-modal"
    >
      <div className="mb-3 flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-bg-overlay">
          <ShieldQuestion className="size-4 text-accent" />
        </span>
        <div className="min-w-0">
          {label && (
            <p className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              {label}
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
        <pre
          className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-mono text-[11px] leading-4 text-fg-muted"
          data-testid="tool-permission-args"
        >
          {args}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => resolve({ decision: "allow" })}
          className="h-8 cursor-pointer rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
          data-testid="tool-permission-allow"
        >
          Allow once
        </button>
        <button
          type="button"
          onClick={() => resolve({ decision: "allow", remember: "always" })}
          className="h-8 cursor-pointer rounded-md border border-border-strong bg-bg-overlay px-3 text-[13px] text-fg transition-colors duration-150 hover:border-accent"
          data-testid="tool-permission-always"
        >
          Always allow
        </button>
        <button
          type="button"
          onClick={() => resolve({ decision: "deny" })}
          className="ml-auto h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          data-testid="tool-permission-deny"
        >
          Deny
        </button>
      </div>
      <p className="mt-2 text-[11px] text-fg-faint">
        "Always allow" adds a rule to this connection's permissions in
        Connectors — you can change it there anytime.
      </p>
    </div>
  );
}
