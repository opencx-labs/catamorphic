"use client";

import { WorkflowEditor } from "@catamorphic/ui";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import "@catamorphic/ui/styles.css";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { ProjectEditor } from "@/components/project-editor";
import { generateWorkflowCode } from "@/lib/ai-action";
import { parseWorkflowFromProjectAction } from "@/lib/parse-action";
import { findWorkflowFile, SAMPLE_PROJECTS } from "@/lib/sample-projects";

export default function WorkflowPage() {
  const params = useParams<{ projectId: string; name: string }>();
  const project = SAMPLE_PROJECTS[params.projectId];

  const [expanded, setExpanded] = useState(false);
  const [projectFiles, setProjectFiles] = useState<Record<string, string>>(
    () => project?.files ?? {},
  );

  const workflowFilePath = useMemo(
    () =>
      findWorkflowFile({
        files: projectFiles,
        workflowName: params.name,
      }),
    [projectFiles, params.name],
  );

  const workflowCode = workflowFilePath
    ? (projectFiles[workflowFilePath] ?? "")
    : "";

  const projectFilesRef = useRef(projectFiles);
  projectFilesRef.current = projectFiles;

  const handleCodeChange = useCallback(
    (newCode: string) => {
      if (!workflowFilePath) return;
      setProjectFiles((prev) => ({
        ...prev,
        [workflowFilePath]: newCode,
      }));
    },
    [workflowFilePath],
  );

  const handleParse = useCallback(
    async (source: string) => {
      const files = { ...projectFilesRef.current };
      if (workflowFilePath) {
        files[workflowFilePath] = source;
      }
      return parseWorkflowFromProjectAction({
        files,
        workflowName: params.name,
      });
    },
    [workflowFilePath, params.name],
  );

  const handleAIPrompt = useCallback(
    async (prompt: string) => {
      return generateWorkflowCode({
        prompt,
        currentCode: workflowCode,
      });
    },
    [workflowCode],
  );

  const handleFileChange = useCallback(
    ({ path, content }: { path: string; content: string }) => {
      setProjectFiles((prev) => ({ ...prev, [path]: content }));
    },
    [],
  );

  if (!project) {
    notFound();
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      <div className="flex items-center gap-2 text-sm text-neutral-400 px-4 py-2 border-b border-neutral-800 bg-neutral-950/50 shrink-0">
        <Link href="/" className="hover:text-neutral-200 transition-colors">
          Projects
        </Link>
        <span className="text-neutral-600">/</span>
        <Link
          href={`/projects/${params.projectId}`}
          className="hover:text-neutral-200 transition-colors"
        >
          {project.name}
        </Link>
        <span className="text-neutral-600">/</span>
        <span className="text-neutral-200">{params.name}</span>

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
            onExpandEditor={() => setExpanded(true)}
          />
        )}
      </div>
    </div>
  );
}
