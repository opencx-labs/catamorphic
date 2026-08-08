// Dev-only harness: renders the marketing-site hero workflow through the real
// WorkflowCanvas so the site can screenshot the genuine product rendering.
// Open /hero-render.html while `bun run dev` is up.

import type { WorkflowEdge, WorkflowNode } from "@catamorphic/parser";
import { layoutGraph } from "@catamorphic/parser/layout";
import { reactFlowEdgesAtom, reactFlowNodesAtom } from "@catamorphic/react";
import { WorkflowCanvas, WorkflowEditorScope } from "@catamorphic/ui";
import type { Edge, Node } from "@xyflow/react";
import { useSetAtom } from "jotai";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import heroGraph from "./hero-graph.json";
import "@catamorphic/ui/styles.css";
import "./styles.css";

const graph = heroGraph as unknown as {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

function edgeColor(type: string | undefined): string {
  if (type === "branch-true") return "#22c55e";
  if (type === "branch-false") return "#ef4444";
  if (type === "parallel") return "#3b82f6";
  return "#737373";
}

function HeroGraph() {
  const setNodes = useSetAtom(reactFlowNodesAtom);
  const setEdges = useSetAtom(reactFlowEdgesAtom);

  useEffect(() => {
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const layouted = layoutGraph({ nodes: graph.nodes, edges: graph.edges });

    const rfNodes: Node[] = layouted.nodes.map((node) => {
      let depth = 0;
      let current = nodeMap.get(node.id);
      while (current?.parentId) {
        depth++;
        current = nodeMap.get(current.parentId);
      }
      return {
        id: node.id,
        type: node.type,
        position: node.position,
        draggable: false,
        connectable: false,
        deletable: false,
        data: { ...node, depth, collapsed: false, hasChildren: false },
        style: { width: node.width, height: node.height },
        ...(node.parentId ? { parentId: node.parentId } : {}),
      };
    });

    const rfEdges: Edge[] = layouted.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: "default",
      animated: true,
      style: { stroke: edgeColor(edge.type), strokeDasharray: "6 3" },
    }));

    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [setNodes, setEdges]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <WorkflowCanvas />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkflowEditorScope>
      <HeroGraph />
    </WorkflowEditorScope>
  </StrictMode>,
);
