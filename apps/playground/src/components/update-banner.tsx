"use client";

import { useState } from "react";
import type { ConflictEntry } from "@/lib/api";
import { api } from "@/lib/api";
import type { ProjectGitState } from "@/lib/use-project-git-state";
import { DiffDrawer } from "./diff-drawer";

export interface UpdateBannerProps {
  projectId: string;
  gitState: ProjectGitState;
}

export function UpdateBanner({ projectId, gitState }: UpdateBannerProps) {
  const { status, isBehind, pull, resolveConflicts, files } = gitState;
  const [pulling, setPulling] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  if (!isBehind && conflicts.length === 0) return null;

  const handlePull = async () => {
    setPulling(true);
    setError(null);
    try {
      const result = await pull();
      if (result.status === "conflict") {
        setConflicts(result.conflicts);
      } else {
        setConflicts([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPulling(false);
    }
  };

  const handleAIResolve = async () => {
    setResolving(true);
    setError(null);
    try {
      const result = await api.aiResolveConflicts(projectId, { conflicts });
      await resolveConflicts(result.resolutions);
      setConflicts([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  };

  const behindCount = status?.behind ?? 0;

  return (
    <>
      {isBehind && (
        <div className="flex items-center gap-3 px-4 py-2 bg-amber-950/40 border-b border-amber-900/60 text-amber-200 text-xs">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            role="img"
            aria-label="Warning"
          >
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm7.25-3a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0V5Zm.75 6.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
          </svg>
          <span>
            A newer version is available ({behindCount} new commit
            {behindCount === 1 ? "" : "s"}).
          </span>
          <button
            type="button"
            onClick={handlePull}
            disabled={pulling}
            className="ml-auto text-xs px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50 cursor-pointer"
          >
            {pulling ? "Pulling..." : "Pull latest"}
          </button>
          {error && <span className="text-red-300 ml-2">{error}</span>}
        </div>
      )}

      {conflicts.length > 0 && (
        <DiffDrawer
          title={`Resolve ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`}
          diffs={conflicts.map((c) => ({
            path: c.path,
            original: c.ours ?? files[c.path] ?? "",
            modified: c.theirs ?? "",
          }))}
          onClose={() => setConflicts([])}
          footer={
            <>
              {error && <span className="text-xs text-red-400">{error}</span>}
              <button
                type="button"
                onClick={() => setConflicts([])}
                className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 cursor-pointer"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleAIResolve}
                disabled={resolving}
                className="text-xs px-3 py-1.5 rounded bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50 cursor-pointer"
              >
                {resolving ? "Resolving..." : "Ask AI to resolve"}
              </button>
            </>
          }
        />
      )}
    </>
  );
}
