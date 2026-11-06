import type { ParameterInfo, WorkflowNodeType } from "@catamorphic/parser";
import {
  codeAtom,
  codeEditorReadOnlyAtom,
  executionStateAtom,
  graphAtom,
  lastTriggerDataAtom,
  type OnParseCallback,
  selectedNodeAtom,
  selectedNodeIdAtom,
  showRunDialogAtom,
  useEditorKeyboard,
  useWorkflowGraph,
} from "@catamorphic/react";
import type { Run, WorkflowNode } from "@catamorphic/react/types";
import type { NodeTypes } from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { WorkflowCanvas } from "./canvas.js";
import { RunTriggerDialog } from "./run-trigger-dialog.js";
import { WorkflowEditorScope } from "./workflow-editor-scope.js";

/** What the corner controls can do; hosts render their own from these. */
export interface WorkflowEditorControls {
  /** Opens the run dialog. Absent when the host passed no `onRun`. */
  run?: () => void;
  running: boolean;
  runsOpen: boolean;
  toggleRuns: () => void;
}

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
  /**
   * Host-owned inspector beside the canvas. It receives the selected step
   * (null when nothing is selected) and `close`, which clears the selection.
   * The host decides visibility: a selection-driven inspector renders only
   * while `node` is set, and may also show views it opens itself (code).
   */
  renderInspector?: (props: {
    node: WorkflowNode | null;
    close: () => void;
    code: string;
    onCodeChange: (code: string) => void;
    readOnly: boolean;
  }) => ReactNode;
  /**
   * Controls floating in the canvas's top-right corner. Defaults to a Runs
   * toggle and, with `onRun`, a Run action. Return null for no controls.
   */
  renderControls?: (controls: WorkflowEditorControls) => ReactNode;
  nodeRenderers?: Partial<Record<WorkflowNodeType, NodeTypes[string]>>;
  executionState?: Record<string, string>;
  showMinimap?: boolean;
  /** Starts a Run. Available for every Workflow. */
  onRun?: (input: Record<string, unknown>) => Promise<Run>;
  triggerParameters?: ParameterInfo[];
  renderRunsPanel?: (props: { activeRun?: Run }) => ReactNode;
  renderBanner?: () => ReactNode;
  /** When true, disables the code editor. */
  readOnly?: boolean;
}

/**
 * Inner editor rendering. Assumes an ambient `<WorkflowEditorScope>` — this
 * is the entry point for hosts that want to compose the editor alongside
 * their own chrome (custom controls, inspectors, etc.) while still sharing
 * the canvas state atoms.
 *
 * For the one-shot drop-in experience, mount `<WorkflowEditor>` instead,
 * which wraps this component in a scope for you.
 */
export function WorkflowEditorChrome({
  code,
  onCodeChange,
  onParse,
  renderInspector,
  renderControls = (controls) => <DefaultControls {...controls} />,
  nodeRenderers,
  executionState,
  showMinimap = false,
  onRun,
  triggerParameters,
  renderRunsPanel,
  renderBanner,
  readOnly = false,
}: WorkflowEditorProps) {
  const [currentCode, setCode] = useAtom(codeAtom);
  const setExecutionState = useSetAtom(executionStateAtom);
  const graph = useAtomValue(graphAtom);
  const node = useAtomValue(selectedNodeAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
  const [showDialog, setShowDialog] = useAtom(showRunDialogAtom);
  const lastTriggerData = useAtomValue(lastTriggerDataAtom);
  const setLastTriggerData = useSetAtom(lastTriggerDataAtom);
  const setReadOnly = useSetAtom(codeEditorReadOnlyAtom);
  const [isRunning, setIsRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<Run>();
  const [runsOpen, setRunsOpen] = useState(false);

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

  useWorkflowGraph({ onParse });
  useEditorKeyboard({
    onEscape: () => {
      if (!runsOpen) return false;
      setRunsOpen(false);
      return true;
    },
  });

  const handleCodeChange = useCallback(
    (newCode: string) => {
      setCode(newCode);
      onCodeChange(newCode);
    },
    [setCode, onCodeChange],
  );

  const submitRun = useCallback(
    async (input: Record<string, unknown>) => {
      if (!onRun) return;
      setLastTriggerData(input);
      setIsRunning(true);
      try {
        const run = await onRun(input);
        setActiveRun(run);
        setShowDialog(false);
        setRunsOpen(true);
      } finally {
        setIsRunning(false);
      }
    },
    [onRun, setLastTriggerData, setShowDialog],
  );

  const params = triggerParameters ?? graph?.input.parameters ?? [];
  const controls = renderControls({
    run: onRun ? () => setShowDialog(true) : undefined,
    running: isRunning,
    runsOpen,
    toggleRuns: () => setRunsOpen((open) => !open),
  });

  return (
    <div className="catamorphic-editor">
      {renderBanner?.()}
      <div className="catamorphic-editor-body">
        <div className="catamorphic-editor-canvas">
          <WorkflowCanvas
            nodeRenderers={nodeRenderers}
            showMinimap={showMinimap}
          />
          {controls && (
            <div className="catamorphic-editor-controls">{controls}</div>
          )}
        </div>
        {renderInspector?.({
          node,
          close: () => setSelectedNodeId(null),
          code: currentCode,
          onCodeChange: handleCodeChange,
          readOnly,
        })}
        {runsOpen && (
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
        )}
      </div>
      {showDialog && (
        <RunTriggerDialog
          parameters={params}
          isRunning={isRunning}
          initialValues={lastTriggerData}
          onRun={submitRun}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

function DefaultControls({
  run,
  running,
  runsOpen,
  toggleRuns,
}: WorkflowEditorControls) {
  return (
    <>
      <button
        type="button"
        className="catamorphic-editor-control"
        aria-pressed={runsOpen}
        onClick={toggleRuns}
      >
        Runs
      </button>
      {run && (
        <button
          type="button"
          className="catamorphic-editor-control catamorphic-editor-control-primary"
          onClick={run}
          disabled={running}
        >
          Run
        </button>
      )}
    </>
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
