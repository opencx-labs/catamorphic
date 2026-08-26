import { CloudOff, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { desktopApi, type RemoteProjectStatus } from "../lib/desktop-api.js";
import { PendingButton } from "./pending-button.js";

export function RemoteMessageConnectionGuard({
  projectId,
  checkNonce,
}: {
  projectId: string;
  checkNonce: number;
}) {
  const [status, setStatus] = useState<RemoteProjectStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    const next = await desktopApi.remoteStatus(projectId);
    setStatus(next && next.connection.state !== "connected" ? next : null);
    return next;
  }, [projectId]);

  useEffect(() => {
    if (checkNonce === 0) return;
    void check();
  }, [check, checkNonce]);

  if (!status) return null;
  const reconnect =
    status.connection.state === "sign_in_required" ||
    status.connection.state === "access_removed";
  const action = async () => {
    setBusy(true);
    try {
      if (reconnect) await desktopApi.remoteReconnect(projectId);
      await check();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mx-3 mb-1 flex shrink-0 animate-fade-in items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 py-2 pl-3 pr-2 text-xs text-fg"
      role="alert"
      data-testid="remote-message-connection-guard"
    >
      {reconnect ? (
        <KeyRound className="size-3.5 shrink-0 text-warning" />
      ) : (
        <CloudOff className="size-3.5 shrink-0 text-warning" />
      )}
      <span className="min-w-0 flex-1">
        {status.connection.message} Your message is local until this project
        reconnects.
      </span>
      <PendingButton
        type="button"
        pending={busy}
        onClick={() => void action()}
        className="shrink-0 cursor-pointer rounded-md bg-warning/20 px-2 py-1 font-medium transition-colors duration-150 hover:bg-warning/30"
      >
        {reconnect ? "Sign in again" : "Retry"}
      </PendingButton>
    </div>
  );
}
