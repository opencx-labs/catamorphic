"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { WorkflowList } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export interface UseWorkflowsOptions {
  ref?: string;
}

export function useWorkflows(
  projectId: string | undefined,
  options: UseWorkflowsOptions = {},
): UseQueryResult<WorkflowList, Error> {
  const { apiClient } = useCatamorphic();
  const { ref } = options;
  return useQuery<WorkflowList>({
    queryKey: ["cat", "project", projectId, "workflows", { ref }],
    queryFn: async () => {
      if (!projectId) throw new Error("projectId is required");
      const { data, error } = await apiClient.GET(
        "/api/projects/{projectId}/workflows",
        {
          params: { path: { projectId }, query: { ref } },
        },
      );
      if (error) throw error;
      if (!data) throw new Error("Workflows response empty");
      return data;
    },
    enabled: Boolean(projectId),
  });
}
