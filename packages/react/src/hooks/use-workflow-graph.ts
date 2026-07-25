import type { WorkflowEdge, WorkflowNode } from "@catamorphic/parser";
import {
  COLLAPSED_CONTAINER_HEIGHT,
  COLLAPSED_CONTAINER_WIDTH,
  layoutGraph,
} from "@catamorphic/parser/layout";
import type { Edge, Node } from "@xyflow/react";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  codeAtom,
  collapsedNodeIdsAtom,
  executionStateAtom,
  graphAtom,
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
} from "../atoms.js";
import type { WorkflowGraph } from "../lib/api-types.js";

export interface ParseResult {
  graph: WorkflowGraph;
  layoutedNodes: Array<
    WorkflowNode & {
      position: { x: number; y: number };
      width: number;
      height: number;
    }
  >;
  layoutedEdges: WorkflowEdge[];
}

export type OnParseCallback = (source: string) => Promise<ParseResult | null>;

function getDepth(nodeId: string, nodeMap: Map<string, WorkflowNode>): number {
  let depth = 0;
  let current = nodeMap.get(nodeId);
  while (current?.parentId) {
    depth++;
    current = nodeMap.get(current.parentId);
  }
  return depth;
}

export function useWorkflowGraph({ onParse }: { onParse?: OnParseCallback }) {
  const [code] = useAtom(codeAtom);
  const [graph, setGraph] = useAtom(graphAtom);
  const [, setNodes] = useAtom(reactFlowNodesAtom);
  const [, setEdges] = useAtom(reactFlowEdgesAtom);
  const executionState = useAtomValue(executionStateAtom);
  const collapsedNodeIds = useAtomValue(collapsedNodeIdsAtom);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyGraph = useCallback(
    (currentGraph: WorkflowGraph) => {
      const nodeMap = new Map(
        currentGraph.nodes.map((node) => [node.id, node]),
      );
      const hiddenNodeIds = new Set<string>();
      for (const node of currentGraph.nodes) {
        let parentId = node.parentId;
        while (parentId) {
          if (collapsedNodeIds.has(parentId)) {
            hiddenNodeIds.add(node.id);
            break;
          }
          parentId = nodeMap.get(parentId)?.parentId;
        }
      }
      const visibleNodes = currentGraph.nodes
        .filter((node) => !hiddenNodeIds.has(node.id))
        .map((node) =>
          collapsedNodeIds.has(node.id)
            ? {
                ...node,
                metadata: { ...node.metadata, collapsed: "true" },
              }
            : node,
        );
      const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
      const visibleEdges = currentGraph.edges.filter(
        (edge) =>
          visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
      );
      const layouted = layoutGraph({
        nodes: visibleNodes,
        edges: visibleEdges,
      });
      const childCounts = new Map<string, number>();
      for (const node of currentGraph.nodes) {
        if (node.parentId) {
          childCounts.set(
            node.parentId,
            (childCounts.get(node.parentId) ?? 0) + 1,
          );
        }
      }

      const rfNodes: Node[] = layouted.nodes.map((node) => {
        const depth = getDepth(node.id, nodeMap);
        const collapsed = collapsedNodeIds.has(node.id);
        return {
          id: node.id,
          type: node.type,
          position: node.position,
          draggable: false,
          connectable: false,
          deletable: false,
          data: {
            ...node,
            executionStatus: executionState[node.id],
            depth,
            collapsed,
            hasChildren: (childCounts.get(node.id) ?? 0) > 0,
          },
          style: {
            width: collapsed ? COLLAPSED_CONTAINER_WIDTH : node.width,
            height: collapsed ? COLLAPSED_CONTAINER_HEIGHT : node.height,
          },
          ...(node.parentId ? { parentId: node.parentId } : {}),
        };
      });

      const rfEdges: Edge[] = layouted.edges.map((edge) => {
        const strokeColor =
          edge.type === "branch-true"
            ? "#22c55e"
            : edge.type === "branch-false"
              ? "#ef4444"
              : edge.type === "parallel"
                ? "#3b82f6"
                : "#737373";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label,
          type: "default",
          animated: true,
          style: { stroke: strokeColor, strokeDasharray: "6 3" },
        };
      });

      setNodes(rfNodes);
      setEdges(rfEdges);
    },
    [collapsedNodeIds, executionState, setEdges, setNodes],
  );

  const buildGraph = useCallback(
    async (source: string) => {
      if (!source.trim()) {
        setGraph(null);
        setNodes([]);
        setEdges([]);
        return;
      }

      if (!onParse) return;

      try {
        const result = await onParse(source);
        if (!result) return;

        setGraph(result.graph);
      } catch {
        // parse errors are expected while editing
      }
    },
    [onParse, setEdges, setGraph, setNodes],
  );

  useEffect(() => {
    if (graph) applyGraph(graph);
  }, [graph, applyGraph]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      buildGraph(code);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [code, buildGraph]);

  return { buildGraph };
}
