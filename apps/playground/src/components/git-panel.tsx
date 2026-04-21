"use client";

import type { ConflictEntry } from "@catamorphic/react/types";
import { useMemo, useState } from "react";
import type { ProjectGitState } from "@/lib/use-project-git-state";
import { DiffDrawer } from "./diff-drawer";

export interface GitPanelProps {
  gitState: ProjectGitState;
  /** Baseline file content keyed by path (server HEAD) for diff display. */
  baselineFiles: Record<string, string>;
}

export function GitPanel({ gitState, baselineFiles }: GitPanelProps) {
  const {
    status,
    commits,
    modifiedFiles,
    isDirty,
    files,
    deploy,
    discard,
    selectedSha,
  } = gitState;

  const [isOpen, setIsOpen] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [commitMessage, setCommitMessage] = useState("");

  const modifiedList = useMemo(
    () => [...modifiedFiles].sort(),
    [modifiedFiles],
  );
  const branch = status?.branch ?? "main";
  const viewingHistorical = selectedSha !== null;

  const diffs = modifiedList.map((path) => ({
    path,
    original: baselineFiles[path] ?? "",
    modified: files[path] ?? "",
  }));

  const handleDeploy = async () => {
    setDeploying(true);
    setError(null);
    setConflicts([]);
    try {
      const result = await deploy({
        message: commitMessage.trim() || undefined,
      });
      if (result.status === "conflict") {
        setConflicts(result.conflicts);
        setError("Deploy blocked by conflicts — pull and resolve first.");
      } else if (result.status === "nothing-to-deploy") {
        setError("Nothing to deploy.");
      } else {
        setCommitMessage("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  };

  const handleDiscard = async () => {
    if (!confirm("Discard all local changes? This cannot be undone.")) return;
    try {
      await discard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 flex flex-col shrink-0">
      <div className="flex items-center gap-2 px-3 py-1.5 w-full">
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider hover:text-neutral-300 transition-colors cursor-pointer"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`transition-transform ${isOpen ? "rotate-90" : ""}`}
            role="img"
            aria-label="Toggle"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span>Git</span>
        </button>

        <span className="flex items-center gap-1.5 font-normal text-xs normal-case tracking-normal text-neutral-400">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="currentColor"
            role="img"
            aria-label="Branch"
          >
            <path d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
          </svg>
          {branch}
        </span>

        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="text-xs text-neutral-500">
            {status.ahead > 0 && (
              <span title={`${status.ahead} ahead`}>↑{status.ahead}</span>
            )}
            {status.behind > 0 && (
              <span title={`${status.behind} behind`} className="ml-1">
                ↓{status.behind}
              </span>
            )}
          </span>
        )}

        {modifiedList.length > 0 && (
          <span className="text-xs text-blue-400">
            {modifiedList.length} modified
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!viewingHistorical && modifiedList.length > 0 && (
            <button
              type="button"
              onClick={() => setReviewing(true)}
              className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 cursor-pointer"
            >
              Review
            </button>
          )}
          {!viewingHistorical && isDirty && (
            <>
              <button
                type="button"
                onClick={handleDeploy}
                disabled={deploying}
                className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
              >
                {deploying ? "Deploying..." : "Deploy"}
              </button>
              <button
                type="button"
                onClick={handleDiscard}
                className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-500 cursor-pointer"
              >
                Discard
              </button>
            </>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="overflow-y-auto" style={{ maxHeight: 220 }}>
          {!viewingHistorical && isDirty && (
            <div className="px-3 py-2 border-b border-neutral-900">
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit message (optional)"
                className="w-full text-xs bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
              />
            </div>
          )}

          {error && (
            <div className="px-3 py-2 text-xs text-red-400 border-b border-neutral-900">
              {error}
            </div>
          )}

          {conflicts.length > 0 && (
            <div className="px-3 py-2 text-xs text-amber-400 border-b border-neutral-900">
              {conflicts.length} conflicting file
              {conflicts.length === 1 ? "" : "s"}: pull first to resolve.
            </div>
          )}

          {modifiedList.length === 0 ? (
            <div className="px-3 py-4 text-xs text-neutral-600 text-center">
              No local changes
            </div>
          ) : (
            <div className="px-1 py-1">
              {modifiedList.map((path) => (
                <div
                  key={path}
                  className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-300"
                >
                  <span className="text-blue-400 font-medium shrink-0">M</span>
                  <span className="font-mono truncate">{path}</span>
                </div>
              ))}
            </div>
          )}

          {commits.length > 0 && (
            <div className="px-1 pb-2 border-t border-neutral-900 mt-1 pt-2">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-600">
                Recent commits
              </div>
              {commits.slice(0, 5).map((c) => (
                <div
                  key={c.sha}
                  className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-400"
                  title={`${c.sha.slice(0, 7)} · ${c.author.name}`}
                >
                  <span className="text-neutral-600 font-mono shrink-0">
                    {c.sha.slice(0, 7)}
                  </span>
                  <span className="truncate">{c.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {reviewing && (
        <DiffDrawer
          title="Review changes"
          diffs={diffs}
          onClose={() => setReviewing(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setReviewing(false)}
                className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                disabled={deploying}
                onClick={async () => {
                  await handleDeploy();
                  setReviewing(false);
                }}
                className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
              >
                {deploying ? "Deploying..." : "Deploy"}
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
