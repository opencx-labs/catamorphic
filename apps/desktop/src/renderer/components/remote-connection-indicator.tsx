import { Cloud, CloudOff, LogIn, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { desktopApi, type RemoteProjectStatus } from "../lib/desktop-api.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

const REFRESH_MS = 15_000;

export function RemoteConnectionIndicator({
  projectId,
}: {
  projectId?: string;
}) {
  const [status, setStatus] = useState<RemoteProjectStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await desktopApi.remoteStatus(projectId));
    } catch {
      setStatus((current) =>
        current
          ? {
              ...current,
              connection: {
                state: "unreachable",
                checkedAt: new Date().toISOString(),
                message: "The project server could not be reached.",
              },
            }
          : null,
      );
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!projectId || !status) return null;

  const connection = status.connection;
  const pendingChanges =
    status.local.modified.length + status.local.deleted.length;
  const reconnect =
    connection.state === "sign_in_required" ||
    connection.state === "access_removed";
  const label = statusLabel(status);
  const act = async () => {
    setBusy(true);
    try {
      if (reconnect) {
        await desktopApi.remoteReconnect(projectId);
      } else if (connection.state === "connected") {
        const latest = await desktopApi.remoteStatus(projectId);
        if (latest?.connection.state !== "connected") {
          setStatus(latest);
          return;
        }
        if (latest.local.modified.length || latest.local.deleted.length) {
          const shipped = await desktopApi.remoteShip(projectId);
          if (shipped.conflicts.length || shipped.failed.length) {
            await refresh();
            return;
          }
          // Shipping emits the shared project-change event. App owns the
          // resulting pull so automatic and manual paths share its guard.
          await refresh();
          return;
        }
        await desktopApi.remoteSync(projectId);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ShortcutHint label={label} side="bottom" delay={250}>
      <PendingButton
        type="button"
        pending={busy}
        onClick={() => void act()}
        aria-label={label}
        data-testid="remote-connection-status"
        className={`app-no-drag grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border transition-colors duration-150 ${statusClasses(connection.state, pendingChanges > 0)}`}
      >
        {statusIcon(connection.state)}
      </PendingButton>
    </ShortcutHint>
  );
}

function statusLabel(status: RemoteProjectStatus): string {
  const host = safeHost(status.serverUrl);
  switch (status.connection.state) {
    case "connected":
      if (status.local.modified.length || status.local.deleted.length) {
        const count =
          status.local.modified.length + status.local.deleted.length;
        return `${count} ${count === 1 ? "change" : "changes"} waiting to sync with ${host}. Click to sync now.`;
      }
      return `Connected to ${host}. Click to sync now.`;
    case "sign_in_required":
      return `Sign in again to ${host}.`;
    case "access_removed":
      return `Access to ${status.remoteProjectName} was removed. Sign in with another account.`;
    case "unreachable":
      return `Cannot reach ${host}. Click to retry.`;
  }
}

function statusIcon(state: RemoteProjectStatus["connection"]["state"]) {
  switch (state) {
    case "connected":
      return <Cloud className="size-3.5" />;
    case "sign_in_required":
      return <LogIn className="size-3.5" />;
    case "access_removed":
      return <ShieldAlert className="size-3.5" />;
    case "unreachable":
      return <CloudOff className="size-3.5" />;
  }
}

function statusClasses(
  state: RemoteProjectStatus["connection"]["state"],
  pendingChanges: boolean,
): string {
  if (state === "connected" && pendingChanges) {
    return "border-warning/40 bg-warning/10 text-warning hover:bg-warning/15";
  }
  switch (state) {
    case "connected":
      return "border-success/35 bg-success/10 text-success hover:bg-success/15";
    case "sign_in_required":
    case "access_removed":
      return "border-danger/40 bg-danger/10 text-danger hover:bg-danger/15";
    case "unreachable":
      return "border-warning/40 bg-warning/10 text-warning hover:bg-warning/15";
  }
}

function safeHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}
