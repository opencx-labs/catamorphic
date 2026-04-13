"use client";

import { type PlaygroundRun, WorkflowEditor } from "@catamorphic/ui";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import "@catamorphic/ui/styles.css";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { ProjectEditor } from "@/components/project-editor";
import { generateWorkflowCode } from "@/lib/ai-action";
import { api, type WorkflowGraph } from "@/lib/api";
import { parseWorkflowFromProjectAction } from "@/lib/parse-action";
import { runWorkflowAction } from "@/lib/run-action";

const PAGE_SIZE = 20;

interface Props {
  projectId: string;
  workflowName: string;
  initialGraph: WorkflowGraph;
  initialFiles: Record<string, string>;
  initialRuns: PlaygroundRun[];
}

function findWorkflowFile(
  files: Record<string, string>,
  workflowName: string,
): string | null {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    const fnPattern = new RegExp(
      `(?:export\\s+)?async\\s+function\\s+${workflowName}\\s*\\(`,
    );
    if (fnPattern.test(content) && content.includes('"use workflow"')) {
      return path;
    }
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
    () => findWorkflowFile(projectFiles, workflowName),
    [projectFiles, workflowName],
  );

  const workflowCode = workflowFilePath
    ? (projectFiles[workflowFilePath] ?? "")
    : (initialGraph.sourceCode ?? "");

  const projectFilesRef = useRef(projectFiles);
  projectFilesRef.current = projectFiles;

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
      return parseWorkflowFromProjectAction({ files, workflowName });
    },
    [workflowFilePath, initialGraph.filePath, workflowName],
  );

  const handleAIPrompt = useCallback(
    async (prompt: string) => {
      return generateWorkflowCode({ prompt, currentCode: workflowCode });
    },
    [workflowCode],
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
      const response = await api.getRuns(projectId, workflowName, {
        limit: PAGE_SIZE,
        offset,
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
      return { items, hasMore: offset + items.length < response.total };
    },
    [projectId, workflowName],
  );

  const handleFileChange = useCallback(
    ({ path, content }: { path: string; content: string }) => {
      setProjectFiles((prev) => ({ ...prev, [path]: content }));
    },
    [],
  );

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      <div className="flex items-center gap-2 text-sm text-neutral-400 px-4 py-2 border-b border-neutral-800 bg-neutral-950/50 shrink-0">
        <Link href="/" className="hover:text-neutral-200 transition-colors">
          Projects
        </Link>
        <span className="text-neutral-600">/</span>
        <Link
          href={`/projects/${projectId}`}
          className="hover:text-neutral-200 transition-colors"
        >
          {projectId.slice(0, 8)}&hellip;
        </Link>
        <span className="text-neutral-600">/</span>
        <span className="text-neutral-200">
          {initialGraph.displayName ?? workflowName}
        </span>

        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-auto text-xs px-3 py-1 rounded border border-neutral-700 hover:border-neutral-500 hover:text-neutral-200 transition-colors"
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
