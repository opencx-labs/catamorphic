"use client";

import { type PlaygroundRun, WorkflowEditor } from "@catamorphic/ui";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@catamorphic/ui/styles.css";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { ProjectEditor } from "@/components/project-editor";
import { generateWorkflowCode } from "@/lib/ai-action";
import { api, type WorkflowGraph } from "@/lib/api";
import { parseWorkflowFromProjectAction } from "@/lib/parse-action";
import { runWorkflowAction } from "@/lib/run-action";
import {
  readWorkflowDisplayName,
  upsertWorkflowDisplayName,
} from "@/lib/workflow-helpers";

const PAGE_SIZE = 20;

interface Props {
  projectId: string;
  workflowName: string;
  initialGraph: WorkflowGraph;
  initialFiles: Record<string, string>;
  initialRuns: PlaygroundRun[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findWorkflowFile(
  files: Record<string, string>,
  workflowName: string,
  filePathHint?: string | null,
): string | null {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    const fnPattern = new RegExp(
      `(?:export\\s+)?async\\s+function\\s+${escapeRegExp(workflowName)}\\s*\\(`,
    );
    if (fnPattern.test(content) && content.includes('"use workflow"')) {
      return path;
    }
  }
  if (filePathHint && files[filePathHint]?.includes('"use workflow"')) {
    return filePathHint;
  }
  return null;
}

export function WorkflowPageClient({
  projectId,
  workflowName,
  initialGraph,
  initialFiles,
  initialRuns,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [projectFiles, setProjectFiles] =
    useState<Record<string, string>>(initialFiles);

  const workflowFilePath = useMemo(
    () =>
      findWorkflowFile(
        projectFiles,
        workflowName,
        initialGraph.filePath || null,
      ),
    [projectFiles, workflowName, initialGraph.filePath],
  );

  const workflowCode = workflowFilePath
    ? (projectFiles[workflowFilePath] ?? "")
    : (initialGraph.sourceCode ?? "");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [title, setTitle] = useState<string>(
    initialGraph.displayName ??
      readWorkflowDisplayName(workflowCode, workflowName) ??
      workflowName,
  );

  useEffect(() => {
    if (isEditingTitle) return;
    const nextTitle =
      readWorkflowDisplayName(workflowCode, workflowName) ??
      initialGraph.displayName ??
      workflowName;
    setTitle(nextTitle);
  }, [workflowCode, workflowName, initialGraph.displayName, isEditingTitle]);

  const projectFilesRef = useRef(projectFiles);
  projectFilesRef.current = projectFiles;
  const titleEditorRef = useRef<HTMLDivElement | null>(null);

  const handleCodeChange = useCallback(
    (newCode: string) => {
      const path = workflowFilePath ?? initialGraph.filePath;
      setProjectFiles((prev) => ({ ...prev, [path]: newCode }));
    },
    [workflowFilePath, initialGraph.filePath],
  );

  const handleParse = useCallback(
    async (source: string) => {
      const files = { ...projectFilesRef.current };
      const path = workflowFilePath ?? initialGraph.filePath;
      files[path] = source;
      return parseWorkflowFromProjectAction({
        files,
        workflowName,
        preferredFilePath:
          workflowFilePath ?? initialGraph.filePath ?? undefined,
      });
    },
    [workflowFilePath, initialGraph.filePath, workflowName],
  );

  const handleAIPrompt = useCallback(
    async (prompt: string) => {
      return generateWorkflowCode({
        prompt,
        currentCode: workflowCode,
        workflowFunctionName: workflowName,
      });
    },
    [workflowCode, workflowName],
  );

  const handleRun = useCallback(
    async (triggerData: Record<string, unknown>) => {
      return runWorkflowAction({
        projectId,
        files: projectFilesRef.current,
        workflowName,
        triggerData,
      });
    },
    [projectId, workflowName],
  );

  const handleLoadMoreRuns = useCallback(
    async (offset: number) => {
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
      try {
        const response = await api.getRuns(projectId, workflowName, {
          limit: PAGE_SIZE,
          offset: safeOffset,
        });
        const items = response.items.map(
          (run): PlaygroundRun => ({
            id: run.id,
            workflowName: run.workflowName,
            status:
              run.status === "cancelled"
                ? "failed"
                : (run.status as PlaygroundRun["status"]),
            triggerData:
              run.triggerData != null && typeof run.triggerData === "object"
                ? (run.triggerData as Record<string, unknown>)
                : {},
            result: run.result ?? undefined,
            error: run.error ?? undefined,
            steps: [],
            startedAt: run.startedAt ?? run.createdAt,
            completedAt: run.completedAt ?? undefined,
          }),
        );
        return {
          items,
          hasMore: safeOffset + items.length < response.total,
        };
      } catch {
        return { items: [], hasMore: false };
      }
    },
    [projectId, workflowName],
  );

  const handleFileChange = useCallback(
    ({ path, content }: { path: string; content: string }) => {
      setProjectFiles((prev) => ({ ...prev, [path]: content }));
    },
    [],
  );

  const handleStartEditTitle = useCallback(() => {
    setTitleInput(title);
    setIsEditingTitle(true);
  }, [title]);

  const handleSaveTitle = useCallback(() => {
    const nextTitle = titleInput.trim();
    if (nextTitle.length === 0) {
      setIsEditingTitle(false);
      return;
    }

    const path = workflowFilePath ?? initialGraph.filePath;
    const updatedCode = upsertWorkflowDisplayName(
      workflowCode,
      workflowName,
      nextTitle,
    );
    if (updatedCode !== workflowCode) {
      setProjectFiles((prev) => ({ ...prev, [path]: updatedCode }));
    }
    setTitle(nextTitle);
    setIsEditingTitle(false);
  }, [
    titleInput,
    workflowFilePath,
    initialGraph.filePath,
    workflowCode,
    workflowName,
  ]);

  useEffect(() => {
    if (!isEditingTitle) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (titleEditorRef.current?.contains(target)) return;
      handleSaveTitle();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isEditingTitle, handleSaveTitle]);

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      <div className="flex items-center gap-2 text-sm text-neutral-400 px-4 py-2 border-b border-neutral-800 bg-neutral-950/50 shrink-0">
        <Link
          href="/"
          className="cursor-pointer hover:text-neutral-200 transition-colors"
        >
          Projects
        </Link>
        <span className="text-neutral-600">/</span>
        <Link
          href={`/projects/${projectId}`}
          className="cursor-pointer hover:text-neutral-200 transition-colors"
        >
          {projectId.slice(0, 8)}&hellip;
        </Link>
        <span className="text-neutral-600">/</span>
        <div ref={titleEditorRef} className="inline-flex h-7 items-center">
          {isEditingTitle ? (
            <input
              type="text"
              value={titleInput}
              onChange={(event) => setTitleInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSaveTitle();
                }
                if (event.key === "Escape") {
                  setIsEditingTitle(false);
                }
              }}
              className="h-7 w-72 rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={handleStartEditTitle}
              className="h-7 cursor-pointer inline-flex items-center gap-1.5 text-neutral-200 hover:text-white transition-colors"
              title="Rename workflow title"
            >
              <span>{title}</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                className="text-neutral-500"
              >
                <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 2.474l-7.2 7.2a1.75 1.75 0 0 1-.77.445l-2.34.624a.75.75 0 0 1-.919-.919l.624-2.34a1.75 1.75 0 0 1 .445-.77zm1.414 1.06a.25.25 0 0 0-.354 0l-.72.72 1.414 1.414.72-.72a.25.25 0 0 0 0-.354zM11.28 4.62 4.387 11.513a.25.25 0 0 0-.064.11l-.315 1.182 1.182-.315a.25.25 0 0 0 .11-.064l6.893-6.893z" />
              </svg>
            </button>
          )}
        </div>

        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-auto cursor-pointer text-xs px-3 py-1 rounded border border-neutral-700 hover:border-neutral-500 hover:text-neutral-200 transition-colors"
          >
            &larr; Back to Graph
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {expanded ? (
          <ProjectEditor
            files={projectFiles}
            onFileChange={handleFileChange}
            initialFile={workflowFilePath ?? undefined}
          />
        ) : (
          <WorkflowEditor
            code={workflowCode}
            onCodeChange={handleCodeChange}
            onParse={handleParse}
            renderCodeEditor={(props) => <MonacoCodeEditor {...props} />}
            showCodeEditor={true}
            showMinimap={true}
            aiEnabled={true}
            onAIPrompt={handleAIPrompt}
            onRun={handleRun}
            onLoadMoreRuns={handleLoadMoreRuns}
            initialRuns={initialRuns}
            onExpandEditor={() => setExpanded(true)}
          />
        )}
      </div>
    </div>
  );
}
