"use client";

import { useEffect, useState } from "react";
import { MonacoDiffEditor } from "./monaco-diff-editor";

interface DiffItem {
  path: string;
  original: string;
  modified: string;
}

interface DiffDrawerProps {
  title: string;
  diffs: DiffItem[];
  onClose: () => void;
  /** Optional footer slot for action buttons. */
  footer?: React.ReactNode;
}

export function DiffDrawer({ title, diffs, onClose, footer }: DiffDrawerProps) {
  const [activePath, setActivePath] = useState<string | null>(
    diffs[0]?.path ?? null,
  );

  useEffect(() => {
    if (!activePath && diffs[0]) setActivePath(diffs[0].path);
  }, [activePath, diffs]);

  const active = diffs.find((d) => d.path === activePath) ?? diffs[0];

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60">
      <div className="bg-neutral-950 border-l border-neutral-800 w-[90vw] max-w-[1200px] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 shrink-0">
          <div className="text-sm font-semibold text-neutral-200">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-100 text-lg leading-none cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="w-[260px] shrink-0 border-r border-neutral-800 overflow-y-auto py-2">
            {diffs.length === 0 ? (
              <div className="px-3 py-2 text-xs text-neutral-500">
                No changes
              </div>
            ) : (
              diffs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => setActivePath(d.path)}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate cursor-pointer ${
                    d.path === activePath
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-400 hover:bg-neutral-900"
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
              <MonacoDiffEditor
                original={active.original}
                modified={active.modified}
                height="100%"
              />
            ) : (
              <div className="p-6 text-sm text-neutral-500">
                Select a file to view the diff.
              </div>
            )}
          </div>
        </div>
        {footer && (
          <div className="px-4 py-3 border-t border-neutral-800 flex items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
