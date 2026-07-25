import type { ParameterInfo, WorkflowNodeType } from "@catamorphic/parser";
import {
  codeAtom,
  codeEditorReadOnlyAtom,
  executionStateAtom,
  graphAtom,
  lastTriggerDataAtom,
  type OnParseCallback,
  panelVisibilityAtom,
  rightPanelOpenAtom,
  showRunDialogAtom,
  useEditorKeyboard,
  useWorkflowGraph,
} from "@catamorphic/react";
import type { Run, WorkflowCapabilities } from "@catamorphic/react/types";
import type { NodeTypes } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { AIBar } from "./ai-bar.js";
import { WorkflowCanvas } from "./canvas.js";
import { type CodeEditorRenderProps, DetailPanel } from "./detail-panel.js";
import { RunTriggerDialog } from "./run-trigger-dialog.js";
import { Toolbar } from "./toolbar.js";
import { WorkflowEditorScope } from "./workflow-editor-scope.js";

export interface WorkflowEditorProps {
  code: string;
  onCodeChange: (code: string) => void;
  /**
   * Turns the current source into a laid-out `WorkflowGraph`. Without this,
   * the canvas stays empty — `<WorkflowEditor>` has no default parser because
   * the parser bundle depends on the project file map, which only the host
   * has in scope.
   *
   * Prefer `useOnParse({ files, workflowName, preferredFilePath })` from
   * `@catamorphic/react` — it composes `useParseWorkflow` with `layoutGraph`
   * into a stable callback. Only write a custom `OnParseCallback` when you
   * need to replace the server-side parser entirely.
   */
  onParse?: OnParseCallback;
  renderCodeEditor?: (props: CodeEditorRenderProps) => ReactNode;
  nodeRenderers?: Partial<Record<WorkflowNodeType, NodeTypes[string]>>;
  theme?: Record<string, string>;
  aiEnabled?: boolean;
  onAIPrompt?: (prompt: string) => Promise<string>;
  executionState?: Record<string, string>;
  showCodeEditor?: boolean;
  showMinimap?: boolean;
  /** Canonical capabilities from the loaded Workflow. */
  workflowCapabilities?: WorkflowCapabilities;
  /** Starts a production Run. Available for every Workflow. */
  onRun?: (input: Record<string, unknown>) => Promise<Run>;
  /** Starts a test Run. Shown only when the Workflow can run without continuations. */
  onTestRun?: (input: Record<string, unknown>) => Promise<Run>;
  triggerParameters?: ParameterInfo[];
  onExpandEditor?: () => void;
  renderRunsPanel?: (props: { activeRun?: Run }) => ReactNode;
  renderBanner?: () => ReactNode;
  renderToolbarCenter?: () => ReactNode;
  /** When true, disables the code editor. */
  readOnly?: boolean;
}

/**
 * Inner editor rendering. Assumes an ambient `<WorkflowEditorScope>` — this
 * is the entry point for hosts that want to compose the editor alongside
 * their own chrome (custom toolbars, inspectors, etc.) while still sharing
 * the canvas state atoms.
 *
 * For the one-shot drop-in experience, mount `<WorkflowEditor>` instead,
 * which wraps this component in a scope for you.
 */
export function WorkflowEditorChrome({
  code,
  onCodeChange,
  onParse,
  renderCodeEditor,
  nodeRenderers,
  executionState,
  showCodeEditor = true,
  showMinimap = true,
  workflowCapabilities,
  onRun,
  onTestRun,
  triggerParameters,
  aiEnabled = false,
  onAIPrompt,
  onExpandEditor,
  renderRunsPanel,
  renderBanner,
  renderToolbarCenter,
  readOnly = false,
}: WorkflowEditorProps) {
  const [currentCode, setCode] = useAtom(codeAtom);
  const setExecutionState = useSetAtom(executionStateAtom);
  const setPanelVisibility = useSetAtom(panelVisibilityAtom);
  const setRightPanelOpen = useSetAtom(rightPanelOpenAtom);
  const graph = useAtomValue(graphAtom);
  const [showDialog, setShowDialog] = useAtom(showRunDialogAtom);
  const lastTriggerData = useAtomValue(lastTriggerDataAtom);
  const setLastTriggerData = useSetAtom(lastTriggerDataAtom);
  const setReadOnly = useSetAtom(codeEditorReadOnlyAtom);
  const [runMode, setRunMode] = useState<"test" | "production">("production");
  const [isRunning, setIsRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<Run>();

  useEffect(() => {
    setReadOnly(readOnly);
  }, [readOnly, setReadOnly]);

  useEffect(() => {
    setCode(code);
  }, [code, setCode]);

  // `executionState` is fully controlled: an undefined prop resets the atom
  // so hosts can clear the canvas by dropping the prop, and a `{}` value
  // explicitly means "no nodes executing".
  useEffect(() => {
    setExecutionState(executionState ?? {});
  }, [executionState, setExecutionState]);

  useEffect(() => {
    setPanelVisibility((v) => ({
      ...v,
      minimap: showMinimap,
    }));
  }, [showMinimap, setPanelVisibility]);

  // `showCodeEditor` is bidirectional: flipping it to `false` closes the
  // panel, not just opens on `true`. Prevents a stale-open panel when the
  // host toggles code editing off.
  useEffect(() => {
    setRightPanelOpen(showCodeEditor);
  }, [showCodeEditor, setRightPanelOpen]);

  useWorkflowGraph({ onParse });
  useEditorKeyboard();

  const handleCodeChange = useCallback(
    (newCode: string) => {
      setCode(newCode);
      onCodeChange(newCode);
    },
    [setCode, onCodeChange],
  );

  const handleRunClick = useCallback(() => {
    if (!onRun) return;
    setRunMode("production");
    setShowDialog(true);
  }, [onRun, setShowDialog]);

  const currentCapabilities = graph?.capabilities ?? workflowCapabilities;
  const canTestRun = currentCapabilities?.persistedContinuations === false;
  const handleTestRunClick = useCallback(() => {
    if (!onTestRun || !canTestRun) return;
    setRunMode("test");
    setShowDialog(true);
  }, [canTestRun, onTestRun, setShowDialog]);

  const submitRun = useCallback(
    async (input: Record<string, unknown>) => {
      const trigger = runMode === "test" ? onTestRun : onRun;
      if (!trigger) return;
      setLastTriggerData(input);
      setIsRunning(true);
      try {
        const run = await trigger(input);
        setActiveRun(run);
        setShowDialog(false);
        setPanelVisibility((current) => ({
          ...current,
          runsPanel: true,
        }));
      } finally {
        setIsRunning(false);
      }
    },
    [
      onRun,
      onTestRun,
      runMode,
      setLastTriggerData,
      setPanelVisibility,
      setShowDialog,
    ],
  );

  const params = triggerParameters ?? graph?.trigger.parameters ?? [];

  return (
    <div className="catamorphic-editor">
      <Toolbar
        onRun={onRun ? handleRunClick : undefined}
        onTestRun={onTestRun ? handleTestRunClick : undefined}
        testRunEnabled={canTestRun}
        isRunning={isRunning}
        centerSlot={renderToolbarCenter?.()}
      />
      {renderBanner?.()}
      <div className="catamorphic-editor-body">
        <div className="catamorphic-editor-canvas">
          <WorkflowCanvas nodeRenderers={nodeRenderers} />
        </div>
        <DetailPanel
          renderCodeEditor={renderCodeEditor}
          code={currentCode}
          onCodeChange={handleCodeChange}
          onExpandEditor={onExpandEditor}
        />
        <RunsPanelSlot
          activeRun={activeRun}
          renderRunsPanel={renderRunsPanel}
        />
      </div>
      <AIBar
        enabled={aiEnabled}
        onAIPrompt={onAIPrompt}
        onApplyGeneratedCode={
          aiEnabled && onAIPrompt
            ? (newCode) => {
                setCode(newCode);
                onCodeChange(newCode);
              }
            : undefined
        }
      />
      {showDialog && (
        <RunTriggerDialog
          parameters={params}
          mode={runMode}
          isRunning={isRunning}
          initialValues={lastTriggerData}
          onRun={submitRun}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

function RunsPanelSlot({
  activeRun,
  renderRunsPanel,
}: {
  activeRun?: Run;
  renderRunsPanel?: (props: { activeRun?: Run }) => ReactNode;
}) {
  const panelVisibility = useAtomValue(panelVisibilityAtom);
  if (!panelVisibility.runsPanel) return null;
  return (
    <aside className="catamorphic-runs-sidebar">
      {renderRunsPanel ? (
        renderRunsPanel({ activeRun })
      ) : (
        <div className="catamorphic-run-empty">
          <p>Runs are not connected</p>
          <p className="catamorphic-run-empty-hint">
            Provide renderRunsPanel to connect this view.
          </p>
        </div>
      )}
    </aside>
  );
}

/**
 * Drop-in workflow editor. Wraps `<WorkflowEditorChrome>` in a
 * `<WorkflowEditorScope>`, so hosts that just want "an editor" mount this
 * and are done.
 *
 * The scope is idempotent: if you've already placed a
 * `<WorkflowEditorScope>` higher in the tree (to share atoms with sibling
 * chrome), this component will reuse it instead of creating a nested,
 * disconnected store.
 */
export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <WorkflowEditorScope>
      <WorkflowEditorChrome {...props} />
    </WorkflowEditorScope>
  );
}
