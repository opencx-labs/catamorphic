import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Link2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { type ConnectLink, desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/**
 * Connect a remote project (ADR 0055): a folder on this machine becomes a
 * working copy of what a hosting backend lets this member see — company
 * docs read-only, their store subtrees read/write. Paste the connect link
 * an invite carried (or arrive here from `catamorphic://connect?…`), pick
 * a folder, done: the first sync runs on connect.
 */
export function RemoteConnectModal({
  open,
  link,
  onClose,
  onConnected,
}: {
  open: boolean;
  /** Prefill from a connect link (deep link or pasted). */
  link: ConnectLink | null;
  onClose: () => void;
  onConnected: (project: { id: string; name: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [pasted, setPasted] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [remoteProjectId, setRemoteProjectId] = useState("");
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [renewUrl, setRenewUrl] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setError(null);
    void desktopApi.defaultProjectsDir().then(setParentDir);
  }, [open]);

  useEffect(() => {
    if (!link) return;
    setServerUrl(link.serverUrl);
    setToken(link.token);
    setRemoteProjectId(link.remoteProjectId);
    setRenewUrl(link.renewUrl);
    if (link.remoteProjectName) setName(link.remoteProjectName);
  }, [link]);

  const applyPasted = async (value: string) => {
    setPasted(value);
    const parsed = await desktopApi.remoteParseLink(value);
    if (!parsed) return;
    setServerUrl(parsed.serverUrl);
    setToken(parsed.token);
    setRemoteProjectId(parsed.remoteProjectId);
    setRenewUrl(parsed.renewUrl);
    if (parsed.remoteProjectName) setName(parsed.remoteProjectName);
  };

  const browseParent = async () => {
    const picked = await desktopApi.pickFolder({
      title: "Choose where the project folder is created",
      defaultPath: parentDir || undefined,
    });
    if (picked) setParentDir(picked);
  };

  // Folder names are ASCII-safe slugs; a name with no ASCII (a non-Latin
  // project name) falls back to the remote id so Connect never dead-ends.
  const folderName =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    remoteProjectId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    "remote-project";
  const targetPath =
    parentDir && folderName ? `${parentDir}/${folderName}` : null;
  const canSubmit =
    !pending &&
    serverUrl.trim().length > 0 &&
    token.trim().length > 0 &&
    remoteProjectId.trim().length > 0 &&
    name.trim().length > 0 &&
    targetPath !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !targetPath) return;
    setPending(true);
    setError(null);
    try {
      const result = await desktopApi.remoteConnect({
        serverUrl: serverUrl.trim(),
        token: token.trim(),
        remoteProjectId: remoteProjectId.trim(),
        name: name.trim(),
        rootPath: targetPath,
        ...(renewUrl ? { renewUrl } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
      onConnected({ id: result.id, name: result.name });
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
              Connect to a remote project
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              A folder here stays in sync with what your team's server lets you
              see. Paste the link from your invite, or fill the fields.
            </p>
          </div>

          <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
            Connect link
            <div className="field flex h-8 items-center gap-2 px-2.5">
              <Link2 className="size-3.5 shrink-0 text-fg-faint" />
              <input
                value={pasted}
                onChange={(event) => void applyPasted(event.target.value)}
                placeholder="catamorphic://connect?server=…&token=…&project=…"
                // biome-ignore lint/a11y/noAutofocus: modal's primary field
                autoFocus
                data-testid="remote-link-input"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
              />
            </div>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
              Server
              <input
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://brain.example.com/api"
                data-testid="remote-server-input"
                className="field h-8 px-2.5 text-[13px] text-fg placeholder:text-fg-faint"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
              Project id
              <input
                value={remoteProjectId}
                onChange={(event) => setRemoteProjectId(event.target.value)}
                data-testid="remote-project-input"
                className="field h-8 px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-faint"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
            Access token
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              data-testid="remote-token-input"
              className="field h-8 px-2.5 font-mono text-[12px] text-fg placeholder:text-fg-faint"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
            Project name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme brain"
              data-testid="remote-name-input"
              className="field h-8 px-2.5 text-[13px] text-fg placeholder:text-fg-faint"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-fg-muted">
            Location
            <button
              type="button"
              onClick={browseParent}
              data-testid="remote-location-picker"
              className="field flex h-8 min-w-0 cursor-pointer items-center gap-2 px-2.5 text-left text-[13px]"
            >
              <FolderOpen className="size-3.5 shrink-0 text-fg-faint" />
              <span className="truncate text-fg" dir="rtl">
                {parentDir || "…"}
              </span>
            </button>
          </label>

          {targetPath && (
            <p className="truncate text-xs text-fg-faint">
              Will be created at{" "}
              <span className="font-mono text-fg-muted">{targetPath}</span>
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
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={pending}
            pendingLabel="Connecting…"
            disabled={!canSubmit}
            data-testid="remote-connect-submit"
            className="h-8 cursor-pointer rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Connect
          </PendingButton>
        </footer>
      </form>
    </Modal>
  );
}
