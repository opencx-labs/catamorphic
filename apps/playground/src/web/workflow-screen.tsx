import {
  useDeployProject,
  useOnParse,
  useProjectFile,
  useTriggerRun,
  useTriggerTestRun,
  useWorkflow,
  useWorkflows,
  useWriteProjectFile,
} from "@catamorphic/react";
import { RunsPanel, WorkflowEditor } from "@catamorphic/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { MonacoCodeEditor } from "./monaco-editor.js";

export function WorkflowScreen({
  projectId,
  workflowName,
}: {
  projectId: string;
  workflowName: string;
}) {
  const workflows = useWorkflows(projectId);
  const summary = workflows.data?.find(
    (workflow) => workflow.name === workflowName,
  );
  const filePath = summary?.filePath;

  const fileQuery = useProjectFile(projectId, filePath);

  if (!filePath || fileQuery.isLoading) {
    return (
      <div className="pg-empty">
        <p>Loading workflow…</p>
      </div>
    );
  }
  if (fileQuery.error) {
    return (
      <div className="pg-empty">
        <p className="pg-error">{fileQuery.error.message}</p>
      </div>
    );
  }

  return (
    <WorkflowScreenInner
      projectId={projectId}
      workflowName={workflowName}
      workflowCapabilities={summary.capabilities}
      filePath={filePath}
      initialCode={fileQuery.data?.content ?? ""}
    />
  );
}

function WorkflowScreenInner({
  projectId,
  workflowName,
  workflowCapabilities,
  filePath,
  initialCode,
}: {
  projectId: string;
  workflowName: string;
  workflowCapabilities: {
    persistedContinuations: boolean;
    batchProcessing: boolean;
    cancellation: boolean;
  };
  filePath: string;
  initialCode: string;
}) {
  const [code, setCode] = useState(initialCode);
  const previousInitialCode = useRef(initialCode);
  useEffect(() => {
    const previous = previousInitialCode.current;
    previousInitialCode.current = initialCode;
    setCode((current) => (current === previous ? initialCode : current));
  }, [initialCode]);
  const workflow = useWorkflow(projectId, workflowName);

  const onParse = useOnParse({
    files: {
      ...(workflow.data?.allFiles ?? {}),
      [filePath]: code,
    },
    workflowName,
    preferredFilePath: filePath,
  });

  const writeFile = useWriteProjectFile(projectId);
  const deploy = useDeployProject(projectId);
  const triggerRun = useTriggerRun({ projectId, workflowName });
  const triggerTestRun = useTriggerTestRun({ projectId, workflowName });

  const [deployState, setDeployState] = useState<
    "idle" | "deploying" | "deployed" | "error"
  >("idle");

  const handleDeploy = useCallback(async () => {
    setDeployState("deploying");
    try {
      if (code !== initialCode) {
        await writeFile.mutateAsync({ path: filePath, content: code });
      }
      await deploy.mutateAsync({ message: "Deploy from playground" });
      setDeployState("deployed");
      setTimeout(() => setDeployState("idle"), 2000);
    } catch {
      setDeployState("error");
    }
  }, [code, initialCode, filePath, writeFile, deploy]);

  const onRun = useCallback(
    (input: Record<string, unknown>) => triggerRun.mutateAsync({ input }),
    [triggerRun],
  );

  const onTestRun = useCallback(
    (input: Record<string, unknown>) =>
      triggerTestRun.mutateAsync({
        input,
        files: { [filePath]: code },
      }),
    [triggerTestRun, filePath, code],
  );

  if (workflow.isLoading) {
    return (
      <div className="pg-empty">
        <p>Loading workflow graph…</p>
      </div>
    );
  }
  if (workflow.error) {
    return (
      <div className="pg-empty">
        <p className="pg-error">{workflow.error.message}</p>
      </div>
    );
  }

  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      onParse={onParse}
      workflowCapabilities={workflowCapabilities}
      onRun={onRun}
      onTestRun={onTestRun}
      renderRunsPanel={({ activeRun }) => (
        <RunsPanel
          projectId={projectId}
          workflowName={workflowName}
          activeRun={activeRun}
        />
      )}
      renderCodeEditor={({ code: editorCode, onChange, readOnly }) => (
        <MonacoCodeEditor
          code={editorCode}
          onChange={onChange}
          readOnly={readOnly}
          path={`file:///${filePath}`}
        />
      )}
      renderToolbarCenter={() => (
        <button
          type="button"
          className="pg-btn"
          onClick={() => void handleDeploy()}
          disabled={deployState === "deploying"}
        >
          {deployState === "deploying"
            ? "Deploying..."
            : deployState === "deployed"
              ? "Deployed"
              : deployState === "error"
                ? "Deploy failed, retry"
                : "Deploy"}
        </button>
      )}
    />
  );
}
