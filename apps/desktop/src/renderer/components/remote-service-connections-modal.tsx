import { KeyRound, Plus, RefreshCw } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  desktopApi,
  type RemoteAuthorizationChallenge,
  type RemoteConnectionProvider,
  type RemoteServiceConnection,
} from "../lib/desktop-api.js";
import { ChallengeField } from "./challenge-field.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

/** Service connection names, as the server accepts them (ADR 0172). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const STATUS_LABEL: Record<RemoteServiceConnection["status"], string> = {
  pending: "Not connected",
  ready: "Connected",
  expired: "Expired",
  revoked: "Revoked",
};

type FormChallenge = Extract<RemoteAuthorizationChallenge, { kind: "form" }>;

interface Authorization {
  connectionId: string;
  authorizationId: string;
  challenge: RemoteAuthorizationChallenge;
}

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The organization's named service connections on a Work server, for its
 * administrators (ADR 0172): add one, authorize or rotate it through the
 * provider's own challenge, and revoke it.
 */
export function RemoteServiceConnectionsModal({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<RemoteConnectionProvider[]>([]);
  const [connections, setConnections] = useState<RemoteServiceConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [providerKind, setProviderKind] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(
    null,
  );
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] =
    useState<RemoteServiceConnection | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const load = useCallback(async () => {
    const data = await desktopApi.remoteServiceConnections(projectId);
    setProviders(data.providers);
    setConnections(
      data.connections.filter((connection) => connection.status !== "revoked"),
    );
    setProviderKind((current) =>
      data.providers.some((provider) => provider.kind === current)
        ? current
        : "",
    );
    setLoaded(true);
    return data.connections;
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAuthorization(null);
    setName("");
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [open, load]);

  const providerName = (kind: string) =>
    providers.find((provider) => provider.kind === kind)?.displayName ?? kind;
  const connectionName = (connection: RemoteServiceConnection) =>
    connection.name ?? connection.label;

  const authorize = async (connectionId: string) => {
    setBusy(`authorize:${connectionId}`);
    setError(null);
    try {
      const result = await desktopApi.remoteServiceConnectionAuthorize({
        projectId,
        connectionId,
      });
      setFormValues({});
      setFormError(null);
      setAuthorization({ connectionId, ...result });
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const trimmed = name.trim();
    if (!NAME_PATTERN.test(trimmed) || !providerKind) return;
    setBusy("add");
    setError(null);
    try {
      const created = await desktopApi.remoteServiceConnectionCreate({
        projectId,
        name: trimmed,
        providerKind,
      });
      setName("");
      await load();
      await authorize(created.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy((current) => (current === "add" ? null : current));
    }
  };

  const complete = async (callback: Record<string, string>) => {
    if (!authorization) return;
    setBusy("complete");
    setFormError(null);
    setError(null);
    try {
      await desktopApi.remoteServiceConnectionComplete({
        projectId,
        authorizationId: authorization.authorizationId,
        callback,
      });
      setAuthorization(null);
      setFormValues({});
      await load();
    } catch (cause) {
      if (authorization.challenge.kind === "form") setFormError(message(cause));
      else setError(message(cause));
      // The server cancels an attempt whose completion failed, so a retry
      // needs a fresh one. The form keeps what was typed.
      try {
        const fresh = await desktopApi.remoteServiceConnectionAuthorize({
          projectId,
          connectionId: authorization.connectionId,
        });
        setAuthorization({
          connectionId: authorization.connectionId,
          ...fresh,
        });
      } catch (restart) {
        setAuthorization(null);
        setError(message(restart));
      }
    } finally {
      setBusy(null);
    }
  };

  const refreshAfterSignIn = async () => {
    if (!authorization) return;
    setBusy("refresh");
    setError(null);
    try {
      const latest = await load();
      const connection = latest.find(
        (entry) => entry.id === authorization.connectionId,
      );
      if (connection?.status === "ready") setAuthorization(null);
      else setError("The sign-in has not finished yet.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusy("revoke");
    setError(null);
    try {
      await desktopApi.remoteServiceConnectionRevoke({
        projectId,
        connectionId: revokeTarget.id,
      });
      if (authorization?.connectionId === revokeTarget.id) {
        setAuthorization(null);
      }
      setRevokeOpen(false);
      await load();
    } catch (cause) {
      setRevokeOpen(false);
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    void complete(formValues);
  };

  // The form dialog keeps its fields through the exit animation.
  const formChallenge = useRef<{
    challenge: FormChallenge;
    connection: string;
    provider: string;
  } | null>(null);
  const pendingConnection = authorization
    ? connections.find((entry) => entry.id === authorization.connectionId)
    : undefined;
  if (authorization?.challenge.kind === "form" && pendingConnection) {
    formChallenge.current = {
      challenge: authorization.challenge,
      connection: connectionName(pendingConnection),
      provider: providerName(pendingConnection.providerKind),
    };
  }

  const trimmedName = name.trim();
  const addDisabledReason = !trimmedName
    ? "Name the connection"
    : !NAME_PATTERN.test(trimmedName)
      ? "Use lowercase letters, numbers, dots, dashes, or underscores"
      : !providerKind
        ? "Choose a provider"
        : busy !== null
          ? "Wait for the current action to finish"
          : undefined;

  return (
    <Modal open={open} onClose={onClose}>
      <div className="flex max-h-[min(680px,80vh)] w-[520px] flex-col">
        <header className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-fg-muted" />
            <h2 className="text-[15px] font-semibold text-fg">
              Service connections
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Connections your organization's agents and automations use without
            anyone's personal account. Projects choose which ones each
            Environment may reach in their project settings file.
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Add a connection
            </h3>
            <div className="grid grid-cols-[1fr_160px_auto] gap-2">
              <input
                type="text"
                aria-label="Connection name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Name, like warehouse"
                spellCheck={false}
                className="field h-9 min-w-0 px-2.5 text-[13px]"
              />
              <select
                aria-label="Connection provider"
                value={providerKind}
                onChange={(event) => setProviderKind(event.target.value)}
                className="field h-9 min-w-0 px-2 text-[13px]"
              >
                <option value="" disabled>
                  Choose a provider
                </option>
                {providers.map((provider) => (
                  <option key={provider.kind} value={provider.kind}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
              <PendingButton
                type="button"
                pending={busy === "add"}
                onClick={() => void add()}
                disabled={addDisabledReason !== undefined}
                data-disabled-reason={addDisabledReason}
                className="button-primary"
              >
                <Plus className="size-3.5" />
                Add
              </PendingButton>
            </div>
            <p className="text-xs text-fg-faint">
              Names use lowercase letters, numbers, dots, dashes, and
              underscores. Environments refer to a connection by its name.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Connections
            </h3>
            {loaded && connections.length === 0 && (
              <p className="text-xs text-fg-muted">
                No service connections yet.
              </p>
            )}
            {connections.map((connection) => {
              const pending = authorization?.connectionId === connection.id;
              const challenge = pending ? authorization?.challenge : undefined;
              return (
                <article
                  key={connection.id}
                  className="rounded-xl border border-border p-3"
                  data-testid="service-connection"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-fg">
                        {connectionName(connection)}
                      </p>
                      <p className="truncate text-xs text-fg-faint">
                        {providerName(connection.providerKind)}
                        {" · "}
                        <span
                          className={
                            connection.status === "ready"
                              ? "text-success"
                              : connection.status === "expired"
                                ? "text-warning"
                                : undefined
                          }
                        >
                          {STATUS_LABEL[connection.status]}
                        </span>
                      </p>
                    </div>
                    <PendingButton
                      type="button"
                      pending={busy === `authorize:${connection.id}`}
                      disabled={busy !== null}
                      data-disabled-reason="Wait for the current action to finish"
                      onClick={() => void authorize(connection.id)}
                      className="button-secondary button-sm"
                    >
                      {connection.status === "ready" ? "Reconnect" : "Connect"}
                    </PendingButton>
                    <button
                      type="button"
                      disabled={busy !== null}
                      data-disabled-reason="Wait for the current action to finish"
                      onClick={() => {
                        setRevokeTarget(connection);
                        setRevokeOpen(true);
                      }}
                      className="button-ghost button-sm"
                    >
                      Revoke
                    </button>
                  </div>
                  {challenge?.kind === "url" && (
                    <div className="mt-2 flex items-center gap-3 rounded-md bg-bg-inset px-3 py-2">
                      <p className="min-w-0 flex-1 text-xs text-fg-muted">
                        Finish signing in on the browser tab that opened.
                      </p>
                      <PendingButton
                        type="button"
                        pending={busy === "refresh"}
                        disabled={busy !== null}
                        data-disabled-reason="Wait for the current action to finish"
                        onClick={() => void refreshAfterSignIn()}
                        className="button-secondary button-sm"
                      >
                        <RefreshCw className="size-3.5" />
                        Refresh after sign-in
                      </PendingButton>
                    </div>
                  )}
                  {challenge?.kind === "device" && (
                    <div className="mt-2 flex items-center gap-3 rounded-md bg-bg-inset px-3 py-2">
                      <p className="min-w-0 flex-1 text-xs text-fg-muted">
                        Enter the code{" "}
                        <code className="font-mono text-fg">
                          {challenge.userCode}
                        </code>{" "}
                        on the browser tab that opened, then continue.
                      </p>
                      <PendingButton
                        type="button"
                        pending={busy === "complete"}
                        disabled={busy !== null}
                        data-disabled-reason="Wait for the current action to finish"
                        onClick={() => void complete({})}
                        className="button-secondary button-sm"
                      >
                        Continue
                      </PendingButton>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
          {error && (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end border-t border-border px-5 py-3.5">
          <button type="button" onClick={onClose} className="button-ghost">
            Done
          </button>
        </footer>
      </div>

      <Modal
        open={authorization?.challenge.kind === "form"}
        onClose={() => {
          if (busy !== "complete") setAuthorization(null);
        }}
        width={420}
      >
        <form onSubmit={submitForm}>
          <div className="px-5 pt-5">
            <h2 className="text-sm font-semibold text-fg">
              Connect {formChallenge.current?.connection}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {formChallenge.current?.provider} asks for these details.
            </p>
            <div className="mt-4 space-y-3 text-xs">
              {formChallenge.current?.challenge.fields.map((field) => (
                <ChallengeField
                  key={field.name}
                  field={field}
                  value={formValues[field.name] ?? ""}
                  onChange={(value) =>
                    setFormValues((current) => ({
                      ...current,
                      [field.name]: value,
                    }))
                  }
                />
              ))}
            </div>
            <p
              className="mt-3 min-h-5 text-xs leading-5 text-danger"
              role="alert"
            >
              {formError}
            </p>
          </div>
          <footer className="mt-2 flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              type="button"
              disabled={busy === "complete"}
              data-disabled-reason="Wait for the connection to be saved"
              onClick={() => setAuthorization(null)}
              className="button-ghost"
            >
              Cancel
            </button>
            <PendingButton
              type="submit"
              pending={busy === "complete"}
              className="button-primary"
            >
              Save
            </PendingButton>
          </footer>
        </form>
      </Modal>

      <Modal
        open={revokeOpen}
        onClose={() => {
          if (busy !== "revoke") setRevokeOpen(false);
        }}
        labelledBy="service-connection-revoke-title"
        width={360}
      >
        <div className="p-5">
          <h2
            id="service-connection-revoke-title"
            className="text-sm font-semibold text-fg"
          >
            Revoke {revokeTarget ? connectionName(revokeTarget) : ""}?
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-fg-muted">
            Agents and automations that use it lose access right away.
            Environments that name it stop working until you add it again.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy === "revoke"}
              data-disabled-reason="Wait for the connection to be revoked"
              onClick={() => setRevokeOpen(false)}
              className="button-ghost"
            >
              Cancel
            </button>
            <PendingButton
              type="button"
              pending={busy === "revoke"}
              onClick={() => void revoke()}
              className="button-danger"
            >
              Revoke
            </PendingButton>
          </div>
        </div>
      </Modal>
    </Modal>
  );
}
