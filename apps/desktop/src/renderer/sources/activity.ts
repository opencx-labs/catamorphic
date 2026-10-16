import {
  type SessionPullRequest,
  type SessionPullRequestState,
  sessionPullRequests,
} from "@catamorphic/agent-protocol";
import { workflowKeys } from "@catamorphic/react";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { chatFolderView } from "../components/chat-folder.js";
import { desktopApi } from "../lib/desktop-api.js";
import { subscribeSidebarSessions } from "../lib/sidebar-sessions.js";
import { sessionCheckoutKey } from "../lib/use-session-checkout.js";
import { activeChatRows, chatAction } from "./chats.js";
import { capabilitiesOf, type SectionSource } from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";
import { isOpenAction } from "./run.js";

/** Run states worth a row: still going, or stopped for the person. */
const ACTIVE_RUNS = new Set([
  "pending",
  "running",
  "waiting",
  "paused",
  "failed",
]);
/** How often runs are read while a section shows them. */
const RUNS_POLL_MS = 2000;

/**
 * `work:activity`: what is going on in the project now. Chats that are
 * working or need the person, at any depth, then each workflow's runs that
 * are going or stopped (a failed one stays until it is seen to).
 */
export function activitySource(deps: WorkSourceDeps): SectionSource {
  const source: SectionSource = {
    title: "Activity",
    empty: "Nothing is running.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, signal }) => {
      if (parentId) return { items: [] };
      const [chats, workflows] = await Promise.all([
        activeChatRows(deps, signal),
        deps.queryClient.fetchQuery({
          queryKey: workflowKeys.list({
            projectId: deps.projectId,
            ref: undefined,
          }),
          staleTime: 1000,
          queryFn: async ({ signal: querySignal }) => {
            const response = await deps.apiClient.GET(
              "/api/projects/{projectId}/workflows",
              {
                params: { path: { projectId: deps.projectId }, query: {} },
                signal: querySignal,
              },
            );
            if (!response.data) throw new Error("Could not load workflows.");
            return response.data;
          },
        }),
      ]);
      const runs = await Promise.all(
        workflows.map(async (workflow) => {
          const response = await deps.apiClient.GET(
            "/api/projects/{projectId}/workflows/{name}/runs",
            {
              params: {
                path: { projectId: deps.projectId, name: workflow.name },
                query: { limit: 10 },
              },
              signal,
            },
          );
          return (response.data?.items ?? [])
            .filter((run) => ACTIVE_RUNS.has(run.status))
            .map(
              (run): SidebarSourceItem => ({
                id: `run:${run.id}`,
                label: workflow.displayName ?? workflow.name,
                icon: "Workflow",
                url: `run:${run.id}`,
                badges: [run.status],
                ...(run.status === "failed" ||
                run.status === "waiting" ||
                run.status === "paused"
                  ? { signal: "attention" as const }
                  : { signal: "working" as const }),
                data: { ...run, workflow: workflow.name },
              }),
            );
        }),
      );
      return { items: [...chats, ...runs.flat()] };
    },
    subscribe: (publish) => {
      const refresh = () => publish({ type: "invalidate", quiet: true });
      const stopSessions = subscribeSidebarSessions({
        client: deps.queryClient,
        projectId: deps.projectId,
        listener: refresh,
      });
      const timer = setInterval(() => {
        if (!document.hidden) refresh();
      }, RUNS_POLL_MS);
      return () => {
        stopSessions();
        clearInterval(timer);
      };
    },
    action: async ({ itemId, action }) => {
      chatAction(deps, itemId, action);
      return undefined;
    },
  };
  return source;
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

const capitalized = (word: string) =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

function pullRequestRow(pr: SessionPullRequest): SidebarSourceItem {
  const label =
    pr.title ??
    (pr.number
      ? `Pull request #${pr.number}`
      : pr.url.replace(/^https?:\/\//i, ""));
  return {
    id: pr.url,
    label,
    description: pr.title && pr.number ? `#${pr.number}` : repositoryOf(pr.url),
    icon: STATE_ICONS[pr.state ?? "open"],
    url: pr.url,
    ...(pr.state && pr.state !== "open"
      ? { badges: [capitalized(pr.state)] }
      : {}),
    preview: {
      title: label,
      description: pr.url,
      ...(pr.state
        ? { metadata: [{ label: "State", value: capitalized(pr.state) }] }
        : {}),
    },
    data: { ...pr },
  };
}

/**
 * `work:session` (ADR 0226): the chat beside the section, where it works
 * (its folder or worktree) and the pull requests its agent recorded under
 * `pull_requests`. A section showing it says `when: { session: true }`;
 * links in such a section open as the chat's own.
 */
export function sessionSource(deps: WorkSourceDeps): SectionSource {
  const source: SectionSource = {
    title: "This session",
    empty: "No pull requests yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, session }) => {
      if (parentId || !session) return { items: [] };
      const checkout = deps.remote
        ? undefined
        : await deps.queryClient
            .fetchQuery({
              queryKey: sessionCheckoutKey(deps.projectId, session.id),
              queryFn: () =>
                desktopApi.sessionCheckout({
                  projectId: deps.projectId,
                  sessionId: session.id,
                }),
              staleTime: 2000,
            })
            .catch(() => undefined);
      const folder = checkout
        ? chatFolderView({
            started: true,
            detail: checkout,
            draftWorktree: false,
            // Moving the chat stays in its status popup; only the words matter.
            worktreesAvailable: false,
          })
        : undefined;
      const revealable = Boolean(
        checkout?.path && checkout.present && checkout.available,
      );
      return {
        items: [
          ...(folder
            ? [
                {
                  id: "folder",
                  label: folder.value,
                  description: [folder.tag, ...folder.lines]
                    .filter(Boolean)
                    .join(" · "),
                  icon: folder.kind === "primary" ? "Folder" : "FolderGit2",
                  menu: [
                    {
                      label: "Show in Finder",
                      action: "reveal",
                      ...(revealable
                        ? {}
                        : {
                            disabledReason:
                              "The folder is not on this computer right now.",
                          }),
                    },
                  ],
                  preview: {
                    title: folder.value,
                    ...(checkout?.path ? { description: checkout.path } : {}),
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
                      ...(checkout?.branch
                        ? [{ label: "Branch", value: checkout.branch }]
                        : []),
                    ],
                  },
                  data: { path: checkout?.path ?? null },
                } satisfies SidebarSourceItem,
              ]
            : []),
          ...sessionPullRequests(session.metadata).map(pullRequestRow),
        ],
      };
    },
    subscribe: (publish) =>
      desktopApi.onGitChanged((change) => {
        if (change.projectId === deps.projectId)
          publish({ type: "invalidate", quiet: true });
      }),
    action: async ({ itemId, action, session }) => {
      if (itemId !== "folder" || !session)
        throw new Error("This row does not support that action");
      const checkout = await desktopApi.sessionCheckout({
        projectId: deps.projectId,
        sessionId: session.id,
      });
      // A click (any open verb) shows the folder, as Reveal does.
      if (isOpenAction(action) || action === "reveal") {
        if (!checkout.path) throw new Error("This chat has no folder yet.");
        await desktopApi.revealFolder(checkout.path);
        return undefined;
      }
      throw new Error("This row does not support that action");
    },
  };
  return source;
}
