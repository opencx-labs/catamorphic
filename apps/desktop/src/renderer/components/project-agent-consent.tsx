import { Bot, KeyRound, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { displayCommand } from "../../shared/acp-agents.js";
import { desktopApi, type ProjectAgentInfo } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

const KIND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  builtin: "Built-in",
  acp: "ACP",
  "e2e-fake": "Fake harness",
};

const SOURCE_LABELS: Record<ProjectAgentInfo["credentialsSource"], string> = {
  profile: "Your credentials (this profile's sign-in or API key)",
  local: "This machine's own CLI login",
  secret: "A project secret",
  connection: "A model connection of a Work server",
  personal: "Your own login, on a Work server",
};

/**
 * Consent dialog for PROJECT agents (ADR 0050). A committed
 * `.work/agents/<slug>.json` is collaborator-authored code; before it runs on
 * the user's own credentials the profile records approval bound to the
 * definition's hash. This dialog shows what would run — kind, model,
 * credential source, the persona's opening lines — and whether this is a
 * first approval or a re-approval after the definition changed.
 */
export function ProjectAgentConsentDialog({
  request,
  onClose,
  onApproved,
}: {
  request: { agent: ProjectAgentInfo } | null;
  onClose: () => void;
  /** Called after a successful approval, with the approved agent. */
  onApproved: (agent: ProjectAgentInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The definition as it is now, when it changed under review. */
  const [latest, setLatest] = useState<ProjectAgentInfo | null>(null);
  const agent = latest ?? request?.agent ?? null;
  const acp = agent?.kind === "acp";

  // Reset transient state whenever a new request comes in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: request is the reset trigger, not a body dependency
  useEffect(() => {
    setBusy(false);
    setError(null);
    setLatest(null);
  }, [request]);

  const approve = async () => {
    if (!agent || busy) return;
    setBusy(true);
    setError(null);
    const result = await desktopApi
      .projectAgentApprove(
        agent.projectId,
        agent.slug,
        agent.definitionHash ?? "",
      )
      .catch((cause) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "Approval failed");
      // Changed under review: what shows becomes what approving binds.
      const now = await desktopApi
        .projectAgentsList(agent.projectId)
        .then((data) => data.agents.find((each) => each.slug === agent.slug))
        .catch(() => undefined);
      if (now && now.definitionHash !== agent.definitionHash) setLatest(now);
      return;
    }
    onApproved(agent);
  };

  return (
    <Modal open={agent !== null} onClose={onClose} width={440}>
      {agent && (
        <div className="p-5" data-testid="project-agent-consent">
          <div className="mb-1 flex items-center gap-2">
            {agent.consent === "stale" ? (
              <ShieldAlert className="size-4 text-fg-muted" />
            ) : (
              <Bot className="size-4 text-fg-muted" />
            )}
            <h2 className="text-sm font-semibold">
              {agent.consent === "stale"
                ? `“${agent.name}” changed — review it again`
                : `Approve “${agent.name}”?`}
            </h2>
          </div>
          <p className="mb-4 text-xs text-fg-muted">
            {agent.consent === "stale"
              ? "This project agent's definition changed since you approved it, so your approval was reset."
              : `This agent is defined by files committed to the project, and anyone with write access can change them. ${acp ? "Approving runs its command on this machine as you." : "Approving lets it run with your credentials."}`}
          </p>

          <dl className="mb-4 space-y-2 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-fg-faint">Harness</dt>
              <dd>{KIND_LABELS[agent.kind] ?? agent.kind}</dd>
            </div>
            {agent.command && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-fg-faint">Runs</dt>
                <dd className="break-all font-mono">
                  {displayCommand(agent.command)}
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-fg-faint">Model</dt>
              <dd>{acp ? "Its own" : agent.model || "Harness default"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-fg-faint">Runs with</dt>
              <dd className="flex items-center gap-1.5">
                <KeyRound className="size-3.5 text-fg-faint" />
                {acp
                  ? "Its own configuration and sign-in"
                  : SOURCE_LABELS[agent.credentialsSource]}
              </dd>
            </div>
            {agent.connections.length > 0 && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-fg-faint">Wants</dt>
                <dd>{agent.connections.join(", ")}</dd>
              </div>
            )}
            {agent.description && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-fg-faint">About</dt>
                <dd className="text-fg-muted">{agent.description}</dd>
              </div>
            )}
          </dl>

          {agent.promptPreview && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-medium text-fg-faint">
                Persona (.work/agents/{agent.slug}.md)
              </div>
              <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-bg-inset p-2 text-[11px] text-fg-muted">
                {agent.promptPreview}
              </pre>
            </div>
          )}

          {error && (
            <p className="mb-3 text-xs text-danger" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <PendingButton
              pending={busy}
              pendingLabel="Approving…"
              type="button"
              data-testid="project-agent-approve"
              onClick={() => void approve()}
              disabled={busy}
              data-disabled-reason="Wait for the current action to finish"
              className="button-primary"
            >
              Approve and use
            </PendingButton>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-overlay"
            >
              Cancel
            </button>
            {!acp && (
              <span className="ml-auto text-[11px] text-fg-faint">
                Uses your existing sign-in. Configure it in Settings.
              </span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
