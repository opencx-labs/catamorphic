"use client";

import { useProjectFiles, useWriteProjectFile } from "@catamorphic/react";
import { useCallback, useState } from "react";

export interface ProjectEditorProps {
  projectId: string;
  /** Optional initial file path to open. */
  initialFile?: string;
  /**
   * Render the editor for the active file. Plug in your monaco / codemirror
   * here. The slot receives the current file content and an `onChange`
   * callback that the editor wires to its own model.
   */
  renderEditor: (params: {
    path: string;
    content: string;
    onChange: (next: string) => void;
    readOnly?: boolean;
  }) => React.ReactNode;
  /**
   * Optional slot for a sidebar — e.g. `<FileExplorer />` from the
   * `file-explorer` registry item, or a custom tree.
   */
  renderSidebar?: (params: {
    files: { path: string; size: number }[];
    activeFile: string | null;
    modifiedFiles: Set<string>;
    onSelectFile: (path: string) => void;
  }) => React.ReactNode;
  /**
   * Optional slot for the bottom git panel — typically `<GitPanel />` from
   * the `git-panel` registry item.
   */
  renderGitPanel?: (params: {
    projectId: string;
    modifiedFiles: string[];
  }) => React.ReactNode;
  readOnly?: boolean;
}

/**
 * Three-pane project editor: tree (left), editor slot (center), optional
 * git panel (bottom). Files + writes come from `@catamorphic/react`. Drafts
 * are kept locally — swap in `useProjectGitState` if you want multi-branch
 * draft persistence.
 */
export function ProjectEditor({
  projectId,
  initialFile,
  renderEditor,
  renderSidebar,
  renderGitPanel,
  readOnly = false,
}: ProjectEditorProps) {
  const filesQuery = useProjectFiles(projectId);
  const writeFile = useWriteProjectFile(projectId);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState<string | null>(
    initialFile ?? null,
  );

  const files = filesQuery.data ?? [];
  const modifiedFiles = new Set(Object.keys(drafts));

  const handleChange = useCallback(
    (next: string) => {
      if (!activeFile || readOnly) return;
      setDrafts((prev) => ({ ...prev, [activeFile]: next }));
    },
    [activeFile, readOnly],
  );

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    const content = drafts[activeFile];
    if (content === undefined) return;
    await writeFile.mutateAsync({ path: activeFile, content });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[activeFile];
      return next;
    });
  }, [activeFile, drafts, writeFile]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-1 min-h-0">
        {renderSidebar ? (
          <div className="w-[240px] shrink-0 border-r border-neutral-800">
            {renderSidebar({
              files,
              activeFile,
              modifiedFiles,
              onSelectFile: setActiveFile,
            })}
          </div>
        ) : (
          <DefaultFileList
            files={files}
            activeFile={activeFile}
            modifiedFiles={modifiedFiles}
            onSelectFile={setActiveFile}
          />
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-3 py-1.5">
            <span className="text-xs font-mono text-neutral-400">
              {activeFile ?? "(no file selected)"}
            </span>
            {activeFile && drafts[activeFile] !== undefined ? (
              <button
                type="button"
                onClick={handleSave}
                disabled={writeFile.isPending}
                className="h-7 cursor-pointer rounded border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
              >
                {writeFile.isPending ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>
          <div className="flex-1 min-h-0">
            {activeFile ? (
              renderEditor({
                path: activeFile,
                content: drafts[activeFile] ?? "",
                onChange: handleChange,
                readOnly,
              })
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                Select a file from the tree to start editing.
              </div>
            )}
          </div>
        </div>
      </div>
      {renderGitPanel
        ? renderGitPanel({ projectId, modifiedFiles: Object.keys(drafts) })
        : null}
    </div>
  );
}

function DefaultFileList({
  files,
  activeFile,
  modifiedFiles,
  onSelectFile,
}: {
  files: { path: string; size: number }[];
  activeFile: string | null;
  modifiedFiles: Set<string>;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ul className="w-[240px] shrink-0 overflow-auto border-r border-neutral-800 bg-neutral-950 p-1 text-sm">
      {files.map((file) => {
        const isActive = file.path === activeFile;
        const isModified = modifiedFiles.has(file.path);
        return (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onSelectFile(file.path)}
              className={
                "w-full text-left px-2 py-1 rounded font-mono text-xs " +
                (isActive
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200")
              }
            >
              {isModified ? "● " : "  "}
              {file.path}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
