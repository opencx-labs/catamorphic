import { useEffect, useState } from "react";
import { CodeDiff } from "../components/code-diff.js";
import type { DiffSource } from "../components/workspace-tabs.js";
import { desktopApi, type GitFileDiff } from "../lib/desktop-api.js";
import { pullRequestPatch } from "../lib/review-guide.js";
import { ReviewScreen } from "./review-screen.js";

/**
 * A read-only diff tab. Local sources (the sidebar's Changes rows) load
 * before/after content over IPC. Local revisions and remote patches share
 * the virtualized Pierre renderer and profile-owned Shiki syntax themes.
 * Diffs reload cheaply, so the screen mounts only while visible.
 */

export interface DiffScreenProps {
  projectId: string;
  source: DiffSource;
}

export function DiffScreen({ projectId, source }: DiffScreenProps) {
  if (source.type === "review")
    return <ReviewScreen projectId={projectId} number={source.prNumber} />;
  return source.type === "local" ? (
    <LocalDiff projectId={projectId} source={source} />
  ) : (
    <PatchView
      patch={source.patch}
      filePath={source.filePath}
      status={source.status}
      previousPath={source.previousPath}
    />
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
      {children}
    </div>
  );
}

function LocalDiff({
  projectId,
  source,
}: {
  projectId: string;
  source: Extract<DiffSource, { type: "local" }>;
}) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    setDiff(null);
    setFailed(false);
    const load = () => {
      const request = ++revision;
      void desktopApi
        .gitFileDiff({
          projectId,
          worktreePath: source.worktreePath,
          filePath: source.filePath,
          mode: source.mode,
          previousPath: source.previousPath,
          baseRef: source.baseRef,
        })
        .then((loaded) => {
          if (!cancelled && request === revision) {
            setDiff(loaded);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled && request === revision) setFailed(true);
        });
    };
    load();
    const timer = window.setInterval(load, 15_000);
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
  }, [
    projectId,
    source.worktreePath,
    source.filePath,
    source.mode,
    source.previousPath,
    source.baseRef,
  ]);

  if (failed) return <Note>Couldn't load the diff for {source.filePath}</Note>;
  if (!diff) return <Note>Loading…</Note>;
  if (diff.notice) return <Note>{diff.notice}</Note>;
  if (diff.binary) return <Note>Binary file</Note>;
  if (diff.before === diff.after) {
    // Two identical panes with no highlights read as a bug; say what
    // actually happened (usually: the change is already checkpointed).
    return (
      <Note>
        No differences between {diff.beforeLabel} and {diff.afterLabel}.
      </Note>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      {/* The editor sits in its own bordered surface so a short diff ends
          in chrome, not in a void of unbounded background. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
        <div className="flex min-h-0 flex-1 flex-col">
          <CodeDiff
            path={source.filePath}
            before={diff.before}
            after={diff.after}
          />
        </div>
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-bg-raised/60 px-3 font-mono text-[11px] text-fg-faint">
          <span className="truncate">{source.filePath}</span>
          <span className="ml-auto shrink-0">
            {diff.beforeLabel} → {diff.afterLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A PR file's unified patch, tinted per line like any diff viewer. */
function PatchView({
  patch,
  filePath,
  status,
  previousPath,
}: {
  status?: string;
  previousPath?: string;
  patch: string | null;
  filePath: string;
}) {
  if (patch === null) {
    return <Note>No text diff available (binary or too large).</Note>;
  }
  return (
    <CodeDiff
      path={filePath}
      status={status}
      previousPath={previousPath}
      patch={pullRequestPatch({ path: filePath, patch, status, previousPath })}
    />
  );
}
