// Re-export atoms, hooks, run types from @catamorphic/react so existing
// consumers of @catamorphic/ui continue to work unchanged after the move.
export type {
  HistoryTab,
  LoadMoreRunsFn,
  OnParseCallback,
  PanelTab,
  ParseResult,
  PlaygroundRun,
  PlaygroundRunStep,
} from "@catamorphic/react";
export {
  activeHistoryTabAtom,
  activePanelTabAtom,
  activeRunIdAtom,
  aiLoadingAtom,
  codeAtom,
  codeEditorReadOnlyAtom,
  executionStateAtom,
  graphAtom,
  historySidebarOpenAtom,
  isRunningAtom,
  lastTriggerDataAtom,
  panelVisibilityAtom,
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
  rightPanelOpenAtom,
  runsAtom,
  selectedNodeAtom,
  selectedNodeIdAtom,
  showRunDialogAtom,
} from "@catamorphic/react";

export type { AIBarProps } from "./ai-bar.js";
export { AIBar } from "./ai-bar.js";
export { WorkflowCanvas } from "./canvas.js";
export type {
  CodeEditorRenderProps,
  DetailPanelProps,
} from "./detail-panel.js";
export { DetailPanel } from "./detail-panel.js";
export { HistorySidebar } from "./history-sidebar.js";
export { Toolbar } from "./toolbar.js";
export type { NodeRendererProps } from "./types.js";
export type { WorkflowEditorProps } from "./workflow-editor.js";
export { WorkflowEditor } from "./workflow-editor.js";
