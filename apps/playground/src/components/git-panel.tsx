"use client";

import { useState } from "react";

export interface GitPanelProps {
  modifiedFiles: ReadonlySet<string>;
  originalFiles: Record<string, string>;
}

export function GitPanel({ modifiedFiles, originalFiles }: GitPanelProps) {
  const [isOpen, setIsOpen] = useState(true);
  const modified = [...modifiedFiles];

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 flex flex-col shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-neutral-500 uppercase tracking-wider hover:text-neutral-300 transition-colors w-full text-left"
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
        <span className="flex items-center gap-1.5 ml-2 font-normal normal-case tracking-normal text-neutral-500">
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
          main
        </span>
        {modified.length > 0 && (
          <span className="ml-auto font-normal normal-case tracking-normal text-blue-400">
            {modified.length} modified
          </span>
        )}
      </button>

      {isOpen && (
        <div className="overflow-y-auto" style={{ maxHeight: 180 }}>
          {modified.length === 0 ? (
            <div className="px-3 py-4 text-xs text-neutral-600 text-center">
              No changes
            </div>
          ) : (
            <div className="px-1 pb-2">
              {modified.map((filePath) => (
                <div
                  key={filePath}
                  className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-400"
                >
                  <span className="text-blue-400 font-medium shrink-0">M</span>
                  <span className="font-mono truncate">{filePath}</span>
                </div>
              ))}
            </div>
          )}

          <div className="px-1 pb-2 border-t border-neutral-800 mt-1 pt-2">
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-600">
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                role="img"
                aria-label="History"
              >
                <path d="M1.643 3.143L.427 1.927A.25.25 0 000 2.104V5.75c0 .138.112.25.25.25h3.646a.25.25 0 00.177-.427L2.715 4.215a6.5 6.5 0 11-1.18 4.458.75.75 0 10-1.493.154 8.001 8.001 0 101.6-5.684zM7.75 4a.75.75 0 01.75.75v2.992l2.028.812a.75.75 0 01-.557 1.392l-2.5-1A.75.75 0 017 8.25v-3.5A.75.75 0 017.75 4z" />
              </svg>
              <span className="text-neutral-500">
                {Object.keys(originalFiles).length > 0
                  ? "Initial commit"
                  : "No commits yet"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
