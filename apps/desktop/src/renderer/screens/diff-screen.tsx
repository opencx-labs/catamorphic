import { DiffEditor } from "@monaco-editor/react";
import "../lib/monaco-setup.js";
import { useEffect, useState } from "react";
import type { DiffSource } from "../components/workspace-tabs.js";
import { desktopApi, type GitFileDiff } from "../lib/desktop-api.js";
import { useTheme } from "../lib/theme.js";

/**
 * A read-only diff tab. Local sources (the sidebar's Changes rows) load
 * before/after content over IPC and render Monaco's side-by-side diff;
 * PR sources already carry their unified patch text and render it as a
 * tinted line list — no checkout of the PR branch exists to diff against.
 * Diffs reload cheaply, so the screen mounts only while visible.
 */

export interface DiffScreenProps {
  projectId: string;
  source: DiffSource;
}

export function DiffScreen({ projectId, source }: DiffScreenProps) {
  return source.type === "local" ? (
    <LocalDiff projectId={projectId} source={source} />
  ) : (
    <PatchView patch={source.patch} />
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
  const theme = useTheme();
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    desktopApi
      .gitFileDiff(projectId, source.worktreePath, source.filePath, source.mode)
      .then((loaded) => {
        if (!cancelled) setDiff(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, source.worktreePath, source.filePath, source.mode]);

  if (failed) return <Note>Couldn't load the diff for {source.filePath}</Note>;
  if (!diff) return <Note>Loading…</Note>;
  if (diff.binary) return <Note>Binary file</Note>;
  if (diff.before === diff.after) {
    // Two identical panes with no highlights read as a bug; say what
    // actually happened (usually: the change is already checkpointed).
    return (
      <Note>
        No differences — this change is already in the project's history.
      </Note>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      {/* The editor sits in its own bordered surface so a short diff ends
          in chrome, not in a void of unbounded background. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border">
        <div className="min-h-0 flex-1">
          <DiffEditor
            height="100%"
            // Distinct model paths per side so Monaco infers the language
            // from the file extension (the same mechanism as editor tabs).
            originalModelPath={`file:///diff-original/${source.mode}/${source.filePath}`}
            modifiedModelPath={`file:///diff-modified/${source.mode}/${source.filePath}`}
            original={diff.before}
            modified={diff.after}
            theme={theme?.appearance === "light" ? "light" : "vs-dark"}
            options={{
              readOnly: true,
              renderSideBySide: true,
              lineNumbers: "on",
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12 },
              fixedOverflowWidgets: true,
            }}
          />
        </div>
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border bg-bg-raised/60 px-3 font-mono text-[11px] text-fg-faint">
          <span className="truncate">{source.filePath}</span>
          <span className="ml-auto shrink-0">
            {source.mode === "uncommitted" ? "uncommitted" : "vs main"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A PR file's unified patch, tinted per line like any diff viewer. */
function PatchView({ patch }: { patch: string | null }) {
  if (patch === null) {
    return <Note>No text diff available (binary or too large).</Note>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-bg">
      <div className="w-max min-w-full py-3 font-mono text-[12px] leading-5">
        {patch.split("\n").map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static patch lines
            key={index}
            className={`whitespace-pre px-3 ${
              line.startsWith("@@")
                ? "bg-bg-raised text-fg-muted"
                : line.startsWith("+")
                  ? "bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-fg"
                  : line.startsWith("-")
                    ? "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-fg"
                    : "text-fg-muted"
            }`}
          >
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}
