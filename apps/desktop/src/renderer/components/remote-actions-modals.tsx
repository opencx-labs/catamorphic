import { Check, Copy } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import type { RemoteFeatures } from "./remote-nav.js";

/**
 * The two members' verbs beside Ship (ADR 0055):
 * - Publish: a URL for one store document, to members (behind the host's
 *   login) or public. Ships the file first when it has local edits, so the
 *   link always shows what you see.
 * - Propose: this folder's edits to program files (outside store/) become
 *   a branch, and a pull request on your behalf when the project is on
 *   GitHub. The program changes by review, never by ship.
 */

export function RemotePublishModal({
  projectId,
  path,
  features,
  onClose,
}: {
  projectId: string;
  /** Store path to publish; null = closed. */
  path: string | null;
  /** The host's advertised switches (from the Server section's status). */
  features: RemoteFeatures | undefined;
  onClose: () => void;
}) {
  const open = path !== null;
  const [audience, setAudience] = useState<"members" | "public">("members");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ absoluteUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const publicAllowed =
    features === undefined || features.publications === "public";

  useEffect(() => {
    if (!open) return;
    setAudience("members");
    setPending(false);
    setResult(null);
    setError(null);
    setCopied(false);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path) return;
    setPending(true);
    setError(null);
    try {
      setResult(await desktopApi.remotePublish({ projectId, path, audience }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.absoluteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const name = path?.split("/").at(-1) ?? "";
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="flex flex-col gap-4 px-5 pt-5 pb-4">
          <div>
            <h2 className="truncate text-[15px] font-semibold text-fg">
              Share a link · {name}
            </h2>
            <p className="mt-1 truncate font-mono text-[11px] text-fg-faint">
              {path}
            </p>
          </div>
          {!result ? (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs text-fg-muted">
                  Who can open it
                </legend>
                <label className="flex cursor-pointer items-start gap-2 text-[13px] text-fg">
                  <input
                    type="radio"
                    name="audience"
                    checked={audience === "members"}
                    onChange={() => setAudience("members")}
                    className="mt-1"
                  />
                  <span>
                    Members
                    <span className="block text-xs text-fg-faint">
                      Anyone in this project, signed in to your team's server.
                    </span>
                  </span>
                </label>
                {publicAllowed && (
                  <label className="flex cursor-pointer items-start gap-2 text-[13px] text-fg">
                    <input
                      type="radio"
                      name="audience"
                      checked={audience === "public"}
                      onChange={() => setAudience("public")}
                      className="mt-1"
                    />
                    <span>
                      Anyone with the link
                      <span className="block text-xs text-fg-faint">
                        No sign-in. Only this document; revoke any time.
                      </span>
                    </span>
                  </label>
                )}
              </fieldset>
              <p className="text-xs text-fg-faint">
                Unsaved local edits are shipped first, so the link shows what
                you see.
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={result.absoluteUrl}
                data-testid="publish-url"
                className="field h-8 min-w-0 flex-1 px-2.5 font-mono text-[12px] text-fg"
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border border-border text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                aria-label="Copy link"
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            {result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <PendingButton
              type="submit"
              pending={pending}
              pendingLabel="Publishing…"
              data-testid="publish-submit"
              className="button-primary"
            >
              Create link
            </PendingButton>
          )}
        </footer>
      </form>
    </Modal>
  );
}

export function RemoteProposeModal({
  projectId,
  open,
  files,
  onClose,
  onOpenProposal,
}: {
  projectId: string;
  open: boolean;
  /** The project files available to include in this proposal. */
  files: string[];
  onClose: () => void;
  onOpenProposal: (proposal: { number: number; title: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState<string[]>(
    files.length === 1 ? files : [],
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    branch: string;
    pullRequest?: { url: string; number: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setPending(false);
    setResult(null);
    setError(null);
    setSelected(files.length === 1 ? files : []);
  }, [open, files]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || selected.length === 0) return;
    setPending(true);
    setError(null);
    try {
      setResult(
        await desktopApi.remotePropose({
          projectId,
          title: title.trim(),
          paths: selected,
          ...(body.trim() ? { body: body.trim() } : {}),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="flex flex-col gap-4 px-5 pt-5 pb-4">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">
              Propose these changes
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              {result
                ? "Your proposal is ready for the project reviewers."
                : "Choose the files to send for review. The shared project changes only after approval."}
            </p>
          </div>
          {!result ? (
            <>
              <ul className="max-h-32 overflow-y-auto rounded-md bg-bg-inset px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
                {files.map((file) => (
                  <li key={file}>
                    <label className="flex cursor-pointer items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected.includes(file)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, file]
                              : current.filter((path) => path !== file),
                          )
                        }
                      />
                      <span className="truncate">{file}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                Title
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Describe what changed"
                  // biome-ignore lint/a11y/noAutofocus: modal's primary field
                  autoFocus
                  data-testid="propose-title"
                  className="field h-8 px-2.5 text-[13px] text-fg placeholder:text-fg-faint"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
                Why (optional)
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={3}
                  className="field resize-none px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-faint"
                />
              </label>
            </>
          ) : (
            <p className="text-[13px] text-fg" data-testid="propose-result">
              {result.pullRequest ? (
                <>
                  Proposal #{result.pullRequest.number}: {title}
                </>
              ) : (
                <>Changes sent to the project reviewers.</>
              )}
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 cursor-pointer rounded-md px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          >
            {result ? "Done" : "Cancel"}
          </button>
          {result?.pullRequest && (
            <button
              type="button"
              onClick={() => {
                if (!result.pullRequest) return;
                onOpenProposal({ number: result.pullRequest.number, title });
                onClose();
              }}
              className="button-primary"
            >
              View proposal
            </button>
          )}
          {!result && (
            <PendingButton
              type="submit"
              pending={pending}
              pendingLabel="Proposing…"
              disabled={!title.trim() || selected.length === 0}
              data-disabled-reason="Enter a title and select at least one file"
              data-testid="propose-submit"
              className="button-primary"
            >
              Propose
            </PendingButton>
          )}
        </footer>
      </form>
    </Modal>
  );
}
