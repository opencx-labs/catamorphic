import { useRef, useState } from "react";
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
  // The name stays while the dialog fades out after it closes.
  const shown = useRef(agent);
  if (agent) shown.current = agent;
  const name = shown.current?.name ?? "this agent";
  // A removal under way finishes before the dialog can close.
  const close = () => {
    if (pending) return;
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
          Remove {name}?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          Chats using {name} will stop. To continue one, open it and choose
          another agent. Subsessions that agents started on {name} are archived.
        </p>
        {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
      </div>
      <footer className="mt-4 flex justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          onClick={close}
          disabled={pending}
          className="button-ghost"
        >
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
              .then(() => {
                setPending(false);
                onClose();
              })
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
