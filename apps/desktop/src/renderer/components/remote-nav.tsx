import { Clock3, Download, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  desktopApi,
  type RemoteProjectStatus,
  type RemoteShipReport,
  type RemoteSyncReport,
} from "../lib/desktop-api.js";
import { PendingButton } from "./pending-button.js";

/**
 * The sidebar's Server section for a remote project (ADR 0055): where the
 * folder syncs from, when it last did, what changed locally, and the two
 * verbs — Sync (pull) and Ship (push store edits with version checks).
 * Empty (and hidden) for projects that are not connected to a server.
 */

const REFRESH_MS = 15_000;

export function RemoteNav({
  projectId,
  onEmptyChange,
  onOpenFile,
  onOpenHistory,
}: {
  projectId: string;
  onEmptyChange?: (empty: boolean) => void;
  onOpenFile: (path: string) => void;
  onOpenHistory: (path: string) => void;
}) {
  const [status, setStatus] = useState<RemoteProjectStatus | null>(null);
  const [busy, setBusy] = useState<"sync" | "ship" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await desktopApi.remoteStatus(projectId));
    } catch {
      setStatus(null);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const unsubscribe = desktopApi.onGitChanged((change) => {
      if (change.projectId === projectId) void refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [projectId, refresh]);

  const isEmpty = status === null;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);

  if (!status) return null;

  const run = async (verb: "sync" | "ship") => {
    setBusy(verb);
    setMessage(null);
    try {
      const report =
        verb === "sync"
          ? await desktopApi.remoteSync(projectId)
          : await desktopApi.remoteShip(projectId);
      setMessage(describe(verb, report));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const localCount = status.local.modified.length + status.local.deleted.length;
  const host = (() => {
    try {
      return new URL(status.serverUrl).host;
    } catch {
      return status.serverUrl;
    }
  })();

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-1">
      <p className="truncate text-xs text-fg-muted" title={status.serverUrl}>
        {host}
        <span className="text-fg-faint">
          {" · "}
          {status.lastSyncAt
            ? `synced ${ago(status.lastSyncAt)}`
            : "not synced"}
        </span>
      </p>
      <div className="flex items-center gap-1.5">
        <PendingButton
          type="button"
          pending={busy === "sync"}
          disabled={busy !== null}
          onClick={() => void run("sync")}
          data-testid="remote-sync"
          className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Download className="size-3.5" />
          Sync
        </PendingButton>
        <PendingButton
          type="button"
          pending={busy === "ship"}
          disabled={busy !== null || localCount === 0}
          onClick={() => void run("ship")}
          data-testid="remote-ship"
          className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Upload className="size-3.5" />
          Ship{localCount > 0 ? ` ${localCount}` : ""}
        </PendingButton>
      </div>
      {message && (
        <p className="text-xs text-fg-faint" data-testid="remote-message">
          {message}
        </p>
      )}
      {localCount > 0 && (
        <ul className="flex flex-col gap-0.5">
          {status.local.modified.map((path) => (
            <ChangeRow
              key={path}
              path={path}
              badge="M"
              onOpen={() => onOpenFile(path)}
              onHistory={() => onOpenHistory(path)}
            />
          ))}
          {status.local.deleted.map((path) => (
            <ChangeRow
              key={path}
              path={path}
              badge="D"
              onHistory={() => onOpenHistory(path)}
            />
          ))}
        </ul>
      )}
      {status.local.programEdits.length > 0 && (
        <p className="text-xs text-warning">
          {status.local.programEdits.length} edited outside store/ won't ship —
          the program changes by commit.
        </p>
      )}
    </div>
  );
}

function ChangeRow({
  path,
  badge,
  onOpen,
  onHistory,
}: {
  path: string;
  badge: "M" | "D";
  onOpen?: () => void;
  onHistory: () => void;
}) {
  const name = path.split("/").at(-1) ?? path;
  return (
    <li className="group flex h-6 items-center gap-1.5 rounded-md pl-1 pr-0.5 text-xs hover:bg-bg-overlay">
      <span
        className={`w-3 shrink-0 text-center font-mono text-[10px] ${
          badge === "M" ? "text-info" : "text-danger"
        }`}
      >
        {badge}
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={path}
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-fg-muted transition-colors duration-150 hover:text-fg disabled:cursor-default"
      >
        {name}
      </button>
      <button
        type="button"
        onClick={onHistory}
        title="History"
        aria-label={`History of ${name}`}
        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-faint opacity-0 transition-opacity duration-150 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Clock3 className="size-3" />
      </button>
    </li>
  );
}

function describe(
  verb: "sync" | "ship",
  report: RemoteSyncReport | RemoteShipReport,
): string {
  if (verb === "sync") {
    const r = report as RemoteSyncReport;
    const parts: string[] = [];
    if (r.pulled.length) parts.push(`${r.pulled.length} pulled`);
    if (r.removed.length) parts.push(`${r.removed.length} removed`);
    if (r.conflicts.length) {
      parts.push(`${r.conflicts.length} kept both (see "(server v…)" files)`);
    }
    return parts.length ? parts.join(", ") : "Up to date";
  }
  const r = report as RemoteShipReport;
  const parts: string[] = [];
  if (r.shipped.length) parts.push(`${r.shipped.length} shipped`);
  if (r.deleted.length) parts.push(`${r.deleted.length} deleted`);
  if (r.conflicts.length) {
    parts.push(
      `${r.conflicts.length} conflicted — server copy saved beside yours`,
    );
  }
  if (r.notShippable.length) {
    parts.push(`${r.notShippable.length} outside store/ not shipped`);
  }
  return parts.length ? parts.join(", ") : "Nothing to ship";
}

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
