import { useEffect, useMemo, useRef, useState } from "react";
import { CODE_THEMES } from "../../shared/app-prefs.js";
import type { PrDetails } from "../../shared/pr-details.js";
import { ActionSearchInput } from "../components/action-search-input.js";
import { ReviewNavigation } from "../components/catamorphic/code-review.js";
import { CodeDiff } from "../components/code-diff.js";
import { ReviewFileTree } from "../components/review-file-tree.js";
import { ReviewGuideDocument } from "../components/review-guide-document.js";
import { ReviewMarkdown } from "../components/review-markdown.js";
import {
  ReviewDiscussion,
  ReviewMetadata,
} from "../components/review-metadata.js";
import {
  desktopApi,
  type PullRequestFile,
  type PullRequestSummary,
} from "../lib/desktop-api.js";
import {
  formatBinding,
  matchesBinding,
  useKeybindings,
} from "../lib/keybindings.js";
import { pullRequestPatch, type ReviewLocation } from "../lib/review-guide.js";
import { useAppPreferences } from "../lib/use-app-preferences.js";

/** A local review notebook. Viewed files are tied to their patch, so new changes reopen them. */
export function ReviewScreen({
  projectId,
  number,
  onOpenArtifact,
}: {
  projectId: string;
  number: number;
  onOpenArtifact?: (target: string, title: string) => void;
}) {
  const reviewRef = useRef<HTMLElement>(null);
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [pr, setPr] = useState<PullRequestSummary | null>(null);
  const [files, setFiles] = useState<PullRequestFile[]>([]);
  const [fingerprints, setFingerprints] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { prefs, update, error: preferencesError } = useAppPreferences();
  const [viewOverride, setView] = useState<
    "overview" | "guide" | "diff" | "discussion" | undefined
  >();
  const view = viewOverride ?? prefs.reviewStartView;
  const [selectedPath, setSelectedPath] = useState("");
  const [location, setLocation] = useState<ReviewLocation | undefined>();
  const [query, setQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<"files" | "content">("files");
  const [showFiles, setShowFiles] = useState(false);
  const [discussionPath, setDiscussionPath] = useState<string>();
  const bindings = useKeybindings();
  const storageKey = `review:${projectId}:${number}`;
  const [viewed, setViewed] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "{}",
      );
      if (value && typeof value === "object")
        setViewed(
          Object.fromEntries(
            Object.entries(value).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        );
    } catch {
      setViewed({});
    }
  }, [storageKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh invalidates remote data
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPr(null);
    setFiles([]);
    void Promise.all([
      desktopApi.prList(projectId),
      desktopApi.prFiles(projectId, number),
    ])
      .then(async ([prs, changes]) => {
        if (cancelled) return;
        const found = prs.find((item) => item.number === number);
        if (!found)
          throw new Error(
            "This pull request is no longer in the open list. Open it on GitHub for its current state.",
          );
        const stamps = await Promise.all(
          changes.map(async (file) => {
            const value = `${file.status}:${file.previousPath ?? ""}:${file.patch ?? `${found.headSha ?? found.updatedAt}:${file.additions}:${file.deletions}`}`;
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(value),
            );
            return [
              file.path,
              Array.from(new Uint8Array(digest), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            ] as const;
          }),
        );
        if (cancelled) return;
        setFingerprints(Object.fromEntries(stamps));
        setPr(found);
        setFiles(changes);
        setSelectedPath((current) =>
          changes.some((file) => file.path === current)
            ? current
            : (changes[0]?.path ?? ""),
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : "Could not load review.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh reloads review metadata.
  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setDetailsError(null);
    void desktopApi
      .prDetails(projectId, number)
      .then((value) => {
        if (!cancelled) setDetails(value);
      })
      .catch(() => {
        if (!cancelled)
          setDetailsError(
            "Could not load comments and checks. Refresh to retry.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number, revision]);
  const filtered = useMemo(
    () =>
      files.filter(
        (file) =>
          file.path.toLowerCase().includes(query.toLowerCase()) &&
          (!contentQuery ||
            (file.patch ?? "")
              .toLowerCase()
              .includes(contentQuery.toLowerCase())),
      ),
    [files, query, contentQuery],
  );
  const selected = files.find((file) => file.path === selectedPath);
  const fingerprint = (file: PullRequestFile) => fingerprints[file.path] ?? "";
  const done = files.filter(
    (file) => viewed[file.path] === fingerprint(file),
  ).length;
  const areas = useMemo(() => {
    const groups = new Map<string, PullRequestFile[]>();
    for (const file of files) {
      const area =
        prefs.reviewGrouping === "flat"
          ? "All files"
          : prefs.reviewGrouping === "directory"
            ? file.path.split("/").slice(0, -1).join("/") || "Project root"
            : /(^|\/)(__tests__|e2e)(\/|$)|\.(test|spec)\./.test(file.path)
              ? "Tests and verification"
              : /(^|\/)(migrations|schema)(\/|$)/.test(file.path)
                ? "Data changes"
                : /\.(md|mdx)$/.test(file.path)
                  ? "Documentation"
                  : file.path.split("/").slice(0, -1).slice(0, 2).join("/") ||
                    "Project root";
      groups.set(area, [...(groups.get(area) ?? []), file]);
    }
    return [...groups];
  }, [files, prefs.reviewGrouping]);
  const openFile = (
    file: PullRequestFile | undefined,
    location?: ReviewLocation,
  ) => {
    if (!file) return;
    if ((reviewRef.current?.clientWidth ?? 0) < 700) setShowFiles(false);
    setLocation(location);
    setSelectedPath(file.path);
    setView("diff");
  };
  return (
    <section
      ref={reviewRef}
      aria-label="Pull request review"
      tabIndex={-1}
      className="@container/review flex h-full min-h-0 flex-1 flex-col"
      data-testid="review-screen"
      onKeyDown={(event) => {
        if (event.key === "Escape" && showFiles) {
          setShowFiles(false);
          return;
        }
        const content =
          matchesBinding(event, bindings["search-content"]) ||
          matchesBinding(event, bindings["search-diff"]);
        const filename = matchesBinding(event, bindings["search-files"]);
        if (!content && !filename) return;
        event.preventDefault();
        event.stopPropagation();
        setSearchMode(content ? "content" : "files");
        setSearchOpen(true);
        setView("diff");
      }}
    >
      <header className="flex min-h-12 shrink-0 items-center gap-3 px-4 py-2">
        <p className="shrink-0 text-xs tabular-nums text-fg-muted">#{number}</p>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {pr?.title ?? "Loading review…"}
        </h1>
        <p className="shrink-0 text-xs tabular-nums text-fg-muted @max-[640px]/review:hidden">
          {done}/{files.length} reviewed
        </p>
        {details && (
          <details
            className="relative shrink-0 text-xs"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-fg-muted hover:bg-bg-overlay">
              Review details
            </summary>
            <div className="absolute right-0 top-8 z-40 max-h-[70vh] w-72 overflow-auto rounded-lg border border-border bg-bg-overlay p-4 shadow-lg">
              <ReviewMetadata
                details={details}
                label="Review status and people"
              />
            </div>
          </details>
        )}
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-overlay"
        >
          Refresh
        </button>
      </header>
      {(error || preferencesError) && (
        <p role="alert" className="px-4 py-2 text-sm text-danger">
          {error ?? preferencesError}
        </p>
      )}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1">
        <ReviewNavigation
          value={view}
          onChange={(value) => {
            setDiscussionPath(undefined);
            setView(value);
          }}
        />
        <div className="min-w-0 flex-1" />
        {view === "diff" && (
          <button
            type="button"
            aria-pressed={showFiles}
            onClick={() => setShowFiles((value) => !value)}
            className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-overlay"
          >
            <span className="whitespace-nowrap">Files · {files.length}</span>
          </button>
        )}
        {view === "diff" && (
          <>
            <button
              type="button"
              aria-expanded={searchOpen}
              onClick={() => {
                setSearchOpen((value) => !value);
                setView("diff");
              }}
              className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-bg-overlay"
            >
              Search{" "}
              <kbd className="@max-[700px]/review:hidden">
                {formatBinding(bindings["search-files"])}
              </kbd>
            </button>
            <details className="relative text-xs">
              <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-fg-muted hover:bg-bg-overlay">
                Display
              </summary>
              <div className="absolute right-0 top-8 z-30 flex w-56 flex-col gap-3 rounded-lg border border-border bg-bg-overlay p-3 shadow-lg">
                <label className="flex items-center justify-between gap-2">
                  Layout
                  <select
                    name="reviewLayout"
                    value={prefs.diffLayout}
                    onChange={(e) =>
                      void update({
                        diffLayout:
                          e.target.value === "split" ? "split" : "unified",
                      })
                    }
                    className="field rounded px-2 py-1"
                  >
                    <option value="split">Split</option>
                    <option value="unified">Unified</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2">
                  Wrap lines
                  <input
                    name="reviewWrap"
                    type="checkbox"
                    checked={prefs.diffWrap}
                    onChange={(e) =>
                      void update({ diffWrap: e.target.checked })
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  Theme
                  <select
                    name="reviewTheme"
                    value={prefs.codeTheme}
                    onChange={(e) => {
                      const codeTheme = CODE_THEMES.find(
                        (theme) => theme === e.target.value,
                      );
                      if (codeTheme) void update({ codeTheme });
                    }}
                    className="field min-w-0 rounded px-2 py-1"
                  >
                    {CODE_THEMES.map((theme) => (
                      <option key={theme}>{theme}</option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
          </>
        )}
      </div>
      {searchOpen && view === "diff" && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <select
            name="reviewSearchScope"
            aria-label="Search scope"
            value={searchMode}
            onChange={(event) => {
              setQuery("");
              setContentQuery("");
              setSearchMode(
                event.target.value === "files" ? "files" : "content",
              );
            }}
            className="field rounded-md px-2 py-1 text-xs"
          >
            <option value="files">Filenames</option>
            <option value="content">Changed content</option>
          </select>
          <ActionSearchInput
            autoFocus
            name="reviewSearch"
            action={searchMode === "files" ? "search-files" : "search-content"}
            aria-label="Search review"
            placeholder={
              searchMode === "files" ? "Find a file…" : "Find changed content…"
            }
            value={searchMode === "files" ? query : contentQuery}
            onChange={(event) => {
              if (searchMode === "files") setQuery(event.target.value);
              else setContentQuery(event.target.value);
              setShowFiles(true);
            }}
            className="min-w-0 flex-1 rounded-md px-2 py-1 text-xs"
          />
          <button
            type="button"
            aria-label="Close review search"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
              setContentQuery("");
            }}
            className="px-2 py-1 text-xs text-fg-muted"
          >
            Close
          </button>
        </div>
      )}
      {view === "discussion" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {details ? (
            <ReviewDiscussion
              details={details}
              submitShortcut={{
                binding: bindings["submit-pr-comment"],
                label: formatBinding(bindings["submit-pr-comment"]),
              }}
              draftKey={`pr-comment:${projectId}:${number}`}
              onPostComment={async (input) => {
                const comment = await desktopApi.prComment({
                  projectId,
                  number,
                  ...input,
                });
                setDetails((current) =>
                  current
                    ? input.replyTo
                      ? {
                          ...current,
                          inlineComments: [...current.inlineComments, comment],
                        }
                      : { ...current, comments: [...current.comments, comment] }
                    : current,
                );
                return comment;
              }}
              focusedPath={discussionPath}
              onClearPath={() => setDiscussionPath(undefined)}
              url={pr?.url}
              onOpenFile={(path, line, side) =>
                openFile(
                  files.find((file) => file.path === path),
                  line
                    ? {
                        line,
                        side: side === "LEFT" ? "deletions" : "additions",
                        label: "Comment",
                      }
                    : undefined,
                )
              }
            />
          ) : (
            <p className="text-sm text-fg-muted">
              {detailsError ?? "Loading discussion…"}
            </p>
          )}
        </div>
      ) : view === "overview" ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-6 @min-[800px]/review:px-8">
          <div className="mx-auto grid w-full max-w-[var(--review-layout-width,1180px)] grid-cols-1 items-start gap-6 @min-[900px]/review:grid-cols-[minmax(0,1fr)_240px]">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
                <p>{pr?.author}</p>
                <p className="font-mono">
                  {pr?.head} → {pr?.base}
                </p>
                <p>
                  {pr?.draft
                    ? "Draft"
                    : (details?.state.toLowerCase() ?? "Open")}
                </p>
                <p>{files.length} files</p>
              </div>
              <details
                open
                className="review-description min-w-0 rounded-xl border border-border bg-bg-raised"
              >
                <summary className="cursor-pointer rounded-t-xl border-b border-border px-6 py-4 text-sm font-semibold hover:bg-bg-overlay focus-visible:outline-2 focus-visible:outline-accent">
                  Description
                </summary>
                <div className="px-6 py-5 @min-[900px]/review:px-8">
                  <ReviewMarkdown
                    body={pr?.body || "No description provided."}
                  />
                </div>
              </details>
            </div>
            {details ? (
              <ReviewMetadata details={details} />
            ) : (
              <p className="text-xs text-fg-muted">
                {detailsError ?? "Loading checks and reviewers…"}
              </p>
            )}
          </div>
        </div>
      ) : view === "guide" ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
          <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6 pt-5">
            <ReviewGuideDocument
              key={`${projectId}:${number}`}
              projectId={projectId}
              number={number}
              title={pr?.title ?? ""}
              body={pr?.body ?? ""}
              files={files}
              revision={pr?.headSha ?? Object.values(fingerprints).join(":")}
              onOpenArtifact={onOpenArtifact}
            />
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Change map</h2>
                <select
                  aria-label="Review guide grouping"
                  value={prefs.reviewGrouping}
                  className="field rounded-md px-2 py-1 text-xs"
                  onChange={(event) =>
                    void update({
                      reviewGrouping:
                        event.target.value === "flat"
                          ? "flat"
                          : event.target.value === "directory"
                            ? "directory"
                            : "purpose",
                    })
                  }
                >
                  <option value="purpose">Purpose</option>
                  <option value="directory">Directory</option>
                  <option value="flat">All files</option>
                </select>
              </div>
              <p className="mb-3 text-xs text-fg-muted">
                Browse changes by area, then open a file to review its diff.
              </p>
              <div className="grid gap-3">
                {areas.map(([area, changes]) => (
                  <details
                    key={area}
                    className="min-w-0 rounded-lg border border-border p-3"
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      {area}{" "}
                      <span className="text-fg-faint">{changes.length}</span>
                    </summary>
                    <div className="mt-3 flex min-w-0 flex-col gap-1">
                      {changes.map((file) => (
                        <div key={file.path}>
                          <button
                            type="button"
                            key={file.path}
                            onClick={() => openFile(file)}
                            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-bg-overlay"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {file.path}
                            </span>
                            <span className="text-success">
                              +{file.additions}
                            </span>
                            <span className="text-danger">
                              −{file.deletions}
                            </span>
                            {viewed[file.path] === fingerprint(file) && (
                              <span>Reviewed</span>
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {showFiles && (
            <aside className="flex w-64 max-w-[40%] min-w-0 shrink-0 flex-col gap-2 overflow-hidden border-r border-border bg-bg p-2 @max-[700px]/review:absolute @max-[700px]/review:inset-y-0 @max-[700px]/review:left-0 @max-[700px]/review:z-20 @max-[700px]/review:max-w-[80%] @max-[700px]/review:shadow-lg">
              <ReviewFileTree
                files={filtered}
                selectedPath={selectedPath}
                onOpen={openFile}
                isReviewed={(file) => viewed[file.path] === fingerprint(file)}
              />
              {!filtered.length && (
                <p className="text-xs text-fg-muted">No matching files.</p>
              )}
            </aside>
          )}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected && (
              <>
                <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs">
                  <button
                    type="button"
                    aria-label="Previous file"
                    disabled={files.indexOf(selected) === 0}
                    onClick={() => openFile(files[files.indexOf(selected) - 1])}
                    className="rounded px-2 py-1 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Next file"
                    disabled={files.indexOf(selected) === files.length - 1}
                    onClick={() => openFile(files[files.indexOf(selected) + 1])}
                    className="rounded px-2 py-1 disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {selected.path}
                  </span>
                  {details && (
                    <button
                      type="button"
                      onClick={() => {
                        setDiscussionPath(selected.path);
                        setView("discussion");
                      }}
                      className="shrink-0 rounded px-2 py-1 text-fg-muted hover:bg-bg-overlay"
                    >
                      Comments ·{" "}
                      {
                        details.inlineComments.filter(
                          (comment) => comment.path === selected.path,
                        ).length
                      }
                    </button>
                  )}
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={viewed[selected.path] === fingerprint(selected)}
                      onChange={(event) => {
                        const next = {
                          ...viewed,
                          [selected.path]: event.target.checked
                            ? fingerprint(selected)
                            : "",
                        };
                        setViewed(next);
                        localStorage.setItem(storageKey, JSON.stringify(next));
                      }}
                    />
                    Reviewed
                  </label>
                </div>
                {selected.patch ? (
                  <CodeDiff
                    key={selected.path}
                    showToolbar={false}
                    searchQuery={contentQuery}
                    path={selected.path}
                    status={selected.status}
                    previousPath={selected.previousPath}
                    location={location}
                    patch={pullRequestPatch({
                      ...selected,
                      patch: selected.patch,
                    })}
                  />
                ) : (
                  <p className="p-4 text-sm text-fg-muted">
                    No text patch available for this file.
                  </p>
                )}
              </>
            )}
          </main>
        </div>
      )}
    </section>
  );
}
