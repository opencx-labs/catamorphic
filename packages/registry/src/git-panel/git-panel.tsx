"use client";

import {
  useDeployProject,
  useProjectCommits,
  useProjectGit,
} from "@catamorphic/react";
import { useState } from "react";

export interface GitPanelProps {
  projectId: string;
  /**
   * Optional list of paths the host knows have local edits. Defaults to
   * `status.modifiedFiles` from the server. Override when you maintain
   * client-side drafts (e.g. via useProjectGitState).
   */
  modifiedFiles?: string[];
}

/**
 * Compact git status strip: branch, ahead/behind, modified file count, and
 * Deploy/Discard buttons. Pulls everything from `@catamorphic/react` hooks.
 */
export function GitPanel({ projectId, modifiedFiles }: GitPanelProps) {
  const statusQuery = useProjectGit(projectId);
  const commitsQuery = useProjectCommits(projectId, { limit: 5 });
  const deploy = useDeployProject(projectId);

  const [isOpen, setIsOpen] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const status = statusQuery.data;
  const branch = status?.branch ?? "main";
  const modified = modifiedFiles ?? status?.modifiedFiles ?? [];
  const isDirty = modified.length > 0 || (status?.dirty ?? false);

  const handleDeploy = async () => {
    setError(null);
    try {
      const result = await deploy.mutateAsync({
        message: commitMessage.trim() || undefined,
      });
      if (result.status === "conflict") {
        setError("Deploy blocked by conflicts — pull and resolve first.");
      } else if (result.status === "nothing-to-deploy") {
        setError("Nothing to deploy.");
      } else {
        setCommitMessage("");
      }
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
          className="flex items-center gap-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider hover:text-neutral-300 cursor-pointer"
        >
          <span
            className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span>Git</span>
        </button>

        <span className="text-xs text-neutral-400">⎇ {branch}</span>

        {status && (status.ahead > 0 || status.behind > 0) ? (
          <span className="text-xs text-neutral-500">
            {status.ahead > 0 ? `↑${status.ahead}` : null}
            {status.behind > 0 ? ` ↓${status.behind}` : null}
          </span>
        ) : null}

        {modified.length > 0 ? (
          <span className="text-xs text-blue-400">
            {modified.length} modified
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {isDirty ? (
            <button
              type="button"
              onClick={handleDeploy}
              disabled={deploy.isPending}
              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
            >
              {deploy.isPending ? "Deploying…" : "Deploy"}
            </button>
          ) : null}
        </div>
      </div>

      {isOpen ? (
        <div className="overflow-y-auto" style={{ maxHeight: 220 }}>
          {isDirty ? (
            <div className="px-3 py-2 border-b border-neutral-900">
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit message (optional)"
                className="w-full text-xs bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
              />
            </div>
          ) : null}

          {error ? (
            <div className="px-3 py-2 text-xs text-red-400 border-b border-neutral-900">
              {error}
            </div>
          ) : null}

          {modified.length === 0 ? (
            <div className="px-3 py-4 text-xs text-neutral-600 text-center">
              No local changes
            </div>
          ) : (
            <div className="px-1 py-1">
              {modified.map((path) => (
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

          {commitsQuery.data && commitsQuery.data.items.length > 0 ? (
            <div className="px-1 pb-2 border-t border-neutral-900 mt-1 pt-2">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-600">
                Recent commits
              </div>
              {commitsQuery.data.items.slice(0, 5).map((c) => (
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
