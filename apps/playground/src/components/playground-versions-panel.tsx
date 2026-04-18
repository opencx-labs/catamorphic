"use client";

import type { BranchInfo, CommitInfo } from "@/lib/api";
import type { ProjectGitState } from "@/lib/use-project-git-state";

export interface PlaygroundVersionsPanelProps {
  gitState: ProjectGitState;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PlaygroundVersionsPanel({
  gitState,
}: PlaygroundVersionsPanelProps) {
  const { commits, branches, selectedSha, selectVersion, status } = gitState;

  const workBranches = branches.filter((b) => b.name.startsWith("work/"));
  const publishedCommits: CommitInfo[] = commits;

  if (publishedCommits.length === 0 && workBranches.length === 0) {
    return (
      <div className="catamorphic-versions-empty">
        <div className="catamorphic-versions-empty-icon">⎇</div>
        <p>No versions yet</p>
        <p className="catamorphic-versions-empty-hint">
          Published versions will appear here once you deploy
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2 text-neutral-300">
      {selectedSha && (
        <button
          type="button"
          onClick={() => selectVersion(null)}
          className="w-full text-xs px-3 py-1.5 rounded border border-neutral-700 bg-neutral-900 hover:border-neutral-500 cursor-pointer text-left"
        >
          ← Return to latest
        </button>
      )}

      <section>
        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
          Published versions
        </div>
        {publishedCommits.length === 0 ? (
          <div className="px-2 py-2 text-xs text-neutral-500">
            No deployed versions yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {publishedCommits.map((c) => {
              const isActive = c.sha === selectedSha;
              const isRemoteHead = c.sha === status?.remoteHead;
              return (
                <li key={c.sha}>
                  <button
                    type="button"
                    onClick={() => selectVersion(c.sha)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs flex flex-col gap-0.5 cursor-pointer ${
                      isActive
                        ? "bg-neutral-800 text-neutral-100"
                        : "hover:bg-neutral-900 text-neutral-300"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {formatTimestamp(c.timestamp)}
                      </span>
                      {isRemoteHead && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900">
                          latest
                        </span>
                      )}
                    </div>
                    <div className="text-neutral-500 truncate">{c.message}</div>
                    <div className="text-neutral-600 text-[10px] font-mono">
                      {c.sha.slice(0, 7)} · {c.author.name}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {workBranches.length > 0 && (
        <section>
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
            My work branches
          </div>
          <ul className="flex flex-col gap-0.5">
            {workBranches.map((b: BranchInfo) => {
              const isCurrent = b.isCurrent;
              return (
                <li key={b.name}>
                  <div
                    className={`px-2 py-1.5 rounded text-xs flex items-center justify-between ${
                      isCurrent ? "bg-neutral-800 text-neutral-100" : ""
                    }`}
                  >
                    <span className="font-mono truncate">{b.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] text-emerald-400 ml-2">
                        current
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
