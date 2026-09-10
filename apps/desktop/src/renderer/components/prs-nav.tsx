import { GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi, type PullRequestSummary } from "../lib/desktop-api.js";
import { useAppPreferences } from "../lib/use-app-preferences.js";
import { OpenResourceButton } from "./open-resource-button.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/** The project PR inbox opens each review directly in the workspace. */

const REFRESH_MS = 60_000;

export function PrsNav({
  projectId,
  onOpenDiff,
  onEmptyChange,
}: {
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab, mode?: OpenMode) => void;
  onOpenUrl: (url: string, mode: OpenMode) => void;
  /** Reports emptiness up so hide-when-empty sections can drop entirely. */
  onEmptyChange?: (empty: boolean) => void;
}) {
  const { prefs, update, error: preferencesError } = useAppPreferences();
  const filter = prefs.prDefaultView;
  const setFilter = (prDefaultView: "all" | "for-you" | "created") =>
    void update({ prDefaultView });
  const [search, setSearch] = useState("");
  const [prs, setPrs] = useState<PullRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const isEmpty = !error && (!prs || prs.length === 0);
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);

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
    const timer = window.setInterval(load, REFRESH_MS);
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
  }, [projectId, refresh, prefs.githubCliEnabled]);

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
  const filtered = prs.filter(
    (pr) =>
      (filter === "all" ||
        (filter === "created"
          ? pr.author === pr.viewerLogin
          : (pr.reviewRequestedForViewer ??
            pr.requestedReviewers?.includes(pr.viewerLogin ?? "")))) &&
      `${pr.number} ${pr.title} ${pr.author}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
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
      <input
        aria-label="Find pull requests"
        placeholder="Find pull requests…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="field mx-2 min-w-0 rounded-md px-2 py-1 text-xs"
      />
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
      <ul
        // biome-ignore lint/a11y/noRedundantRoles: Preserve list semantics when CSS removes markers.
        role="list"
        className="flex flex-col gap-1 px-1"
      >
        {filtered.map((pr) => (
          <li key={pr.number}>
            <OpenResourceButton
              aria-label={`Open review #${pr.number}: ${pr.title}`}
              onOpen={(mode) =>
                onOpenDiff(
                  {
                    kind: "diff",
                    name: `review:${pr.number}`,
                    label: `#${pr.number} ${pr.title}`,
                    projectId,
                    source: { type: "review", prNumber: pr.number },
                  },
                  mode,
                )
              }
              className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-bg-overlay"
            >
              <GitPullRequest className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-xs font-medium text-fg">
                  {pr.title}
                </p>
                <p className="mt-1 truncate text-[11px] text-fg-muted">
                  #{pr.number} · {pr.author}
                  {pr.draft ? " · Draft" : ""}
                </p>
              </div>
            </OpenResourceButton>
          </li>
        ))}
      </ul>
    </div>
  );
}
