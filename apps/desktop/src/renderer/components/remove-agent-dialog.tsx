import { useState } from "react";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/**
 * Confirms removing one of the profile's agents (ADR 0314): its chats stop
 * until the person chooses another agent in them, and the subsessions
 * other agents started on it are archived.
 */
export function RemoveAgentDialog({
  agent,
  onClose,
  onRemove,
}: {
  agent: { id: string; name: string } | null;
  onClose: () => void;
  onRemove: (agentId: string) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <Modal
      open={agent !== null}
      onClose={close}
      width={420}
      labelledBy="remove-agent-title"
    >
      <div className="px-5 pt-5">
        <h2 id="remove-agent-title" className="text-sm font-semibold text-fg">
          Remove {agent?.name ?? "this agent"}?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          Chats using {agent?.name ?? "this agent"} will stop. To continue one,
          open it and choose another agent. Subsessions running on it are
          archived.
        </p>
        {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
      </div>
      <footer className="mt-4 flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" onClick={close} className="button-ghost">
          Cancel
        </button>
        <PendingButton
          data-testid="remove-agent-confirm"
          type="button"
          pending={pending}
          pendingLabel="Removing…"
          className="h-8 rounded-md border border-danger/40 bg-danger/10 px-3 text-[13px] font-medium text-danger hover:bg-danger/20 disabled:opacity-50"
          onClick={() => {
            if (!agent) return;
            setPending(true);
            setError(null);
            onRemove(agent.id)
              .then(close)
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          Remove agent
        </PendingButton>
      </footer>
    </Modal>
  );
}
