import {
  codeAtom,
  useOnParse,
  useProjectFile,
  useWorkflow,
  useWorkflowGraph,
  useWorkflows,
  useWriteProjectFile,
} from "@catamorphic/react";
import {
  DetailPanel,
  WorkflowCanvas,
  WorkflowEditorScope,
} from "@catamorphic/ui";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { MonacoCodeEditor } from "../components/catamorphic/monaco-editor.js";
import "../lib/monaco-setup.js";
import { PendingButton } from "../components/pending-button.js";
import { WorkflowEnablementPanel } from "../components/workflow-enablement-panel.js";
import { useTheme } from "../lib/theme.js";

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

  if (!summary || !filePath || fileQuery.isLoading) {
    return (
      <div className="grid flex-1 place-items-center">
        <p className="animate-pulse text-sm text-fg-muted">Loading workflow…</p>
      </div>
    );
  }
  if (fileQuery.error) {
    return (
      <div className="grid flex-1 place-items-center">
        <p className="text-sm text-danger">{fileQuery.error.message}</p>
      </div>
    );
  }

  return (
    <WorkflowScreenInner
      key={`${projectId}:${workflowName}`}
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
  const theme = useTheme();
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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [enablementOpen, setEnablementOpen] = useState(false);

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    try {
      await writeFile.mutateAsync({ path: filePath, content: code });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch {
      setSaveState("idle");
    }
  }, [filePath, code, writeFile]);

  if (workflow.isLoading) {
    return (
      <div className="grid flex-1 place-items-center">
        <p className="animate-pulse text-sm text-fg-muted">
          Loading workflow graph…
        </p>
      </div>
    );
  }
  if (workflow.error) {
    return (
      <div className="grid flex-1 place-items-center">
        <p className="text-sm text-danger">{workflow.error.message}</p>
      </div>
    );
  }

  // Composed directly from the decoupled pieces (canvas, detail panel,
  // scope) instead of the all-in-one <WorkflowEditor>, so the chrome —
  // save button, chat dock — is app-owned and token-styled.
  return (
    <WorkflowEditorScope>
      <GraphWiring code={code} onParse={onParse} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-b border-border px-3">
          <button
            type="button"
            onClick={() => setEnablementOpen(true)}
            className="h-7 cursor-pointer rounded-md border border-border px-3 text-xs font-medium hover:bg-bg-overlay"
          >
            Automate
          </button>
          <PendingButton
            type="button"
            pending={saveState === "saving"}
            pendingLabel="Saving…"
            className="h-7 cursor-pointer rounded-md bg-accent px-3 text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
            onClick={() => void handleSave()}
            disabled={code === initialCode}
          >
            {saveState === "saved" ? "Saved" : "Save"}
          </PendingButton>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <WorkflowCanvas />
          </div>
          <DetailPanel
            code={code}
            onCodeChange={setCode}
            renderCodeEditor={({ code: editorCode, onChange, readOnly }) => (
              <MonacoCodeEditor
                code={editorCode}
                onChange={onChange}
                readOnly={readOnly}
                path={`file:///${filePath}`}
                theme={theme?.appearance === "light" ? "light" : "vs-dark"}
              />
            )}
          />
        </div>
        {enablementOpen && (
          <WorkflowEnablementPanel
            projectId={projectId}
            workflowName={workflowName}
            onClose={() => setEnablementOpen(false)}
          />
        )}
      </div>
    </WorkflowEditorScope>
  );
}

/**
 * Bridges host state into the editor scope atoms. Must render inside
 * `WorkflowEditorScope`; kept as a null component so the hooks can use the
 * scoped jotai store.
 */
function GraphWiring({
  code,
  onParse,
}: {
  code: string;
  onParse: Parameters<typeof useWorkflowGraph>[0]["onParse"];
}) {
  const setCode = useSetAtom(codeAtom);
  useEffect(() => {
    setCode(code);
  }, [code, setCode]);
  useWorkflowGraph({ onParse });
  return null;
}
