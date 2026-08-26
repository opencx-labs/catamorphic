import { CloudOff, ExternalLink, LogIn } from "lucide-react";
import { navigate } from "../lib/nav.js";
import { findConnection, getState, type PwaConnection } from "../lib/store.js";
import { stashRemoteConnection } from "../screens/connect-screen.js";

/**
 * A connection failed to answer. Say WHY it probably failed in human
 * terms (a paired desktop sleeps; a phone leaves the Wi-Fi), and when
 * this project also lives on a remote server (the desktop's mirror
 * hint from pairing), offer that server as the way in — same project,
 * different backend, its own sessions.
 */
export function ConnectionTrouble({
  connection,
  projectId,
  message,
}: {
  connection: PwaConnection;
  projectId: string;
  message: string;
}) {
  const networkish = /fetch|network|load failed|failed to load/i.test(message);
  const label = connection.projectName ?? new URL(connection.serverUrl).host;
  const mirror = connection.mirrors?.[projectId];
  const mirrorConnection = mirror
    ? findConnection(getState(), mirror.serverUrl, mirror.projectId)
    : undefined;
  const needsSignIn =
    connection.kind === "remote" &&
    (connection.credentials === undefined ||
      /sign in|access token|\b401\b|authentication/i.test(message));
  const mirrorNeedsSignIn =
    mirrorConnection?.kind === "remote" &&
    mirrorConnection.credentials === undefined;
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-bg-raised p-4"
      data-testid="connection-trouble"
    >
      <div className="flex items-start gap-3">
        <CloudOff className="mt-0.5 size-4 shrink-0 text-fg-faint" />
        <p className="text-sm leading-6 text-fg-muted">
          {networkish
            ? `Can't reach ${label}. It may be asleep, or you're on a different network.`
            : message}
        </p>
      </div>
      {needsSignIn && (
        <button
          type="button"
          onClick={() => {
            stashRemoteConnection(connection);
            navigate({ kind: "connect" });
          }}
          className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-accent/50 bg-accent/10 text-[14px] font-medium text-accent active:scale-[0.99]"
          data-testid="remote-sign-in"
        >
          <LogIn className="size-4" />
          Sign in to {label}
        </button>
      )}
      {mirror && mirrorConnection && (
        <button
          type="button"
          onClick={() => {
            if (mirrorNeedsSignIn) {
              stashRemoteConnection(mirrorConnection);
              navigate({ kind: "connect" });
              return;
            }
            navigate({
              kind: "sessions",
              connectionId: mirrorConnection.id,
              projectId: mirror.projectId,
            });
          }}
          className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-accent/50 bg-accent/10 text-[14px] font-medium text-accent active:scale-[0.99]"
          data-testid="open-mirror"
        >
          {mirrorNeedsSignIn ? (
            <LogIn className="size-4" />
          ) : (
            <ExternalLink className="size-4" />
          )}
          {mirrorNeedsSignIn
            ? `Sign in to ${new URL(mirror.serverUrl).host}`
            : `This project also lives on ${new URL(mirror.serverUrl).host}. Open there`}
        </button>
      )}
    </div>
  );
}
