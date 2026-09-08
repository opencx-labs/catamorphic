import { Download, Link2, LoaderCircle, PlugZap, Server } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Screen } from "../components/screen.js";
import { type ConnectLink, parseConnectLink } from "../lib/connect-link.js";
import {
  beginRemoteAuthorization,
  beginServerAuthorization,
} from "../lib/oauth.js";
import type { RemotePwaConnection } from "../lib/store.js";

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

export function stashRemoteConnection(connection: RemotePwaConnection) {
  stashPendingLink({
    serverUrl: connection.serverUrl,
    remoteProjectId: connection.projectId,
    ...(connection.projectName
      ? { remoteProjectName: connection.projectName }
      : {}),
  });
}

/**
 * Start browser sign-in for a credential-free project locator. The callback
 * verifies membership and stores the resulting connection in App.
 */
export function ConnectScreen({
  canGoBack,
  animation,
}: {
  canGoBack: boolean;
  animation?: string;
}) {
  const [raw, setRaw] = useState(() => {
    if (!pendingLink) return "";
    const link = pendingLink;
    pendingLink = null;
    const params = new URLSearchParams({
      server: link.serverUrl,
      project: link.remoteProjectId,
    });
    if (link.remoteProjectName) params.set("name", link.remoteProjectName);
    if (link.invitationId) params.set("invitation", link.invitationId);
    if (link.sessionId) params.set("session", link.sessionId);
    return `catamorphic://connect?${params.toString()}`;
  });
  const [busy, setBusy] = useState(false);
  const [hostedServerUrl, setHostedServerUrl] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const stashed = pendingError;
    pendingError = null;
    return stashed;
  });

  const link = raw.trim() ? parseConnectLink(raw) : null;

  useEffect(() => {
    let cancelled = false;
    void detectHostedServer(window.location.origin).then((serverUrl) => {
      if (!cancelled) setHostedServerUrl(serverUrl);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (!link || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await beginRemoteAuthorization({
        link,
        redirectUri: `${window.location.origin}/oauth/callback`,
      });
      window.location.assign(started.authorizationUrl);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  };

  const connectHostedServer = async () => {
    if (!hostedServerUrl || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await beginServerAuthorization({
        serverUrl: hostedServerUrl,
        redirectUri: `${window.location.origin}/oauth/callback`,
      });
      window.location.assign(started.authorizationUrl);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not reach the server.",
      );
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
        {hostedServerUrl && (
          <section className="flex flex-col gap-3 rounded-2xl border border-border bg-bg-raised p-4">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Server className="size-4 text-accent" />
              This server
            </span>
            <p className="text-sm leading-6 text-fg-muted">
              Already a member? Sign in to see every project you can access.
            </p>
            <button
              type="button"
              onClick={() => void connectHostedServer()}
              disabled={busy}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-35"
            >
              {busy && <LoaderCircle className="size-4 animate-spin" />}
              Sign in to this server
            </button>
            <div className="grid grid-cols-2 gap-2">
              <a
                href="https://catamorphic.ai/desktop/"
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-3 text-center text-xs font-medium text-fg-muted"
              >
                <Download className="size-4" />
                Get the desktop app
              </a>
              <a
                href="https://catamorphic.ai/agents/"
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-3 text-center text-xs font-medium text-fg-muted"
              >
                <PlugZap className="size-4" />
                Connect with MCP
              </a>
            </div>
          </section>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void connect(event)}
        >
          <textarea
            className="field min-h-24 w-full resize-none p-3 font-mono text-[16px] leading-6 outline-none placeholder:text-fg-faint"
            placeholder="catamorphic://connect?server=…&project=…"
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              setAttempted(false);
              setError(null);
            }}
            onBlur={() => setAttempted(true)}
            required
            aria-invalid={attempted && !link ? "true" : undefined}
            aria-errormessage="connect-link-error"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="connect-input"
          />
          {attempted && !link && (
            <p
              id="connect-link-error"
              className="text-[13px] text-danger"
              role="alert"
            >
              That doesn't look like a connect link.
            </p>
          )}
          {error && (
            <p
              className="text-[13px] text-danger"
              data-testid="connect-error"
              role="alert"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-accent text-[15px] font-semibold text-accent-fg transition-[opacity,transform] duration-150 active:scale-[0.99] disabled:opacity-35"
            data-testid="connect-submit"
          >
            {busy && <LoaderCircle className="size-4 animate-spin" />}
            {busy ? "Opening sign-in…" : "Sign in and connect"}
          </button>
        </form>
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

async function detectHostedServer(origin: string): Promise<string | null> {
  try {
    const response = await fetch(
      new URL("/.well-known/oauth-protected-resource", origin),
    );
    if (!response.ok) return null;
    const metadata = (await response.json()) as { resource?: unknown };
    if (typeof metadata.resource !== "string") return null;
    const resource = new URL(metadata.resource);
    if (resource.origin !== origin || resource.pathname !== "/api") return null;
    return resource.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
