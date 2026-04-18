import {
  applyNodeChanges,
  Background,
  Controls,
  type CoordinateExtent,
  MiniMap,
  type NodeMouseHandler,
  type OnNodesChange,
  type OnSelectionChangeFunc,
  ReactFlow,
} from "@xyflow/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";
import {
  activePanelTabAtom,
  panelVisibilityAtom,
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
  rightPanelOpenAtom,
  selectedNodeIdAtom,
} from "./atoms.js";
import { nodeTypes } from "./nodes/index.js";

function computeTranslateExtent(
  nodes: {
    position: { x: number; y: number };
    measured?: { width?: number; height?: number };
    width?: number;
    height?: number;
    parentId?: string;
  }[],
): CoordinateExtent | undefined {
  if (nodes.length === 0) return undefined;

  const rootNodes = nodes.filter((n) => !n.parentId);
  if (rootNodes.length === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of rootNodes) {
    const w = node.measured?.width ?? node.width ?? 200;
    const h = node.measured?.height ?? node.height ?? 60;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + w);
    maxY = Math.max(maxY, node.position.y + h);
  }

  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const padX = Math.max(2000, bboxW * 1.5);
  const padY = Math.max(2000, bboxH * 1.5);

  return [
    [minX - padX, minY - padY],
    [maxX + padX, maxY + padY],
  ];
}

const MINIMAP_NODE_COLORS: Record<string, string> = {
  trigger: "#ca8a04",
  step: "#2563eb",
  branch: "#a855f7",
  "if-block": "transparent",
  "loop-block": "#f97316",
  parallel: "#06b6d4",
  "parallel-block": "#06b6d4",
  "scope-block": "#94a3b8",
  delay: "#737373",
  return: "#22c55e",
};

function minimapNodeColor(node: { type?: string }): string {
  return MINIMAP_NODE_COLORS[node.type ?? ""] ?? "#525252";
}

export function WorkflowCanvas() {
  const [nodes, setNodes] = useAtom(reactFlowNodesAtom);
  const edges = useAtomValue(reactFlowEdgesAtom);
  const selectedNodeId = useAtomValue(selectedNodeIdAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
  const panelVisibility = useAtomValue(panelVisibilityAtom);
  const [isOpen, setRightPanelOpen] = useAtom(rightPanelOpenAtom);
  const setActiveTab = useSetAtom(activePanelTabAtom);

  useEffect(() => {
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const shouldSelect = n.id === selectedNodeId;
        if (n.selected !== shouldSelect) {
          changed = true;
          return { ...n, selected: shouldSelect };
        }
        return n;
      });
      return changed ? next : prev;
    });
  }, [selectedNodeId, setNodes]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const filtered = changes.filter((c) => c.type !== "position");
      if (filtered.length > 0) {
        setNodes((prev) => applyNodeChanges(filtered, prev));
      }
    },
    [setNodes],
  );

  const translateExtent = useMemo(() => computeTranslateExtent(nodes), [nodes]);

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      const first = selectedNodes[0];
      setSelectedNodeId(first?.id ?? null);
    },
    [setSelectedNodeId],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      setSelectedNodeId(node.id);
      if (!isOpen) {
        setRightPanelOpen(true);
        setActiveTab("details");
      }
    },
    [setSelectedNodeId, setRightPanelOpen, setActiveTab, isOpen],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        translateExtent={translateExtent}
        minZoom={0.1}
        maxZoom={2}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={true}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panActivationKeyCode={null}
        zoomActivationKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        {panelVisibility.minimap && (
          <MiniMap
            nodeColor={minimapNodeColor}
            maskColor="rgba(0, 0, 0, 0.6)"
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
}
