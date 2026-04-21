"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ProjectFilesList } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export function useProjectFiles(
  projectId: string | undefined,
): UseQueryResult<ProjectFilesList, Error> {
  const { apiClient } = useCatamorphic();
  return useQuery<ProjectFilesList>({
    queryKey: ["cat", "project", projectId, "files"],
    queryFn: async () => {
      if (!projectId) throw new Error("projectId is required");
      const { data, error } = await apiClient.GET(
        "/api/projects/{projectId}/files",
        { params: { path: { projectId } } },
      );
      if (error) throw error;
      if (!data) throw new Error("Files response empty");
      return data;
    },
    enabled: Boolean(projectId),
  });
}
