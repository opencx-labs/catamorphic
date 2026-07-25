import type { paths } from "@catamorphic/api-client";
import type { WorkflowGraph as ParserWorkflowGraph } from "@catamorphic/parser";

/**
 * Direct aliases over the OpenAPI `paths` map. We index into the schema
 * explicitly rather than hiding it behind a generic helper so that TypeScript
 * declaration emit (`.d.ts`) preserves the real shapes across the package
 * boundary — generic conditional helpers collapse to `any`/`never` once
 * emitted.
 */

export type ProjectsList =
  paths["/api/projects"]["get"]["responses"][200]["content"]["application/json"];

export type Project =
  paths["/api/projects/{projectId}"]["get"]["responses"][200]["content"]["application/json"];

export type Template =
  paths["/api/templates"]["get"]["responses"][200]["content"]["application/json"][number];

export type WorkflowList =
  paths["/api/projects/{projectId}/workflows"]["get"]["responses"][200]["content"]["application/json"];

type WorkflowGraphResponse =
  paths["/api/projects/{projectId}/workflows/{name}"]["get"]["responses"][200]["content"]["application/json"];

/**
 * Browser-facing graph shape. Execution descriptors stay parser-internal and
 * are intentionally omitted from HTTP graph responses.
 */
export type WorkflowGraph = Omit<
  ParserWorkflowGraph,
  "capabilities" | "edges" | "execution" | "nodes"
> &
  Pick<WorkflowGraphResponse, "capabilities" | "edges" | "nodes"> & {
    allFiles?: Record<string, string>;
  };

/** Explicitly adapts the public HTTP graph to the renderable graph contract. */
export function adaptWorkflowGraph(graph: WorkflowGraph): WorkflowGraph {
  return graph;
}

export type ProjectFilesList =
  paths["/api/projects/{projectId}/files"]["get"]["responses"][200]["content"]["application/json"];

export type CreatedProject =
  paths["/api/projects"]["post"]["responses"][201]["content"]["application/json"];

export type UpdatedProject =
  paths["/api/projects/{projectId}"]["patch"]["responses"][200]["content"]["application/json"];

export type DeletedProject =
  paths["/api/projects/{projectId}"]["delete"]["responses"][200]["content"]["application/json"];

export type ParseWorkflowRequest =
  paths["/api/playground/parse"]["post"]["requestBody"]["content"]["application/json"];

export type ParseWorkflowResponse =
  paths["/api/playground/parse"]["post"]["responses"][200]["content"]["application/json"];
