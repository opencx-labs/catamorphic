import type { SidebarMenuEntry } from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { workPageUrl } from "../../shared/work-pages.js";
import {
  desktopApi,
  type RemoteProjectStatus,
  type RemoteShipReport,
  type RemoteSyncReport,
} from "../lib/desktop-api.js";
import { capabilitiesOf, type SectionSource } from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";
import { isOpenAction } from "./run.js";

/** How often a connected project's status is read while a section shows it. */
const REFRESH_MS = 15_000;

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
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

function describeSync(report: RemoteSyncReport): string {
  const parts: string[] = [];
  if (report.pulled.length) parts.push(`${report.pulled.length} pulled`);
  if (report.removed.length) parts.push(`${report.removed.length} removed`);
  if (report.conflicts.length)
    parts.push(
      `${report.conflicts.length} kept both (see "(server v…)" files)`,
    );
  return parts.length ? parts.join(", ") : "Up to date";
}

function describeShip(report: RemoteShipReport): string {
  const parts: string[] = [];
  if (report.shipped.length) parts.push(`${report.shipped.length} uploaded`);
  if (report.deleted.length) parts.push(`${report.deleted.length} deleted`);
  if (report.conflicts.length)
    parts.push(
      `${report.conflicts.length} conflicted: server copy saved beside yours`,
    );
  if (report.notShippable.length)
    parts.push(`${report.notShippable.length} outside store/ not shipped`);
  if (report.failed.length)
    parts.push(
      `${report.failed.length} refused: ${report.failed.map((entry) => entry.error).join("; ")}`,
    );
  return parts.length ? parts.join(", ") : "Nothing to upload";
}

/** What reaching the server failed with, in words a person can act on. */
function reachError(cause: unknown, host: string): Error {
  const text = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    /fetch failed|Failed to fetch|ECONNREFUSED/.test(text)
      ? `Could not reach ${host}. Check that it is running and try again.`
      : text,
  );
}

function rows(status: RemoteProjectStatus): SidebarSourceItem[] {
  const host = hostOf(status.serverUrl);
  const permissions = status.capabilities?.permissions ?? [];
  // Gate on what the server advertised (GET /me); an older host advertises
  // nothing and everything stays offered (refused by 403 instead).
  const features = status.capabilities?.features;
  const canPublish = features ? features.publications !== false : true;
  const canPropose = features ? features.proposals : true;
  const reconnect =
    status.connection.state === "sign_in_required" ||
    status.connection.state === "access_removed";
  const menu: SidebarMenuEntry[] = [
    { label: "Download updates", action: "sync", icon: "Download" },
    ...(reconnect
      ? [{ label: "Sign in again", action: "reconnect", icon: "LogIn" }]
      : []),
    {
      label: "Remote environment",
      action: "open",
      icon: "ServerCog",
      url: "command:remote-environment",
    },
    // Every member sets their own secret values (ADR 0206).
    {
      label: "Secrets",
      action: "open",
      icon: "LockKeyhole",
      url: "command:server-secrets",
    },
    ...(permissions.includes("memberships:write")
      ? [
          {
            label: "Members and invites",
            action: "open",
            icon: "Users",
            url: "command:server-members",
          },
        ]
      : []),
    // Organization administrators manage service connections (ADR 0172).
    ...(status.capabilities?.administrator
      ? [
          {
            label: "Service connections",
            action: "open",
            icon: "KeyRound",
            url: "command:server-connections",
          },
        ]
      : []),
  ];
  const conflicts = new Set(
    (status.local.conflicts ?? []).map((conflict) => conflict.path),
  );
  const changed = [
    ...status.local.modified.map((path) => ({ path, deleted: false })),
    ...status.local.deleted.map((path) => ({ path, deleted: true })),
  ];
  return [
    {
      id: "server",
      label: host,
      description: status.lastSyncAt
        ? `synced ${ago(status.lastSyncAt)}`
        : "not synced",
      icon: status.connection.state === "connected" ? "Cloud" : "CloudOff",
      ...(status.connection.state === "connected"
        ? {}
        : { signal: "attention" as const }),
      menu,
      preview: {
        title: status.remoteProjectName,
        description:
          status.connection.state === "connected"
            ? `Files stay on this device until you upload them to ${host}.`
            : status.connection.message,
        metadata: [{ label: "Server", value: status.serverUrl }],
      },
      data: { serverUrl: status.serverUrl, state: status.connection.state },
    },
    ...changed.map(({ path, deleted }): SidebarSourceItem => {
      const conflict = conflicts.has(path);
      return {
        id: path,
        label: path,
        icon: "File",
        badges: [
          deleted ? "Deleted" : "Modified",
          ...(conflict ? ["Conflict"] : []),
        ],
        ...(deleted ? {} : { url: `file:${path}` }),
        menu: [
          conflict
            ? {
                label: "Upload, replacing the server's copy",
                action: "upload",
                icon: "Upload",
              }
            : { label: "Upload", action: "upload", icon: "Upload" },
          {
            label: "History",
            action: "open",
            icon: "History",
            url: workPageUrl({ page: "server-history", path }),
          },
          ...(!deleted && canPublish
            ? [
                {
                  label: "Publish…",
                  action: "open",
                  icon: "Globe",
                  url: workPageUrl({ page: "server-publish", path }),
                },
              ]
            : []),
        ],
        data: { path, deleted, conflict },
      };
    }),
    ...(status.local.programEdits.length
      ? [
          {
            id: "program-edits",
            label:
              status.local.programEdits.length === 1
                ? "1 project file needs review before sharing"
                : `${status.local.programEdits.length} project files need review before sharing`,
            icon: "TriangleAlert",
            signal: "attention" as const,
            ...(canPropose
              ? {
                  url: workPageUrl({
                    page: "server-propose",
                    paths: status.local.programEdits,
                  }),
                }
              : {
                  description: "This server takes no proposals.",
                }),
            data: { paths: status.local.programEdits },
          },
        ]
      : []),
  ];
}

/**
 * `work:remote`: a connected project's server (ADR 0055). A row for the
 * server and its dialogs, a row per file changed on this device (upload,
 * history, publish), and the project files that need a proposal. Empty for
 * a project with no server.
 */
export function remoteSource(deps: WorkSourceDeps): SectionSource {
  const status = () => desktopApi.remoteStatus(deps.projectId);
  const source: SectionSource = {
    title: "Server",
    empty: "This project is not connected to a server.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId }) => {
      if (parentId) return { items: [] };
      const current = await status();
      return { items: current ? rows(current) : [] };
    },
    subscribe: (publish) => {
      const refresh = () => publish({ type: "invalidate", quiet: true });
      const timer = setInterval(() => {
        if (!document.hidden) refresh();
      }, REFRESH_MS);
      const stop = desktopApi.onGitChanged((change) => {
        if (change.projectId === deps.projectId) refresh();
      });
      return () => {
        clearInterval(timer);
        stop();
      };
    },
    action: async ({ itemId, action }) => {
      // Its rows without an address (the server, a deleted file, nothing to
      // propose) open nothing; their verbs are in their menus.
      if (isOpenAction(action)) return undefined;
      const current = await status();
      if (!current) throw new Error("This project is not connected.");
      const host = hostOf(current.serverUrl);
      if (action === "reconnect") {
        await desktopApi.remoteReconnect(deps.projectId);
        return undefined;
      }
      if (action === "sync")
        return {
          message: describeSync(
            await desktopApi
              .remoteSync(deps.projectId)
              .catch((cause: unknown) => {
                throw reachError(cause, host);
              }),
          ),
        };
      const conflicts = new Set(
        (current.local.conflicts ?? []).map((conflict) => conflict.path),
      );
      // Upload all leaves conflicts to the person, one file at a time.
      const paths =
        action === "upload-all"
          ? [...current.local.modified, ...current.local.deleted].filter(
              (path) => !conflicts.has(path),
            )
          : action === "upload"
            ? [itemId]
            : null;
      if (!paths) throw new Error("The server does not support that action");
      return {
        message: describeShip(
          await desktopApi
            .remoteShip({
              projectId: deps.projectId,
              paths,
              resolveConflicts: paths.filter((path) => conflicts.has(path)),
            })
            .catch((cause: unknown) => {
              throw reachError(cause, host);
            }),
        ),
      };
    },
  };
  return source;
}
