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
  const [company, setCompany] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void desktopApi
      .remoteStatus(projectId)
      .then((status) => {
        if (!cancelled) setCompany(Boolean(status));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  useSidebarRefresh(() => setRefresh((value) => value + 1));
  const signedOut = error?.includes("[github-cli-required]") ?? false;
  const disconnected =
    signedOut || (error?.includes("[github-cli-disabled]") ?? false);
  useSidebarContent({
    // Not connected is content (the connect card), not a failed read.
    state: disconnected
      ? "ready"
      : error
        ? "error"
        : prs === null
          ? "loading"
          : prs.length === 0
            ? "empty"
            : "ready",
    error: disconnected ? undefined : (error ?? undefined),
    retry: () => setRefresh((value) => value + 1),
    empty: company ? "No proposals awaiting review." : "No open pull requests.",
  });

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
    // A disabled GitHub CLI connection fails every request the same way, so
    // wait for the preference to change instead of polling the refusal.
    if (!visible || !prefs.githubCliEnabled)
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
        company ||
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
  if (disconnected) {
    // The sidebar re-checks on window focus and whenever the connection
    // preference changes, so this state needs exactly one action.
    const things = company ? "proposals" : "pull requests";
    return (
      <div
        className="flex flex-col gap-1.5 px-2 py-1"
        data-testid="prs-connect-github"
      >
        <p className="text-xs font-medium text-fg">GitHub not connected</p>
        <p className="text-xs text-fg-muted">
          {signedOut
            ? `Sign in to the GitHub CLI to review ${things} here.`
            : `Connect the GitHub CLI to review ${things} here.`}
        </p>
        <button
          type="button"
          onClick={() =>
            onOpenDiff({
              kind: "settings",
              name: "settings",
              label: "Settings",
              destination: {
                id: "github-cli",
                requestId: crypto.randomUUID(),
              },
            })
          }
          className="mt-1 flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          <GitPullRequest className="size-3.5" />
          {signedOut ? "Manage connection" : "Connect GitHub"}
        </button>
      </div>
    );
  }
  if (error || !prs || prs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {preferencesError && (
        <p role="alert" className="px-2 text-xs text-danger">
          {preferencesError}
        </p>
      )}
      {!company && (
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
      )}
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
