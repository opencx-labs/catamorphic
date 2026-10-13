import {
  type SessionPullRequest,
  type SessionPullRequestState,
  sessionPullRequests,
} from "@catamorphic/agent-protocol";
import { useAgentSessionFields } from "@catamorphic/react";
import { type ReactNode, useCallback, useState } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi, type SidebarMenuEntry } from "../lib/desktop-api.js";
import { useSessionCheckout } from "../lib/use-session-checkout.js";
import { chatFolderView } from "./chat-folder.js";
import {
  ProjectAuthorityProvider,
  useRemoteAuthority,
} from "./project-authority-provider.js";
import {
  useSidebarContent,
  useSidebarContribution,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarStatusBody } from "./sidebar-status.js";
import { SidebarSubsection } from "./sidebar-subsection.js";
import { SidebarTree } from "./sidebar-tree.js";

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

/** The project's access, while it is read or when it fails, as section status. */
function AccessStatus({ error }: { error: Error | null }) {
  useSidebarContent(
    error ? { state: "error", error: error.message } : { state: "loading" },
  );
  return null;
}

interface SessionDetailsProps {
  projectId: string;
  /** The chat in front; undefined while none is (the section is leaving). */
  sessionId: string | undefined;
  /** Open a page as a link in the chat opens (a tab the chat owns). */
  onOpenUrl: (url: string, mode: OpenMode) => void;
}

/**
 * The "session" section (ADR 0226): the chat in front, where it works (its
 * folder or worktree, as its status popup says, ADR 0215) and the pull
 * requests its agent recorded in the session's metadata. Rows only; the
 * section chrome draws loading, empty and errors (ADR 0147). A connected
 * project's chat is read where the chat reads it, the project's own cache
 * on its server, so what its stream brings shows here too.
 */
export function SessionDetails(props: SessionDetailsProps) {
  return (
    <SessionAccess projectId={props.projectId}>
      <SessionRows {...props} />
    </SessionAccess>
  );
}

/**
 * Where a sidebar section reads a chat's session: the project's own access
 * (its server's cache for a connected project, shared with the chat), its
 * reading and failing shown as the section's status.
 */
export function SessionAccess({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  return (
    <ProjectAuthorityProvider
      projectId={projectId}
      fallback={(error) => <AccessStatus error={error} />}
    >
      {children}
    </ProjectAuthorityProvider>
  );
}

function SessionRows({
  projectId,
  sessionId: current,
  onOpenUrl,
}: SessionDetailsProps) {
  const contribution = useSidebarContribution();
  const section = contribution?.section;
  const relevant = contribution?.relevant ?? true;
  // A section on its way out keeps showing the chat it showed.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);
  const sessionId = current ?? shown;
  const remote = useRemoteAuthority() !== null;
  // On screen it follows the chat, so what is set outside a turn (another
  // client, a workflow) shows while a page the chat opened is in front.
  const session = useAgentSessionFields(projectId, sessionId, {
    live: relevant && (contribution?.visible ?? true),
  });
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
  // A failed read is news only when it leaves nothing to show: a refresh
  // that fails keeps the rows it had (ADR 0147).
  const nothing = !folder && pullRequests.length === 0;
  const failed = !session.fields
    ? session.error
    : nothing && !remote && !checkout.data
      ? checkout.error
      : null;
  const empty = section?.empty ?? EMPTY;
  useSidebarContent({
    state: failed ? "error" : loading ? "loading" : nothing ? "empty" : "ready",
    refreshing: !loading && checkout.isFetching && !checkout.isLoading,
    idle: !session.isLoading && !checkout.isFetching,
    error: failed ? "Could not read this chat." : undefined,
    retry: refresh,
    empty: EMPTY,
  });
  if (failed || loading || nothing) return null;
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
                  keepDescription={Boolean(pr.title && pr.number)}
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
