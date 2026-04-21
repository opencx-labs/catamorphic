"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { Project } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export function useProject(
  projectId: string | undefined,
): UseQueryResult<Project, Error> {
  const { apiClient } = useCatamorphic();
  return useQuery<Project>({
    queryKey: ["cat", "project", projectId],
    queryFn: async () => {
      if (!projectId) throw new Error("projectId is required");
      const { data, error } = await apiClient.GET("/api/projects/{projectId}", {
        params: { path: { projectId } },
      });
      if (error) throw error;
      if (!data) throw new Error("Project not found");
      return data;
    },
    enabled: Boolean(projectId),
  });
}
