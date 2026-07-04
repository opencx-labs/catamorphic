import {
  type PlaygroundRun,
  useCatamorphic,
  useDeployProject,
  useOnParse,
  useProjectFile,
  useTriggerWorkflowRun,
  useWorkflowRuns,
  useWorkflows,
  useWriteProjectFile,
} from "@catamorphic/react";
import { WorkflowEditor } from "@catamorphic/ui";
import { useCallback, useState } from "react";
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
      filePath={filePath}
      initialCode={fileQuery.data?.content ?? ""}
    />
  );
}

function WorkflowScreenInner({
  projectId,
  workflowName,
  filePath,
  initialCode,
}: {
  projectId: string;
  workflowName: string;
  filePath: string;
  initialCode: string;
}) {
  const [code, setCode] = useState(initialCode);
  const { apiClient } = useCatamorphic();

  const onParse = useOnParse({
    files: { [filePath]: code },
    workflowName,
    preferredFilePath: filePath,
  });

  const writeFile = useWriteProjectFile(projectId);
  const deploy = useDeployProject(projectId);
  const trigger = useTriggerWorkflowRun(projectId, workflowName);
  const runsQuery = useWorkflowRuns(projectId, workflowName, { limit: 25 });

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
    async (triggerData: Record<string, unknown>) => {
      const run = await trigger.mutateAsync({ triggerData });
      const detail = await apiClient.GET("/api/runs/{runId}", {
        params: { path: { runId: run.id } },
      });
      const steps = detail.data?.steps ?? [];
      return {
        runId: run.id,
        status:
          run.status === "completed"
            ? ("completed" as const)
            : ("failed" as const),
        result: run.result,
        error: run.error,
        steps: steps.map((step) => ({
          nodeId: step.nodeId,
          name: step.name,
          status:
            step.status === "completed"
              ? ("completed" as const)
              : ("failed" as const),
          input: step.input,
          output: step.output,
          error: step.error ?? undefined,
          startedAt: step.startedAt ?? new Date().toISOString(),
          completedAt: step.completedAt ?? new Date().toISOString(),
        })),
        startedAt: run.startedAt ?? new Date().toISOString(),
        completedAt: run.completedAt ?? new Date().toISOString(),
      };
    },
    [trigger, apiClient],
  );

  const initialRuns: PlaygroundRun[] = (runsQuery.data?.items ?? []).map(
    (run) => ({
      id: run.id,
      workflowName: run.workflowName,
      status:
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "running" ||
        run.status === "pending"
          ? run.status
          : "failed",
      triggerData: (run.triggerData ?? {}) as Record<string, unknown>,
      result: run.result,
      error: run.error ?? undefined,
      steps: [],
      startedAt: run.startedAt ?? run.createdAt,
      completedAt: run.completedAt ?? undefined,
    }),
  );

  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      onParse={onParse}
      onRun={onRun}
      initialRuns={initialRuns}
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
            ? "Deploying…"
            : deployState === "deployed"
              ? "Deployed ✓"
              : deployState === "error"
                ? "Deploy failed — retry"
                : "Deploy"}
        </button>
      )}
    />
  );
}
