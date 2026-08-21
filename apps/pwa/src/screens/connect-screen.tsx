import { Link2, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Screen } from "../components/screen.js";
import { clientFor, fetchMe } from "../lib/api.js";
import { type ConnectLink, parseConnectLink } from "../lib/connect-link.js";
import { navigate } from "../lib/nav.js";
import { activeProfile, addConnection, usePwaState } from "../lib/store.js";

/** A connect link that arrived via the PWA's own URL, waiting to be shown. */
let pendingLink: ConnectLink | null = null;
/** A failure from the URL-intake flows (e.g. an expired pairing QR). */
let pendingError: string | null = null;

export function stashConnectError(message: string) {
  pendingError = message;
}

export function stashPendingLink(link: ConnectLink) {
  pendingLink = link;
}

/**
 * Redeem a connect link: paste (or arrive with) an invite, verify it
 * against the server, and store the connection on the active profile.
 */
export function ConnectScreen({
  canGoBack,
  animation,
}: {
  canGoBack: boolean;
  animation?: string;
}) {
  const state = usePwaState();
  const profile = activeProfile(state);
  const [raw, setRaw] = useState(() => {
    if (!pendingLink) return "";
    const link = pendingLink;
    pendingLink = null;
    return `catamorphic://connect?server=${encodeURIComponent(link.serverUrl)}&token=${encodeURIComponent(link.token)}&project=${encodeURIComponent(link.remoteProjectId)}${link.remoteProjectName ? `&name=${encodeURIComponent(link.remoteProjectName)}` : ""}${link.sessionId ? `&session=${encodeURIComponent(link.sessionId)}` : ""}`;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const stashed = pendingError;
    pendingError = null;
    return stashed;
  });

  const link = raw.trim() ? parseConnectLink(raw) : null;

  const connect = async () => {
    if (!link || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await fetchMe({
        serverUrl: link.serverUrl,
        token: link.token,
      });
      // Best effort: the project's display name straight from the server.
      let projectName = link.remoteProjectName;
      try {
        const client = clientFor({
          id: "probe",
          serverUrl: link.serverUrl,
          token: link.token,
          projectId: link.remoteProjectId,
          addedAt: "",
        });
        const project = await client.GET("/api/projects/{projectId}", {
          params: { path: { projectId: link.remoteProjectId } },
        });
        if (project.data?.name) projectName = project.data.name;
      } catch {
        // The scope may not cover the project record; the link name is fine.
      }
      const connection = addConnection(profile.id, link, projectName);
      void me;
      // A `session` param (a desktop QR onto the remote server) lands in
      // that exact chat — mirroring keeps it there under the same id.
      navigate(
        link.sessionId
          ? {
              kind: "chat",
              connectionId: connection.id,
              projectId: connection.projectId,
              sessionId: link.sessionId,
            }
          : {
              kind: "sessions",
              connectionId: connection.id,
              projectId: connection.projectId,
            },
        { replace: !canGoBack },
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Connect a project" back={canGoBack} animation={animation}>
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <div className="mt-4 flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-2xl border border-border bg-bg-raised">
            <Link2 className="size-6 text-accent" />
          </span>
          <p className="max-w-xs text-sm leading-6 text-fg-muted">
            Paste the invite link you were given. It connects this profile to
            one project on a Catamorphic server.
          </p>
        </div>
        <textarea
          className="field min-h-24 w-full resize-none p-3 font-mono text-[13px] leading-5 outline-none placeholder:text-fg-faint"
          placeholder="catamorphic://connect?server=…&token=…&project=…"
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value);
            setError(null);
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-testid="connect-input"
        />
        {raw.trim() && !link && (
          <p className="text-[13px] text-danger">
            That doesn't look like a connect link.
          </p>
        )}
        {error && (
          <p className="text-[13px] text-danger" data-testid="connect-error">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={!link || busy}
          onClick={() => void connect()}
          className="flex h-12 items-center justify-center gap-2 rounded-xl bg-accent text-[15px] font-semibold text-accent-fg transition-[opacity,transform] duration-150 active:scale-[0.99] disabled:opacity-35"
          data-testid="connect-submit"
        >
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {busy ? "Checking the invite…" : "Connect"}
        </button>
        {link && (
          <p className="text-center text-xs text-fg-faint">
            {new URL(link.serverUrl).host}
            {link.remoteProjectName ? ` · ${link.remoteProjectName}` : ""}
          </p>
        )}
      </div>
    </Screen>
  );
}
