"use server";

import { layoutGraph, parseWorkflow } from "@catamorphic/parser";
import type { ParseResult } from "@catamorphic/ui";

export async function parseWorkflowAction(
  source: string,
): Promise<ParseResult | null> {
  try {
    const graph = parseWorkflow(source);
    const layouted = layoutGraph({
      nodes: graph.nodes,
      edges: graph.edges,
    });
    return {
      graph,
      layoutedNodes: layouted.nodes,
      layoutedEdges: layouted.edges,
    };
  } catch {
    return null;
  }
}
