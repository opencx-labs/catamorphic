import type { ParameterInfo, WorkflowNodeType } from "@catamorphic/parser";
import {
  codeAtom,
  codeEditorReadOnlyAtom,
  executionStateAtom,
  graphAtom,
  historySidebarOpenAtom,
  type LoadMoreRunsFn,
  lastTriggerDataAtom,
  loadMoreRunsAtom,
  type OnParseCallback,
  type PlaygroundRun,
  type PlaygroundRunStep,
  panelVisibilityAtom,
  rightPanelOpenAtom,
  runsAtom,
  showRunDialogAtom,
  useEditorKeyboard,
  useWorkflowGraph,
  useWorkflowRunController,
} from "@catamorphic/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { ComponentType, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { AIBar } from "./ai-bar.js";
import { WorkflowCanvas } from "./canvas.js";
import { type CodeEditorRenderProps, DetailPanel } from "./detail-panel.js";
import { HistorySidebar } from "./history-sidebar.js";
import { RunTriggerDialog } from "./run-trigger-dialog.js";
import { Toolbar } from "./toolbar.js";
import type { NodeRendererProps } from "./types.js";
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
  renderVersionsPanel?: () => ReactNode;
  renderBanner?: () => ReactNode;
  renderToolbarCenter?: () => ReactNode;
  /** When true, disables the code editor. */
  readOnly?: boolean;
  /**
   * Opaque token that, when its value changes to a truthy value, opens the
   * Run dialog. Intended for external triggers (e.g. a gutter "Run" glyph in
   * a code editor host that doesn't have direct access to this component's
   * internal Jotai store). Use `Date.now()` or a monotonic counter.
   *
   * @deprecated Prefer wrapping your chrome in `<WorkflowEditorScope>` and
   * calling `useSetAtom(showRunDialogAtom)(true)` directly, or consume the
   * `openDialog` callback returned by `useWorkflowRunController`. The token
   * channel exists only because the legacy editor scoped its jotai store
   * internally and hosts had no other way to drive it.
   */
  runDialogRequestKey?: number | null;
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
  renderVersionsPanel,
  renderBanner,
  renderToolbarCenter,
  readOnly = false,
  runDialogRequestKey,
}: WorkflowEditorProps) {
  const [currentCode, setCode] = useAtom(codeAtom);
  const setExecutionState = useSetAtom(executionStateAtom);
  const setPanelVisibility = useSetAtom(panelVisibilityAtom);
  const setRightPanelOpen = useSetAtom(rightPanelOpenAtom);
  const graph = useAtomValue(graphAtom);
  const setShowDialog = useSetAtom(showRunDialogAtom);
  const setRuns = useSetAtom(runsAtom);
  const lastTriggerData = useAtomValue(lastTriggerDataAtom);
  const setLoadMoreRuns = useSetAtom(loadMoreRunsAtom);
  const setReadOnly = useSetAtom(codeEditorReadOnlyAtom);

  const {
    isRunning,
    showDialog,
    openDialog,
    closeDialog,
    submit: submitRun,
  } = useWorkflowRunController({ onTriggerRun: onRun });

  useEffect(() => {
    setReadOnly(readOnly);
  }, [readOnly, setReadOnly]);

  useEffect(() => {
    if (!runDialogRequestKey || !onRun) return;
    setShowDialog(true);
  }, [runDialogRequestKey, onRun, setShowDialog]);

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

  useEffect(() => {
    if (initialRuns && initialRuns.length > 0) {
      setRuns(initialRuns);
    }
  }, [initialRuns, setRuns]);

  useEffect(() => {
    setLoadMoreRuns(onLoadMoreRuns ?? null);
  }, [onLoadMoreRuns, setLoadMoreRuns]);

  const handleCodeChange = useCallback(
    (newCode: string) => {
      setCode(newCode);
      onCodeChange(newCode);
    },
    [setCode, onCodeChange],
  );

  const handleRunClick = useCallback(() => {
    if (!onRun) return;
    openDialog();
  }, [onRun, openDialog]);

  const params = triggerParameters ?? graph?.trigger.parameters ?? [];

  return (
    <div className="catamorphic-editor">
      <Toolbar
        onRun={onRun ? handleRunClick : undefined}
        isRunning={isRunning}
        centerSlot={renderToolbarCenter?.()}
      />
      {renderBanner?.()}
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
        <HistorySidebarSlot renderVersionsPanel={renderVersionsPanel} />
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
          isRunning={isRunning}
          initialValues={lastTriggerData}
          onRun={submitRun}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

function HistorySidebarSlot({
  renderVersionsPanel,
}: {
  renderVersionsPanel?: () => ReactNode;
}) {
  const historySidebarOpen = useAtomValue(historySidebarOpenAtom);
  if (!historySidebarOpen) return null;
  return <HistorySidebar renderVersionsPanel={renderVersionsPanel} />;
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
