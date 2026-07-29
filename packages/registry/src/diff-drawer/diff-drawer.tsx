"use client";

import { useEffect, useState } from "react";

export interface DiffItem {
  path: string;
  original: string;
  modified: string;
}

export interface DiffDrawerProps {
  title: string;
  diffs: DiffItem[];
  onClose: () => void;
  /** Optional footer slot for action buttons. */
  footer?: React.ReactNode;
  /**
   * Render slot for the diff body. Plug in your diff editor of choice
   * (monaco, codemirror, react-diff-view). When omitted falls back to a
   * naked side-by-side `<pre>` so the component still works with no
   * extra deps.
   */
  renderDiff?: (item: DiffItem) => React.ReactNode;
}

function defaultRenderDiff(item: DiffItem) {
  return (
    <div className="grid h-full grid-cols-2 divide-x divide-border">
      <pre className="m-0 overflow-auto bg-bg-inset p-3 text-xs text-fg font-mono whitespace-pre">
        {item.original || "(empty)"}
      </pre>
      <pre className="m-0 overflow-auto bg-bg-inset p-3 text-xs text-fg font-mono whitespace-pre">
        {item.modified || "(empty)"}
      </pre>
    </div>
  );
}

export function DiffDrawer({
  title,
  diffs,
  onClose,
  footer,
  renderDiff = defaultRenderDiff,
}: DiffDrawerProps) {
  const [activePath, setActivePath] = useState<string | null>(
    diffs[0]?.path ?? null,
  );

  useEffect(() => {
    if (!activePath && diffs[0]) setActivePath(diffs[0].path);
  }, [activePath, diffs]);

  const active = diffs.find((d) => d.path === activePath) ?? diffs[0];

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60">
      <div className="bg-bg-inset border-l border-border w-[90vw] max-w-[1200px] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="text-sm font-semibold text-fg">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg text-lg leading-none cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="w-[260px] shrink-0 border-r border-border overflow-y-auto py-2">
            {diffs.length === 0 ? (
              <div className="px-3 py-2 text-xs text-fg-muted">No changes</div>
            ) : (
              diffs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => setActivePath(d.path)}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate cursor-pointer ${
                    d.path === activePath
                      ? "bg-bg-overlay text-fg"
                      : "text-fg-muted hover:bg-bg-overlay"
                  }`}
                  title={d.path}
                >
                  {d.path}
                </button>
              ))
            )}
          </div>
          <div className="flex-1 min-w-0">
            {active ? (
              renderDiff(active)
            ) : (
              <div className="p-6 text-sm text-fg-muted">
                Select a file to view the diff.
              </div>
            )}
          </div>
        </div>
        {footer && (
          <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
