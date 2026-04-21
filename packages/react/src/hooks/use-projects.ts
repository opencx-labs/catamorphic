"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ProjectsList } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export interface UseProjectsOptions {
  limit?: number;
  offset?: number;
}

export function useProjects(
  options: UseProjectsOptions = {},
): UseQueryResult<ProjectsList, Error> {
  const { apiClient } = useCatamorphic();
  const { limit, offset } = options;
  return useQuery<ProjectsList>({
    queryKey: ["cat", "projects", { limit, offset }],
    queryFn: async () => {
      const { data, error } = await apiClient.GET("/api/projects", {
        params: { query: { limit, offset } },
      });
      if (error) throw error;
      if (!data) throw new Error("Projects response empty");
      return data;
    },
  });
}
