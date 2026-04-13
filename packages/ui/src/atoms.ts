import type { WorkflowGraph, WorkflowNode } from "@catamorphic/parser";
import type { Edge, Node } from "@xyflow/react";
import { atom } from "jotai";
import type { PlaygroundRun } from "./run-types.js";

export const codeAtom = atom<string>("");

export const graphAtom = atom<WorkflowGraph | null>(null);

export const selectedNodeIdAtom = atom<string | null>(null);

export const selectedNodeAtom = atom<WorkflowNode | null>((get) => {
  const graph = get(graphAtom);
  const selectedId = get(selectedNodeIdAtom);
  if (!graph || !selectedId) return null;
  return graph.nodes.find((n) => n.id === selectedId) ?? null;
});

export const reactFlowNodesAtom = atom<Node[]>([]);
export const reactFlowEdgesAtom = atom<Edge[]>([]);

export const executionStateAtom = atom<Record<string, string>>({});

export type PanelTab = "details" | "code";

export type HistoryTab = "runs" | "versions";
export const historySidebarOpenAtom = atom<boolean>(false);
export const activeHistoryTabAtom = atom<HistoryTab>("runs");

export const rightPanelOpenAtom = atom<boolean>(false);
export const activePanelTabAtom = atom<PanelTab>("details");

export interface PanelVisibility {
  codeEditor: boolean;
  runsPanel: boolean;
  minimap: boolean;
}

export const panelVisibilityAtom = atom<PanelVisibility>({
  codeEditor: true,
  runsPanel: false,
  minimap: true,
});

export const aiLoadingAtom = atom<boolean>(false);

export const runsAtom = atom<PlaygroundRun[]>([]);
export const activeRunIdAtom = atom<string | null>(null);
export const isRunningAtom = atom<boolean>(false);
export const showRunDialogAtom = atom<boolean>(false);
export const lastTriggerDataAtom = atom<Record<string, unknown>>({});

export type LoadMoreRunsFn = (
  offset: number,
) => Promise<{ items: PlaygroundRun[]; hasMore: boolean }>;
export const loadMoreRunsAtom = atom<LoadMoreRunsFn | null>(null);
