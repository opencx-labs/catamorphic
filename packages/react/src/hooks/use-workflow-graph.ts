import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "@catamorphic/parser";
import type { Edge, Node } from "@xyflow/react";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import {
  codeAtom,
  executionStateAtom,
  graphAtom,
  reactFlowEdgesAtom,
  reactFlowNodesAtom,
} from "../atoms.js";

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
  const [, setGraph] = useAtom(graphAtom);
  const [, setNodes] = useAtom(reactFlowNodesAtom);
  const [, setEdges] = useAtom(reactFlowEdgesAtom);
  const executionState = useAtomValue(executionStateAtom);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

        const nodeMap = new Map(result.layoutedNodes.map((n) => [n.id, n]));

        const rfNodes: Node[] = result.layoutedNodes.map((n) => {
          const depth = getDepth(n.id, nodeMap);

          return {
            id: n.id,
            type: n.type,
            position: n.position,
            draggable: false,
            connectable: false,
            deletable: false,
            data: {
              ...n,
              executionStatus: executionState[n.id],
              depth,
            },
            style: { width: n.width, height: n.height },
            ...(n.parentId ? { parentId: n.parentId } : {}),
          };
        });

        const rfEdges: Edge[] = result.layoutedEdges.map((e) => {
          const strokeColor =
            e.type === "branch-true"
              ? "#22c55e"
              : e.type === "branch-false"
                ? "#ef4444"
                : e.type === "parallel"
                  ? "#3b82f6"
                  : "#737373";

          return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label,
            type: "default",
            animated: true,
            style: {
              stroke: strokeColor,
              strokeDasharray: "6 3",
            },
          };
        });

        setNodes(rfNodes);
        setEdges(rfEdges);
      } catch {
        // parse errors are expected while editing
      }
    },
    [setGraph, setNodes, setEdges, executionState, onParse],
  );

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
