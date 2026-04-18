"use client";

import { useCallback, useState } from "react";
import type { ProjectGitState } from "@/lib/use-project-git-state";
import { FileExplorer } from "./file-explorer";
import { GitPanel } from "./git-panel";
import { MultiTabMonaco } from "./multi-tab-monaco";

export interface ProjectEditorProps {
  files: Record<string, string>;
  onFileChange: (params: { path: string; content: string }) => void;
  initialFile?: string;
  gitState: ProjectGitState;
  baselineFiles: Record<string, string>;
  readOnly?: boolean;
  onRunWorkflow?: (params: { name: string }) => void;
}

export function ProjectEditor({
  files,
  onFileChange,
  initialFile,
  gitState,
  baselineFiles,
  readOnly = false,
  onRunWorkflow,
}: ProjectEditorProps) {
  const [openTabs, setOpenTabs] = useState<string[]>(() =>
    initialFile ? [initialFile] : [],
  );
  const [activeTab, setActiveTab] = useState<string | null>(
    initialFile ?? null,
  );

  const modifiedFiles = gitState.modifiedFiles;

  const handleSelectFile = useCallback((path: string) => {
    setActiveTab(path);
    setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const handleCloseTab = useCallback(
    (path: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((p) => p !== path);
        if (activeTab === path) {
          const idx = prev.indexOf(path);
          const newActive = next[Math.min(idx, next.length - 1)] ?? null;
          setActiveTab(newActive);
        }
        return next;
      });
    },
    [activeTab],
  );

  const handleChange = useCallback(
    ({ path, content }: { path: string; content: string }) => {
      if (readOnly) return;
      onFileChange({ path, content });
    },
    [onFileChange, readOnly],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-1 min-h-0">
        <div className="w-[240px] shrink-0">
          <FileExplorer
            files={files}
            activeFile={activeTab}
            modifiedFiles={modifiedFiles}
            onSelectFile={handleSelectFile}
          />
        </div>
        <div className="flex-1 min-w-0">
          <MultiTabMonaco
            openTabs={openTabs}
            activeTab={activeTab}
            files={files}
            modifiedFiles={modifiedFiles}
            onSelectTab={handleSelectFile}
            onCloseTab={handleCloseTab}
            onChange={handleChange}
            readOnly={readOnly}
            onRunWorkflow={onRunWorkflow}
          />
        </div>
      </div>
      <GitPanel gitState={gitState} baselineFiles={baselineFiles} />
    </div>
  );
}
