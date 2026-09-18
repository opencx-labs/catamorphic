import { workflowKeys } from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderOpen, GitFork, Link2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ConnectLink, desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import {
  GithubAuthorizationTray,
  GithubRepositoryAccessTray,
} from "./project-modal.js";

/**
 * Connect a remote project (ADR 0055): a folder on this machine becomes a
 * working copy of what a hosting backend lets this member see — company
 * docs read-only, their store subtrees read/write. Paste the connect link
 * an invite carried (or arrive here from `work://connect?…`), pick
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
  onConnected: (project: { id: string; name: string }) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const parseRevision = useRef(0);
  const [pasted, setPasted] = useState("");
  const [parsedLink, setParsedLink] = useState<ConnectLink | null>(null);
  const [parentDir, setParentDir] = useState("");
  const [pending, setPending] = useState(false);
  const [authInProgress, setAuthInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubRequired, setGithubRequired] = useState(false);
  const [githubGrant, setGithubGrant] = useState<{
    userCode: string;
    verificationUri: string;
  } | null>(null);
  const [managingAccess, setManagingAccess] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setManagingAccess(false);
    setAuthInProgress(false);
    setError(null);
    setGithubRequired(false);
    setGithubGrant(null);
    setPasted("");
    setParsedLink(null);
    parseRevision.current += 1;
    void desktopApi.defaultProjectsDir().then(setParentDir);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return desktopApi.onBrowserCloseUrl(() => setAuthInProgress(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return desktopApi.onGithubConnected((result) => {
      setGithubGrant(null);
      if (result && "error" in result) {
        setError(result.error);
        return;
      }
      setError(null);
    });
  }, [open]);

  useEffect(() => {
    if (!open || !link) return;
    parseRevision.current += 1;
    setPasted(formatConnectLink(link));
    setParsedLink(link);
  }, [link, open]);

  const applyPasted = async (value: string) => {
    const revision = ++parseRevision.current;
    setPasted(value);
    setParsedLink(null);
    setError(null);
    try {
      const parsed = await desktopApi.remoteParseLink(value);
      if (!parsed || revision !== parseRevision.current) return;
      setParsedLink(parsed);
    } catch {
      if (revision === parseRevision.current)
        setError("Could not read this project link. Paste it again to retry.");
    }
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
  const projectName =
    parsedLink?.remoteProjectName?.trim() || parsedLink?.remoteProjectId || "";
  const folderName =
    projectName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    parsedLink?.remoteProjectId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    "remote-project";
  const targetPath =
    parentDir && folderName ? `${parentDir}/${folderName}` : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!parsedLink) {
      setError("Paste the complete Work invitation link.");
      return;
    }
    if (!targetPath) {
      setError("Choose where to create the project folder.");
      return;
    }
    setPending(true);
    setAuthInProgress(true);
    setError(null);
    setGithubRequired(false);
    try {
      const result = await desktopApi.remoteConnect({
        serverUrl: parsedLink.serverUrl,
        remoteProjectId: parsedLink.remoteProjectId,
        ...(parsedLink.invitationId
          ? { invitationId: parsedLink.invitationId }
          : {}),
        name: projectName,
        rootPath: targetPath,
      });
      // Rejoining an existing local copy replaces its connection and grants.
      // Rebuild the authority cache even when the selected project ID stays put.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["cat", "projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["cat", "project", result.id],
        }),
        queryClient.invalidateQueries({
          queryKey: workflowKeys.project({ projectId: result.id }),
        }),
        queryClient.invalidateQueries({
          queryKey: ["desktop", "project-authority", result.id],
        }),
      ]);
      await onConnected({ id: result.id, name: result.name });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const requiresGithub = message.includes("[github-required]");
      setGithubRequired(requiresGithub);
      setError(
        /fetch failed|Failed to fetch|ECONNREFUSED/.test(message)
          ? "Could not reach the company server. Check your connection and try joining again."
          : message
              .replace(
                /^Error invoking remote method '[^']+': (?:Error: )?/,
                "",
              )
              .replace("[github-required]", "")
              .trim(),
      );
    } finally {
      setAuthInProgress(false);
      setPending(false);
    }
  };

  const connectGithub = async () => {
    setError(null);
    try {
      const grant = await desktopApi.githubConnectStart();
      setGithubGrant(grant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <Modal
        open={open && !authInProgress && !githubGrant && !managingAccess}
        onClose={onClose}
      >
        <form onSubmit={submit}>
          <div className="flex flex-col gap-4 px-5 pt-5 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold text-fg">
                Join a project
              </h2>
              <p className="mt-1 text-xs text-fg-muted">
                Sign in to get your own local copy of the project.
              </p>
            </div>

            <label
              htmlFor="remote-invitation-link"
              className="flex flex-col gap-1.5 text-xs text-fg-muted"
            >
              Invitation link
              <div className="field flex h-8 items-center gap-2 px-2.5">
                <Link2 className="size-3.5 shrink-0 text-fg-faint" />
                <input
                  id="remote-invitation-link"
                  name="invitationLink"
                  value={pasted}
                  onChange={(event) => void applyPasted(event.target.value)}
                  placeholder="work://connect?server=…&project=…"
                  required
                  aria-describedby="remote-link-help"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  // biome-ignore lint/a11y/noAutofocus: modal's primary field
                  autoFocus
                  data-testid="remote-link-input"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-faint"
                />
              </div>
              <span id="remote-link-help" className="text-[11px] text-fg-faint">
                Paste the link your teammate shared. It already identifies the
                server and project.
              </span>
            </label>

            {parsedLink && (
              <div
                role="status"
                data-testid="remote-link-summary"
                className="px-1 py-1"
              >
                <p className="text-xs font-medium text-fg">{projectName}</p>
                <p className="mt-0.5 text-[11px] text-fg-faint">
                  {new URL(parsedLink.serverUrl).host}
                </p>
              </div>
            )}

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

            {parsedLink && targetPath && (
              <p className="truncate text-xs text-fg-faint">
                Local folder:{" "}
                <span className="font-mono text-fg-muted">{targetPath}</span>
              </p>
            )}
            {error && (
              <p
                className="text-xs text-danger"
                role="alert"
                aria-live="polite"
              >
                {error}
              </p>
            )}
            {githubRequired && (
              <section className="flex flex-col gap-2 rounded-lg bg-bg-raised p-3">
                <div className="flex items-start gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center text-fg-muted">
                    <GitFork className="size-4 text-fg-muted" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-fg">
                      Repository access
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-fg-muted">
                      Builders receive the full repository. Connect GitHub or
                      grant this app access, then connect the project again.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void connectGithub()}
                    className="h-8 rounded-lg bg-fg px-3 text-xs font-semibold text-bg"
                  >
                    Connect GitHub
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setManagingAccess(true);
                      void desktopApi.githubManageRepos().catch((cause) => {
                        setManagingAccess(false);
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                        );
                      });
                    }}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-fg-muted"
                  >
                    Grant repository access
                    <ExternalLink className="size-3" />
                  </button>
                </div>
              </section>
            )}
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
              pendingLabel="Joining…"
              disabled={pending || !parsedLink || !parentDir}
              data-disabled-reason={
                pending
                  ? "Wait for the connection to finish"
                  : "Paste a valid project link and choose a folder"
              }
              data-testid="remote-connect-submit"
              className="h-8 cursor-pointer rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Join project
            </PendingButton>
          </footer>
        </form>
      </Modal>
      {open &&
        githubGrant &&
        createPortal(
          <GithubAuthorizationTray
            grant={githubGrant}
            onCancel={() => {
              void desktopApi.githubConnectCancel();
              setGithubGrant(null);
            }}
          />,
          document.body,
        )}
      {open &&
        managingAccess &&
        createPortal(
          <GithubRepositoryAccessTray
            onDone={() => {
              setManagingAccess(false);
              void desktopApi.authorizationCancel();
            }}
          />,
          document.body,
        )}
    </>
  );
}

function formatConnectLink(link: ConnectLink): string {
  const url = new URL("work://connect");
  url.searchParams.set("server", link.serverUrl);
  url.searchParams.set("project", link.remoteProjectId);
  if (link.remoteProjectName)
    url.searchParams.set("name", link.remoteProjectName);
  if (link.invitationId) url.searchParams.set("invitation", link.invitationId);
  return url.toString();
}
