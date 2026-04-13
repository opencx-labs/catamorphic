import type { ParameterInfo, WorkflowNodeType } from "@catamorphic/parser";
import { ReactFlowProvider } from "@xyflow/react";
import { Provider, useAtom, useAtomValue, useSetAtom } from "jotai";
import type { ComponentType, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { AIBar } from "./ai-bar.js";
import {
  activeHistoryTabAtom,
  activeRunIdAtom,
  codeAtom,
  executionStateAtom,
  graphAtom,
  historySidebarOpenAtom,
  isRunningAtom,
  type LoadMoreRunsFn,
  lastTriggerDataAtom,
  loadMoreRunsAtom,
  panelVisibilityAtom,
  rightPanelOpenAtom,
  runsAtom,
  showRunDialogAtom,
} from "./atoms.js";
import { WorkflowCanvas } from "./canvas.js";
import { type CodeEditorRenderProps, DetailPanel } from "./detail-panel.js";
import { HistorySidebar } from "./history-sidebar.js";
import {
  type OnParseCallback,
  useWorkflowGraph,
} from "./hooks/use-workflow-graph.js";
import { RunTriggerDialog } from "./run-trigger-dialog.js";
import type { PlaygroundRun, PlaygroundRunStep } from "./run-types.js";
import { Toolbar } from "./toolbar.js";
import type { NodeRendererProps } from "./types.js";

export interface WorkflowEditorProps {
  code: string;
  onCodeChange: (code: string) => void;
  onParse?: OnParseCallback;
  renderCodeEditor?: (props: CodeEditorRenderProps) => ReactNode;
  nodeRenderers?: Partial<
    Record<WorkflowNodeType, ComponentType<NodeRendererProps>>
  >;
  theme?: Record<string, string>;
  aiEnabled?: boolean;
  onAIPrompt?: (prompt: string) => Promise<string>;
  executionState?: Record<string, string>;
  showCodeEditor?: boolean;
  showRunsPanel?: boolean;
  showMinimap?: boolean;
  onRun?: (triggerData: Record<string, unknown>) => Promise<{
    runId?: string | null;
    status: "completed" | "failed";
    result?: unknown;
    error?: string | null;
    steps: PlaygroundRunStep[];
    startedAt: string;
    completedAt: string;
  }>;
  onLoadMoreRuns?: LoadMoreRunsFn;
  triggerParameters?: ParameterInfo[];
  initialRuns?: PlaygroundRun[];
  onExpandEditor?: () => void;
}

function WorkflowEditorInner({
  code,
  onCodeChange,
  onParse,
  renderCodeEditor,
  executionState,
  showCodeEditor = true,
  showMinimap = true,
  onRun,
  onLoadMoreRuns,
  triggerParameters,
  initialRuns,
  aiEnabled = false,
  onAIPrompt,
  onExpandEditor,
}: WorkflowEditorProps) {
  const [currentCode, setCode] = useAtom(codeAtom);
  const setExecutionState = useSetAtom(executionStateAtom);
  const setPanelVisibility = useSetAtom(panelVisibilityAtom);
  const [rightPanelOpen, setRightPanelOpen] = useAtom(rightPanelOpenAtom);
  const graph = useAtomValue(graphAtom);
  const [showDialog, setShowDialog] = useAtom(showRunDialogAtom);
  const [isRunning, setIsRunning] = useAtom(isRunningAtom);
  const setRuns = useSetAtom(runsAtom);
  const setActiveRunId = useSetAtom(activeRunIdAtom);
  const [historySidebarOpen, setHistorySidebarOpen] = useAtom(
    historySidebarOpenAtom,
  );
  const setActiveHistoryTab = useSetAtom(activeHistoryTabAtom);
  const [lastTriggerData, setLastTriggerData] = useAtom(lastTriggerDataAtom);
  const setLoadMoreRuns = useSetAtom(loadMoreRunsAtom);

  useEffect(() => {
    setCode(code);
  }, [code, setCode]);

  useEffect(() => {
    if (executionState) {
      setExecutionState(executionState);
    }
  }, [executionState, setExecutionState]);

  useEffect(() => {
    setPanelVisibility((v) => ({
      ...v,
      minimap: showMinimap,
    }));
  }, [showMinimap, setPanelVisibility]);

  useEffect(() => {
    if (showCodeEditor) {
      setRightPanelOpen(true);
    }
  }, [showCodeEditor, setRightPanelOpen]);

  useWorkflowGraph({ onParse });

  useEffect(() => {
    if (initialRuns && initialRuns.length > 0) {
      setRuns(initialRuns);
    }
  }, [initialRuns, setRuns]);

  useEffect(() => {
    setLoadMoreRuns(onLoadMoreRuns ?? null);
  }, [onLoadMoreRuns, setLoadMoreRuns]);

  // Escape closes the frontmost open panel (history sidebar first, then detail panel).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (historySidebarOpen) {
        setHistorySidebarOpen(false);
      } else if (rightPanelOpen) {
        setRightPanelOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    historySidebarOpen,
    setHistorySidebarOpen,
    rightPanelOpen,
    setRightPanelOpen,
  ]);

  const handleCodeChange = useCallback(
    (newCode: string) => {
      setCode(newCode);
      onCodeChange(newCode);
    },
    [setCode, onCodeChange],
  );

  const handleRunClick = useCallback(() => {
    if (onRun) {
      setShowDialog(true);
    }
  }, [onRun, setShowDialog]);

  const handleRunSubmit = useCallback(
    async (triggerData: Record<string, unknown>) => {
      if (!onRun) return;
      setLastTriggerData(triggerData);

      const runId = crypto.randomUUID();
      const workflowName = graph?.name ?? "unknown";
      const startedAt = new Date().toISOString();

      const pendingRun: PlaygroundRun = {
        id: runId,
        workflowName,
        status: "running",
        triggerData,
        steps: [],
        startedAt,
      };

      setRuns((prev) => [pendingRun, ...prev]);
      setActiveRunId(runId);
      setIsRunning(true);
      setShowDialog(false);
      setHistorySidebarOpen(true);
      setActiveHistoryTab("runs");

      const nodeIds = (graph?.nodes ?? [])
        .filter(
          (n) =>
            n.type === "step" || n.type === "trigger" || n.type === "return",
        )
        .map((n) => n.id);
      const runningState: Record<string, string> = {};
      for (const id of nodeIds) {
        runningState[id] = "running";
      }
      setExecutionState(runningState);

      try {
        const result = await onRun(triggerData);
        const finalId = result.runId ?? runId;

        const completedRun: PlaygroundRun = {
          id: finalId,
          workflowName,
          status: result.status,
          triggerData,
          result: result.result,
          error: result.error ?? undefined,
          steps: result.steps,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        };

        setRuns((prev) => prev.map((r) => (r.id === runId ? completedRun : r)));
        setActiveRunId(finalId);

        const execState: Record<string, string> = {};
        for (const step of result.steps) {
          execState[step.nodeId] = step.status;
        }
        const triggerNode = (graph?.nodes ?? []).find(
          (n) => n.type === "trigger",
        );
        if (triggerNode) {
          execState[triggerNode.id] = result.status;
        }
        const returnNode = (graph?.nodes ?? []).find(
          (n) => n.type === "return",
        );
        if (returnNode) {
          execState[returnNode.id] = result.status;
        }
        setExecutionState(execState);
      } catch (err) {
        const failedRun: PlaygroundRun = {
          id: runId,
          workflowName,
          status: "failed",
          triggerData,
          error: err instanceof Error ? err.message : String(err),
          steps: [],
          startedAt,
          completedAt: new Date().toISOString(),
        };

        setRuns((prev) => prev.map((r) => (r.id === runId ? failedRun : r)));
        setExecutionState({});
      } finally {
        setIsRunning(false);
      }
    },
    [
      onRun,
      graph,
      setRuns,
      setActiveRunId,
      setIsRunning,
      setShowDialog,
      setHistorySidebarOpen,
      setActiveHistoryTab,
      setExecutionState,
      setLastTriggerData,
    ],
  );

  const params = triggerParameters ?? graph?.trigger.parameters ?? [];

  return (
    <div className="catamorphic-editor">
      <Toolbar
        onRun={onRun ? handleRunClick : undefined}
        isRunning={isRunning}
      />
      <div className="catamorphic-editor-body">
        <div className="catamorphic-editor-canvas">
          <WorkflowCanvas />
        </div>
        <DetailPanel
          renderCodeEditor={renderCodeEditor}
          code={currentCode}
          onCodeChange={handleCodeChange}
          onExpandEditor={onExpandEditor}
        />
        {historySidebarOpen && <HistorySidebar />}
      </div>
      <AIBar enabled={aiEnabled} onAIPrompt={onAIPrompt} />
      {showDialog && (
        <RunTriggerDialog
          parameters={params}
          isRunning={isRunning}
          initialValues={lastTriggerData}
          onRun={handleRunSubmit}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <Provider>
      <ReactFlowProvider>
        <WorkflowEditorInner {...props} />
      </ReactFlowProvider>
    </Provider>
  );
}
