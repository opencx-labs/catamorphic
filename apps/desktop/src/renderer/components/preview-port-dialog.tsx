import { useEffect, useId, useState } from "react";
import { validPreviewPort } from "../lib/remote-workspace.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/** Which chat's workspace a preview opens, and the port it last used. */
export interface PreviewPortRequest {
  sessionId: string;
  chatTitle: string;
  lastPort?: number;
}

/**
 * Asks for the port of a server running in a remote chat's workspace and
 * opens it in a browser tab (ADR 0208).
 */
export function PreviewPortDialog({
  request,
  pending,
  error,
  onClose,
  onOpen,
}: {
  request: PreviewPortRequest | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onOpen: (port: number) => void;
}) {
  const titleId = useId();
  const [value, setValue] = useState("");
  useEffect(() => {
    setValue(request?.lastPort ? String(request.lastPort) : "");
  }, [request]);
  const port = Number(value);
  const valid = /^\d+$/.test(value.trim()) && validPreviewPort(port);
  return (
    <Modal
      open={request !== null}
      onClose={onClose}
      width={400}
      labelledBy={titleId}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onOpen(port);
        }}
      >
        <div className="px-5 pt-5">
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Open preview
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Open a server running in the workspace of {request?.chatTitle} in a
            browser tab. Pages reload by hand: live reload does not reach
            previews.
          </p>
          <label className="mt-4 block text-xs font-medium text-fg-muted">
            Port
            <input
              // biome-ignore lint/a11y/noAutofocus: the dialog asks for this one value
              autoFocus
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="3000"
              aria-invalid={value !== "" && !valid}
              className="mt-1.5 h-9 w-full rounded-md border border-border bg-bg-inset px-2.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
          </label>
          {value !== "" && !valid ? (
            <p className="mt-2 text-xs text-fg-muted">
              A port is a number from 1 to 65535.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="mt-5 flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <button type="button" onClick={onClose} className="button-ghost">
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={pending}
            pendingLabel="Opening…"
            disabled={!valid}
            data-disabled-reason={
              valid ? undefined : "Enter a port from 1 to 65535"
            }
            className="button-primary"
          >
            Open preview
          </PendingButton>
        </footer>
      </form>
    </Modal>
  );
}
