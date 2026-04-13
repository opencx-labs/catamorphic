"use server";

import type { DiscoveredWorkflow, ParseError } from "@catamorphic/parser";
import {
  layoutGraph,
  parseProject,
  parseWorkflow,
  parseWorkflowFromProject,
} from "@catamorphic/parser";
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

export async function parseWorkflowFromProjectAction({
  files,
  workflowName,
}: {
  files: Record<string, string>;
  workflowName: string;
}): Promise<ParseResult | null> {
  try {
    const graph = parseWorkflowFromProject(files, workflowName);
    if (!graph) return null;
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

export interface DiscoverWorkflowsResult {
  workflows: DiscoveredWorkflow[];
  errors: ParseError[];
}

export async function discoverWorkflowsAction({
  files,
}: {
  files: Record<string, string>;
}): Promise<DiscoverWorkflowsResult> {
  try {
    const result = parseProject(files);
    return {
      workflows: result.workflows,
      errors: result.errors,
    };
  } catch {
    return { workflows: [], errors: [] };
  }
}
