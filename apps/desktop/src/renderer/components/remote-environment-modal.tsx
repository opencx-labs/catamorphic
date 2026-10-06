import { FileText, Plus, RefreshCw, ServerCog, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  PersonalEnvironmentServerState,
  PersonalEnvironmentView,
} from "../../shared/personal-environment.js";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const SERVER_NOTE: Record<PersonalEnvironmentServerState, string | null> = {
  unknown: "Checking the project's server.",
  allowed: null,
  "not-allowed":
    'No Environment in this project allows personal credentials yet, so nothing is sent. Set "personalCredentials": true on an Environment in .work/project.json.',
  unsupported: "This project's server does not support remote environments.",
  "sign-in": "Sign in to this project's server again to send your environment.",
  unreachable:
    "The project's server could not be reached. Work tries again in a few minutes.",
};

/**
 * The member's remote environment for a linked project (ADR 0184): which
 * project files reach their sessions on the server, and their own setup
 * command for new workspaces there (ADR 0208), shown as the config says it.
 * Sign-ins never leave the machine they were made on (ADR 0199), so the
 * modal says where a subscription runs instead of offering to send it.
 * Everything here edits `.work/personal/environment.json`.
 */
export function RemoteEnvironmentModal({
  open,
  projectId,
  onClose,
  onOpenFile,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [view, setView] = useState<PersonalEnvironmentView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setView(await desktopApi.personalEnvironment(projectId));
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void load().catch((cause: unknown) => setError(message(cause)));
    return desktopApi.onPersonalEnvironmentChanged((change) => {
      if (change.projectId === projectId)
        void load().catch((cause: unknown) => setError(message(cause)));
    });
  }, [open, projectId, load]);

  const act = async (
    name: string,
    action: () => Promise<PersonalEnvironmentView | null>,
  ) => {
    setBusy(name);
    setError(null);
    try {
      const next = await action();
      if (next) setView(next);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const editConfig = async () => {
    setBusy("edit");
    setError(null);
    try {
      const configPath =
        await desktopApi.personalEnvironmentConfigFile(projectId);
      onOpenFile(configPath);
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  const serverNote = view ? SERVER_NOTE[view.server] : null;
  const waitReason = "Wait for the current action to finish";
  const status =
    error ??
    view?.configError ??
    view?.error ??
    (view?.syncing
      ? busy === "sync"
        ? "Sending…"
        : "Checking…"
      : view?.lastSyncAt
        ? `Sent ${ago(view.lastSyncAt, now)}`
        : view?.lastCheckedAt
          ? `Checked ${ago(view.lastCheckedAt, now)}`
          : null);
  const statusIsError = Boolean(error ?? view?.configError ?? view?.error);

  return (
    <Modal open={open} onClose={onClose} width={520}>
      <div className="flex max-h-[min(680px,80vh)] flex-col">
        <header className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-fg-muted" />
            <h2 className="text-[15px] font-semibold text-fg">
              Remote environment
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Files you choose and your own setup, for your sessions on this
            project's server. Only your sessions receive them, and they are
            never committed or shared with other members. Keys and other values
            your sessions need as environment variables belong under Secrets.
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {serverNote && (
            <p
              className="rounded-md bg-bg-inset px-3 py-2 text-xs leading-5 text-fg-muted"
              data-testid="remote-environment-server"
            >
              {serverNote}
            </p>
          )}

          <section
            className="flex flex-col gap-2"
            data-testid="remote-environment-sign-ins"
          >
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Sign-ins
            </h3>
            <p className="text-xs leading-5 text-fg-muted">
              Claude Code and Codex subscriptions stay on the computer you
              signed in on. A chat that uses one runs only on a machine where
              you signed in to it yourself, such as this computer when it is
              connected to the project. Nothing about your sign-ins is sent to
              the server.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Files
              </h3>
              <PendingButton
                type="button"
                pending={busy === "add"}
                disabled={busy !== null || Boolean(view?.configError)}
                data-disabled-reason={
                  view?.configError ? "Fix the config file first" : waitReason
                }
                onClick={() =>
                  void act("add", () =>
                    desktopApi.personalEnvironmentAddFiles(projectId),
                  )
                }
                className="button-primary button-sm"
                data-testid="remote-environment-add-files"
              >
                <Plus className="size-3.5" />
                Add files
              </PendingButton>
            </div>
            {view && view.files.length === 0 && (
              <p className="text-xs text-fg-muted">
                No files yet. Add files such as .env that your sessions on the
                server need but the repository does not contain.
              </p>
            )}
            {view?.files.map((file) => (
              <article
                key={file.path}
                className="flex items-center gap-3 rounded-xl border border-border p-3"
                data-testid="remote-environment-file"
              >
                <FileText className="size-4 shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate font-mono text-[12px] text-fg"
                    title={file.path}
                  >
                    {file.path}
                  </p>
                  <p
                    className={`truncate text-xs ${file.problem ? "text-warning" : "text-fg-faint"}`}
                  >
                    {file.problem ??
                      [
                        file.bytes === null ? null : size(file.bytes),
                        file.server
                          ? `on the server, sent ${ago(file.server.updatedAt, now)}`
                          : view.server === "allowed"
                            ? "not sent yet"
                            : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                  </p>
                </div>
                <PendingButton
                  type="button"
                  pending={busy === `remove:${file.path}`}
                  disabled={busy !== null}
                  data-disabled-reason={waitReason}
                  onClick={() =>
                    void act(`remove:${file.path}`, () =>
                      desktopApi.personalEnvironmentRemoveFile({
                        projectId,
                        path: file.path,
                      }),
                    )
                  }
                  className="button-ghost button-sm"
                  aria-label={`Remove ${file.path}`}
                >
                  Remove
                </PendingButton>
              </article>
            ))}
          </section>

          <section
            className="flex flex-col gap-2"
            data-testid="remote-environment-setup"
          >
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Setup
            </h3>
            {view?.setup ? (
              <article className="flex items-start gap-3 rounded-xl border border-border p-3">
                <Terminal className="mt-0.5 size-4 shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-fg">
                    {view.setup.command}
                  </pre>
                  <p className="mt-1 truncate text-xs text-fg-faint">
                    {view.setup.server
                      ? `On the server, sent ${ago(view.setup.server.updatedAt, now)}`
                      : view.server === "allowed"
                        ? "Not sent yet"
                        : "Runs after the project's setup"}
                  </p>
                </div>
              </article>
            ) : (
              <p className="text-xs leading-5 text-fg-muted">
                No setup command. Add <code className="font-mono">"setup"</code>{" "}
                to the config to install your own tools in each new workspace,
                after the project's setup runs.
              </p>
            )}
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-5 py-3.5">
          <p
            className={`min-h-5 min-w-0 flex-1 truncate text-xs leading-5 ${statusIsError ? "text-danger" : "text-fg-faint"}`}
            role={statusIsError ? "alert" : undefined}
            data-testid="remote-environment-status"
          >
            {status}
          </p>
          <PendingButton
            type="button"
            pending={busy === "edit"}
            disabled={busy !== null}
            data-disabled-reason={waitReason}
            onClick={() => void editConfig()}
            className="button-secondary"
          >
            Edit config
          </PendingButton>
          <PendingButton
            type="button"
            pending={busy === "sync" || Boolean(view?.syncing)}
            disabled={busy !== null}
            data-disabled-reason={waitReason}
            onClick={() =>
              void act("sync", () =>
                desktopApi.personalEnvironmentSync(projectId),
              )
            }
            className="button-secondary"
          >
            <RefreshCw className="size-3.5" />
            Send now
          </PendingButton>
          <button type="button" onClick={onClose} className="button-ghost">
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 102.4) / 10} KB`;
}
