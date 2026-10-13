import { useAgentSessionFields } from "@catamorphic/react";
import { useCallback, useState } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi, type SidebarMenuEntry } from "../lib/desktop-api.js";
import { useSessionCheckout } from "../lib/use-session-checkout.js";
import { chatFolderView } from "./chat-folder.js";
import { useRemoteProject } from "./project-authority-provider.js";
import {
  useSidebarContent,
  useSidebarContribution,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarStatusBody } from "./sidebar-status.js";
import { SidebarSubsection } from "./sidebar-subsection.js";
import { SidebarTree } from "./sidebar-tree.js";

/** The states a recorded pull request can say it is in (ADR 0225). */
export type SessionPullRequestState = "open" | "draft" | "merged" | "closed";

export interface SessionPullRequest {
  url: string;
  number?: number;
  title?: string;
  state?: SessionPullRequestState;
}

const STATES: readonly SessionPullRequestState[] = [
  "open",
  "draft",
  "merged",
  "closed",
];

/**
 * The pull requests an agent recorded on its session under the
 * `pull_requests` key (ADR 0225): an array of `{ url, number?, title?,
 * state? }`. Metadata is written by agents, so anything else in it is left
 * out: entries without a web address, repeated addresses, unknown fields.
 */
export function sessionPullRequests(metadata: unknown): SessionPullRequest[] {
  const value =
    typeof metadata === "object" && metadata !== null
      ? Object.entries(metadata).find(([key]) => key === "pull_requests")?.[1]
      : undefined;
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry): SessionPullRequest[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return [];
    const record = Object.fromEntries(Object.entries(entry));
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return [];
    seen.add(url);
    const number =
      typeof record.number === "number" &&
      Number.isInteger(record.number) &&
      record.number > 0
        ? record.number
        : undefined;
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : undefined;
    const state = STATES.find((candidate) => candidate === record.state);
    return [
      {
        url,
        ...(number !== undefined ? { number } : {}),
        ...(title ? { title } : {}),
        ...(state ? { state } : {}),
      },
    ];
  });
}

const STATE_ICONS: Record<SessionPullRequestState, string> = {
  open: "GitPullRequest",
  draft: "GitPullRequestDraft",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

/** Where a pull request lives: `owner/name` on a forge, else the host. */
function repositoryOf(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    const [owner, name] = pathname.split("/").filter(Boolean);
    return owner && name ? `${owner}/${name}` : host;
  } catch {
    return url;
  }
}

/** A pull request's row: its title and number, and a state unless open. */
function pullRequestRow(pr: SessionPullRequest) {
  const address = pr.url.replace(/^https?:\/\//i, "");
  return {
    label: pr.title ?? (pr.number ? `Pull request #${pr.number}` : address),
    description: pr.title && pr.number ? `#${pr.number}` : repositoryOf(pr.url),
    icon: STATE_ICONS[pr.state ?? "open"],
    badges:
      pr.state && pr.state !== "open"
        ? [`${pr.state.charAt(0).toUpperCase()}${pr.state.slice(1)}`]
        : undefined,
    address,
  };
}

const PULL_REQUEST_MENU: SidebarMenuEntry[] = [
  { label: "Copy link", action: "copy-url" },
];
const FOLDER_MENU: SidebarMenuEntry[] = [
  { label: "Open folder", action: "open" },
  { label: "Copy path", action: "copy-url" },
];

/** What "No pull requests yet." says unless workspace.js says otherwise. */
const EMPTY = "No pull requests yet.";

/**
 * The "session" section (ADR 0225): the chat in front, where it works (its
 * folder or worktree, as its status popup says, ADR 0215) and the pull
 * requests its agent recorded in the session's metadata. Rows only; the
 * section chrome draws loading, empty and errors (ADR 0147).
 */
export function SessionDetails({
  projectId,
  sessionId: current,
  onOpenUrl,
}: {
  projectId: string;
  /** The chat in front; undefined while none is (the section is leaving). */
  sessionId: string | undefined;
  onOpenUrl: (url: string, mode: OpenMode) => void;
}) {
  const contribution = useSidebarContribution();
  const section = contribution?.section;
  const relevant = contribution?.relevant ?? true;
  // A section on its way out keeps showing the chat it showed.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);
  const sessionId = current ?? shown;
  const remote = useRemoteProject(projectId);
  const session = useAgentSessionFields(projectId, sessionId);
  const checkout = useSessionCheckout(projectId, sessionId, {
    enabled: !remote && relevant,
  });
  const refresh = useCallback(
    () => Promise.all([session.refetch(), !remote && checkout.refetch()]),
    [session.refetch, checkout.refetch, remote],
  );
  useSidebarRefresh(refresh);
  const pullRequests = sessionPullRequests(session.fields?.metadata);
  const folder =
    !remote && checkout.data
      ? chatFolderView({
          started: true,
          detail: checkout.data,
          draftWorktree: false,
          // Moving the chat stays in its status popup; only the words matter.
          worktreesAvailable: false,
        })
      : undefined;
  const loading =
    !sessionId ||
    session.isLoading ||
    (!remote && checkout.isLoading && !checkout.error);
  const error = session.error?.message ?? checkout.error?.message;
  const empty = section?.empty ?? EMPTY;
  useSidebarContent({
    state: error
      ? "error"
      : loading
        ? "loading"
        : folder || pullRequests.length > 0
          ? "ready"
          : "empty",
    refreshing: !loading && checkout.isFetching && !checkout.isLoading,
    idle: !session.isLoading && !checkout.isFetching,
    error: error ? "Could not read this chat." : undefined,
    retry: refresh,
    empty: EMPTY,
  });
  if (error || loading) return null;
  if (!folder && pullRequests.length === 0) return null;
  const folderPath = checkout.data?.path;
  const revealable = Boolean(
    folderPath && checkout.data?.present && checkout.data.available,
  );
  return (
    <div className="flex flex-col gap-1" data-session-details={sessionId}>
      {folder && (
        <SidebarSubsection label="Folder">
          <SidebarTree
            items={[{ id: "folder" }]}
            label="Folder"
            renderItem={() => (
              <SidebarItemRow
                itemId="folder"
                label={folder.value}
                description={[folder.tag, ...folder.lines]
                  .filter(Boolean)
                  .join(" · ")}
                icon={folder.kind === "primary" ? "Folder" : "FolderGit2"}
                preview={{
                  title: folder.value,
                  ...(folderPath ? { description: folderPath } : {}),
                  metadata: [
                    {
                      label: "Kind",
                      value:
                        folder.kind === "primary"
                          ? "Project folder"
                          : folder.kind === "managed"
                            ? "Own worktree"
                            : "Assigned worktree",
                    },
                    ...(checkout.data?.branch
                      ? [{ label: "Branch", value: checkout.data.branch }]
                      : []),
                  ],
                }}
                menu={FOLDER_MENU.map((entry) =>
                  entry.action === "open" && !revealable
                    ? {
                        ...entry,
                        disabledReason:
                          "The folder is not on this computer right now.",
                      }
                    : entry,
                )}
                onOpen={() => {
                  if (revealable && folderPath)
                    void desktopApi.revealFolder(folderPath);
                }}
                onAction={(entry) => {
                  if (entry.action === "open" && folderPath)
                    return desktopApi.revealFolder(folderPath);
                  if (entry.action === "copy-url" && folderPath)
                    return navigator.clipboard.writeText(folderPath);
                }}
              />
            )}
          />
        </SidebarSubsection>
      )}
      <SidebarSubsection label={folder ? "Pull requests" : undefined}>
        {pullRequests.length === 0 ? (
          <SidebarStatusBody status={{ state: "empty" }} empty={empty} />
        ) : (
          <SidebarTree
            items={pullRequests.map((pr) => ({ ...pr, id: pr.url }))}
            label="Pull requests"
            renderItem={(pr) => {
              const row = pullRequestRow(pr);
              return (
                <SidebarItemRow
                  itemId={pr.id}
                  label={row.label}
                  description={row.description}
                  icon={row.icon}
                  badges={row.badges}
                  preview={{
                    title: row.label,
                    description: row.address,
                    ...(pr.state
                      ? {
                          metadata: [
                            {
                              label: "State",
                              value: `${pr.state.charAt(0).toUpperCase()}${pr.state.slice(1)}`,
                            },
                          ],
                        }
                      : {}),
                  }}
                  resource
                  defaultOpenMode={section?.open ?? "replace"}
                  defaultMenu={PULL_REQUEST_MENU}
                  onOpen={(mode) => onOpenUrl(pr.url, mode)}
                  onAction={(entry) => {
                    if (entry.action === "copy-url")
                      return navigator.clipboard.writeText(pr.url);
                  }}
                />
              );
            }}
          />
        )}
      </SidebarSubsection>
    </div>
  );
}
