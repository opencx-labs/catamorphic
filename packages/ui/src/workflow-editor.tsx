import type { WorkflowNodeType } from "@catamorphic/parser";
import { ReactFlowProvider } from "@xyflow/react";
import { Provider, useAtom, useSetAtom } from "jotai";
import type { ComponentType, ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { AIBar } from "./ai-bar.js";
import {
  codeAtom,
  executionStateAtom,
  panelVisibilityAtom,
  rightPanelOpenAtom,
} from "./atoms.js";
import { WorkflowCanvas } from "./canvas.js";
import { type CodeEditorRenderProps, DetailPanel } from "./detail-panel.js";
import {
  type OnParseCallback,
  useWorkflowGraph,
} from "./hooks/use-workflow-graph.js";
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
  onRun?: () => void;
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
  aiEnabled = false,
  onAIPrompt,
  onExpandEditor,
}: WorkflowEditorProps) {
  const [currentCode, setCode] = useAtom(codeAtom);
  const setExecutionState = useSetAtom(executionStateAtom);
  const setPanelVisibility = useSetAtom(panelVisibilityAtom);
  const setRightPanelOpen = useSetAtom(rightPanelOpenAtom);

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

  const handleCodeChange = useCallback(
    (newCode: string) => {
      setCode(newCode);
      onCodeChange(newCode);
    },
    [setCode, onCodeChange],
  );

  return (
    <div className="catamorphic-editor">
      <Toolbar onRun={onRun} />
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
      </div>
      <AIBar enabled={aiEnabled} onAIPrompt={onAIPrompt} />
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
