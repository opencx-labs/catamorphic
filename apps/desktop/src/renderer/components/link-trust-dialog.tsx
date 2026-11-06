import { useState } from "react";
import { Modal } from "./modal.js";

/**
 * Before a chat opens a link to a host it does not trust (ADR 0277). An
 * agent wrote the address, and opening it sends the whole address to its
 * host, so the person sees where it goes and what it carries, and may trust
 * the host from now on.
 */
export function LinkTrustDialog({
  ask,
  onClose,
  onOpen,
  onTrust,
}: {
  ask: { url: string; host: string } | null;
  onClose: () => void;
  onOpen: () => void;
  /** Trust the host, then open: its links and images need no answer again. */
  onTrust: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [trusting, setTrusting] = useState(false);
  return (
    <Modal
      open={ask !== null}
      onClose={onClose}
      width={460}
      labelledBy="link-trust-title"
    >
      <div className="px-5 pt-5" data-testid="link-trust-dialog">
        <h2
          id="link-trust-title"
          className="break-all text-sm font-semibold text-fg"
        >
          Open a link to {ask?.host}?
        </h2>
        <p className="mt-2 break-words text-[13px] leading-relaxed text-fg-muted">
          An agent wrote this link. Opening it sends the whole address to{" "}
          {ask?.host}, and an address can carry anything the agent read.
        </p>
        <p className="mt-3 max-h-24 overflow-y-auto break-all rounded-lg border border-border bg-bg-inset px-3 py-2 font-mono text-xs text-fg-muted">
          {ask?.url}
        </p>
        {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
      </div>
      <footer className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" onClick={onClose} className="button-ghost">
          Cancel
        </button>
        <button
          type="button"
          data-testid="link-trust-always"
          disabled={trusting}
          className="button-ghost"
          onClick={() => {
            setTrusting(true);
            setError("");
            onTrust().then(
              () => setTrusting(false),
              (cause: unknown) => {
                setTrusting(false);
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              },
            );
          }}
        >
          Always open
        </button>
        <button
          type="button"
          data-testid="link-trust-open"
          className="button-primary"
          onClick={onOpen}
        >
          Open
        </button>
      </footer>
    </Modal>
  );
}
