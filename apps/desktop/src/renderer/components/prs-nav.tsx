import { GitPullRequest } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi, type PullRequestSummary } from "../lib/desktop-api.js";
import { useAppPreferences } from "../lib/use-app-preferences.js";
import type { PaletteItem } from "./command-palette.js";
import {
  useSidebarContent,
  useSidebarContribution,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarTree } from "./sidebar-tree.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/** The project PR inbox opens each review directly in the workspace. */

const REFRESH_MS = 60_000;

export function PrsNav({
  projectId,
  searchItems,
  onOpenDiff,
}: {
  projectId: string;
  searchItems?: RefObject<() => Promise<PaletteItem[]>>;
  onOpenDiff: (tab: WorkspaceTab, mode?: OpenMode) => void;
  onOpenUrl: (url: string, mode: OpenMode) => void;
  /** Reports emptiness up so hide-when-empty sections can drop entirely. */
}) {
  const visible = useSidebarContribution()?.visible ?? true;
  const { prefs, update, error: preferencesError } = useAppPreferences();
  const filter = prefs.prDefaultView;
  const setFilter = (prDefaultView: "all" | "for-you" | "created") =>
    void update({ prDefaultView });
  const [prs, setPrs] = useState<PullRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useSidebarRefresh(() => setRefresh((value) => value + 1));
  const isEmpty = !error && prs !== null && prs.length === 0;
  useSidebarContent(
    error ? "error" : prs === null ? "loading" : isEmpty ? "empty" : "ready",
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect and Retry invalidate remote data
  useEffect(() => {
    let cancelled = false;
    setPrs(null);
    setError(null);
    let revision = 0;
    const load = () => {
      const request = ++revision;
      void desktopApi
        .prList(projectId)
        .then((next) => {
          if (!cancelled && request === revision) {
            setPrs(next);
            setError(null);
          }
        })
        .catch((reason) => {
          if (!cancelled && request === revision)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load pull requests.",
            );
        });
    };
    load();
    if (!visible)
      return () => {
        cancelled = true;
      };
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, REFRESH_MS);
    window.addEventListener("focus", load);
    const unsubscribe = desktopApi.onGitChanged((change) => {
      if (change.projectId === projectId) load();
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      unsubscribe();
    };
  }, [projectId, refresh, prefs.githubCliEnabled, visible]);

  const inScope = (items: PullRequestSummary[]) =>
    items.filter(
      (pr) =>
        filter === "all" ||
        (filter === "created"
          ? pr.author === pr.viewerLogin
          : (pr.reviewRequestedForViewer ??
            pr.requestedReviewers?.includes(pr.viewerLogin ?? ""))),
    );
  const filtered = inScope(prs ?? []);
  const openReview = (pr: PullRequestSummary, mode?: OpenMode) =>
    onOpenDiff(
      {
        kind: "diff",
        name: `review:${pr.number}`,
        label: `#${pr.number} ${pr.title}`,
        projectId,
        source: { type: "review", prNumber: pr.number },
      },
      mode,
    );
  if (searchItems)
    searchItems.current = async () =>
      inScope(await desktopApi.prList(projectId)).map((pr) => ({
        id: `pr:${pr.number}`,
        icon: GitPullRequest,
        label: `#${pr.number} ${pr.title}`,
        detail: pr.author,
        keywords: [],
        kind: "navigate",
        run: (mode) => openReview(pr, mode),
      }));
  if (
    error?.includes("[github-cli-required]") ||
    error?.includes("[github-cli-disabled]")
  )
    return (
      <div
        className="flex flex-col gap-2 px-2 py-1 text-xs"
        data-testid="prs-connect-github"
      >
        <p className="text-fg-muted">
          Choose the optional GitHub CLI connection in Settings to see pull
          requests.
        </p>
        <button
          type="button"
          className="text-left text-accent"
          onClick={() =>
            onOpenDiff({
              kind: "settings",
              name: "settings",
              label: "Settings",
              destination: {
                id: "connections",
                requestId: crypto.randomUUID(),
              },
            })
          }
        >
          Open connection settings
        </button>
        <button
          type="button"
          className="text-left text-accent"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Retry after signing in
        </button>
      </div>
    );
  if (error)
    return (
      <div className="px-2 py-1 text-xs">
        <p role="alert" className="break-words text-danger">
          {error}
        </p>
        <button
          type="button"
          className="mt-2 text-accent"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  if (!prs) return null;
  if (prs.length === 0) {
    return <p className="sidebar-empty-state">No open pull requests.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {preferencesError && (
        <p role="alert" className="px-2 text-xs text-danger">
          {preferencesError}
        </p>
      )}
      <fieldset className="flex gap-1 px-2" aria-label="Pull request scope">
        {(["for-you", "created", "all"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`rounded-md px-2 py-1 text-xs ${filter === value ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
          >
            {value === "for-you"
              ? "For you"
              : value === "created"
                ? "Created"
                : "All"}
          </button>
        ))}
      </fieldset>
      {filter === "for-you" &&
        prs.some((pr) => pr.reviewRequestsUnavailable) && (
          <p role="status" className="px-2 text-xs text-warning">
            Team review requests are unavailable. Showing direct requests.
          </p>
        )}
      {filtered.length === 0 && (
        <p className="sidebar-empty-state">
          {filter === "for-you"
            ? "No matching review requests."
            : "No matching pull requests."}
        </p>
      )}
      <SidebarTree
        items={filtered.map((pr) => ({ ...pr, id: String(pr.number) }))}
        label="Pull requests"
        rowHeight={40}
        renderItem={(pr) => (
          <SidebarItemRow
            itemId={pr.id}
            label={pr.title}
            description={`#${pr.number} · ${pr.author}`}
            icon="GitPullRequest"
            badges={pr.draft ? ["Draft"] : undefined}
            resource
            onOpen={(mode) => openReview(pr, mode)}
            onAction={() => {}}
          />
        )}
      />
    </div>
  );
}
