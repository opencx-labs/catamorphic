"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { WorkflowGraph } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export interface UseWorkflowOptions {
  ref?: string;
}

export function useWorkflow(
  projectId: string | undefined,
  name: string | undefined,
  options: UseWorkflowOptions = {},
): UseQueryResult<WorkflowGraph, Error> {
  const { apiClient } = useCatamorphic();
  const { ref } = options;
  return useQuery<WorkflowGraph>({
    queryKey: ["cat", "project", projectId, "workflow", name, { ref }],
    queryFn: async () => {
      if (!projectId || !name) {
        throw new Error("projectId and name are required");
      }
      const { data, error } = await apiClient.GET(
        "/api/projects/{projectId}/workflows/{name}",
        {
          params: { path: { projectId, name }, query: { ref } },
        },
      );
      if (error) throw error;
      if (!data) throw new Error("Workflow response empty");
      return data;
    },
    enabled: Boolean(projectId && name),
  });
}
