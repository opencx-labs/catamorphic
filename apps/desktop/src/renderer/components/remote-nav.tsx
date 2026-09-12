import { Download, Upload, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  desktopApi,
  type RemoteCapabilities,
  type RemoteProjectStatus,
  type RemoteShipReport,
  type RemoteSyncReport,
} from "../lib/desktop-api.js";
import {
  useSidebarContent,
  useSidebarContribution,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarTree } from "./sidebar-tree.js";

export type RemoteFeatures = RemoteCapabilities["features"];

import { PendingButton } from "./pending-button.js";
import { RemoteMembersModal } from "./remote-members-modal.js";

/**
 * The sidebar's Server section for a remote project (ADR 0055): where the
 * folder syncs from, when it last did, what changed locally, and the two
 * verbs — Sync (pull) and Ship (push store edits with version checks).
 * Empty (and hidden) for projects that are not connected to a server.
 */

const REFRESH_MS = 15_000;

export function RemoteNav({
  projectId,
  onOpenFile,
  onOpenHistory,
  onPublish,
  onPropose,
}: {
  projectId: string;
  onOpenFile: (path: string) => void;
  onOpenHistory: (path: string) => void;
  onPublish: (path: string, features: RemoteFeatures | undefined) => void;
  onPropose: (files: string[], features: RemoteFeatures | undefined) => void;
}) {
  const visible = useSidebarContribution()?.visible ?? true;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<RemoteProjectStatus | null>(null);
  const [busy, setBusy] = useState<"sync" | "ship" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await desktopApi.remoteStatus(projectId));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useSidebarRefresh(refresh);
  useEffect(() => {
    setSelected([]);
    setMessage(null);
    setStatus(null);
    void refresh();
    if (!visible) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    const unsubscribe = desktopApi.onGitChanged((change) => {
      if (change.projectId === projectId) void refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [projectId, refresh, visible]);

  const isEmpty = loaded && !error && status === null;
  useSidebarContent(
    error ? "error" : !loaded ? "loading" : isEmpty ? "empty" : "ready",
  );

  if (!status)
    return error ? (
      <p role="alert" className="sidebar-empty-state">
        {error}{" "}
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </p>
    ) : null;

  const run = async (verb: "sync" | "ship") => {
    setBusy(verb);
    setMessage(null);
    try {
      const report =
        verb === "sync"
          ? await desktopApi.remoteSync(projectId)
          : await desktopApi.remoteShip({
              projectId,
              paths: selected,
              resolveConflicts: selected.filter((path) =>
                status.local.conflicts?.some(
                  (conflict) => conflict.path === path,
                ),
              ),
            });
      setMessage(describe(verb, report));
      setSelected([]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const localCount = status.local.modified.length + status.local.deleted.length;
  // Gate on what the server advertised (GET /me); an older host advertises
  // nothing and everything stays visible (discovered by 403 instead).
  const features = status.capabilities?.features;
  const canPublish = features ? features.publications !== false : true;
  const canPropose = features ? features.proposals : true;
  const canManageMembers =
    status.capabilities?.permissions.includes("memberships:manage") ?? false;
  const reconnectNeeded =
    status.connection.state === "sign_in_required" ||
    status.connection.state === "access_removed" ||
    (message !== null && /expired or was revoked/.test(message));
  const visibleMessage =
    message ??
    (status.connection.state === "connected"
      ? null
      : status.connection.message);
  const host = (() => {
    try {
      return new URL(status.serverUrl).host;
    } catch {
      return status.serverUrl;
    }
  })();

  return (
    <>
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
            data-disabled-reason="Wait for the current server action to finish"
            onClick={() => void run("sync")}
            data-testid="remote-sync"
            className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download className="size-3.5" />
            Download updates
          </PendingButton>
          <PendingButton
            type="button"
            pending={busy === "ship"}
            disabled={busy !== null || selected.length === 0}
            data-disabled-reason="Select files to upload, or wait for the server action to finish"
            onClick={() => void run("ship")}
            data-testid="remote-ship"
            className="flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Upload className="size-3.5" />
            Upload{selected.length > 0 ? ` ${selected.length}` : ""}
          </PendingButton>
        </div>
        {canManageMembers && (
          <button
            type="button"
            onClick={() => setMembersOpen(true)}
            className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-border text-xs text-fg-muted hover:bg-bg-overlay hover:text-fg"
          >
            <Users className="size-3.5" />
            Members and invites
          </button>
        )}
        {visibleMessage && (
          <p className="text-xs text-fg-faint" data-testid="remote-message">
            {visibleMessage}
            {reconnectNeeded && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void desktopApi.remoteReconnect(projectId)}
                  data-testid="remote-renew"
                  className="cursor-pointer text-accent underline-offset-2 hover:underline"
                >
                  Sign in again
                </button>
              </>
            )}
          </p>
        )}
        <p className="text-xs text-fg-faint">
          Files stay on this device until you select them for upload to {host}.
        </p>
        {localCount > 0 && (
          <SidebarTree
            items={[
              ...status.local.modified.map((path) => ({
                id: path,
                path,
                deleted: false,
              })),
              ...status.local.deleted.map((path) => ({
                id: path,
                path,
                deleted: true,
              })),
            ]}
            label="Server changes"
            renderItem={(item) => (
              <ChangeRow
                path={item.path}
                badge={item.deleted ? "D" : "M"}
                selected={selected.includes(item.path)}
                onSelect={() =>
                  setSelected((current) =>
                    current.includes(item.path)
                      ? current.filter((path) => path !== item.path)
                      : [...current, item.path],
                  )
                }
                conflict={status.local.conflicts?.some(
                  (entry) => entry.path === item.path,
                )}
                onOpen={item.deleted ? undefined : () => onOpenFile(item.path)}
                onHistory={() => onOpenHistory(item.path)}
                onPublish={
                  !item.deleted && canPublish
                    ? () => onPublish(item.path, features)
                    : undefined
                }
              />
            )}
          />
        )}
        {status.local.programEdits.length > 0 && (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-warning">
              {status.local.programEdits.length} project files need review
              before sharing
              {canPropose ? "." : ". This server takes no proposals."}
            </p>
            {canPropose && (
              <button
                type="button"
                onClick={() => onPropose(status.local.programEdits, features)}
                data-testid="remote-propose"
                className="h-6 shrink-0 cursor-pointer rounded-md border border-border px-2 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              >
                Propose…
              </button>
            )}
          </div>
        )}
      </div>
      <RemoteMembersModal
        open={membersOpen}
        projectId={projectId}
        onClose={() => setMembersOpen(false)}
      />
    </>
  );
}

function ChangeRow({
  path,
  badge,
  onOpen,
  onHistory,
  onPublish,
  selected,
  onSelect,
  conflict,
}: {
  path: string;
  selected: boolean;
  onSelect: () => void;
  conflict?: boolean;
  badge: "M" | "D";
  onOpen?: () => void;
  onHistory: () => void;
  onPublish?: () => void;
}) {
  const name = path.split("/").at(-1) ?? path;
  return (
    <div className="flex items-center gap-1">
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        aria-label={
          conflict
            ? `Replace the server version of ${name} with my version`
            : `Upload ${name}`
        }
      />
      <div className="min-w-0 flex-1">
        <SidebarItemRow
          itemId={path}
          label={name}
          title={path}
          icon="File"
          resource={Boolean(onOpen)}
          badges={conflict ? [badge, "Keep mine"] : [badge]}
          onOpen={() => onOpen?.()}
          menu={[
            { action: "history", label: `History of ${name}`, icon: "Clock3" },
            ...(onPublish
              ? [
                  {
                    action: "publish",
                    label: `Share a link to ${name}`,
                    icon: "Link2",
                  },
                ]
              : []),
          ]}
          actions={[
            { action: "history", label: `History of ${name}`, icon: "Clock3" },
            ...(onPublish
              ? [
                  {
                    action: "publish",
                    label: `Share a link to ${name}`,
                    icon: "Link2",
                  },
                ]
              : []),
          ]}
          onAction={(entry) =>
            entry.action === "history" ? onHistory() : onPublish?.()
          }
        />
      </div>
    </div>
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
  if (r.shipped.length) parts.push(`${r.shipped.length} uploaded`);
  if (r.deleted.length) parts.push(`${r.deleted.length} deleted`);
  if (r.conflicts.length) {
    parts.push(
      `${r.conflicts.length} conflicted: server copy saved beside yours`,
    );
  }
  if (r.notShippable.length) {
    parts.push(`${r.notShippable.length} outside store/ not shipped`);
  }
  if (r.failed.length) {
    parts.push(
      `${r.failed.length} refused: ${r.failed.map((f) => f.error).join("; ")}`,
    );
  }
  return parts.length ? parts.join(", ") : "Nothing to upload";
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
