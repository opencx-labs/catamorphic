"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ProjectsList } from "../lib/api-types.js";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface UseProjectsOptions {
  limit?: number;
  offset?: number;
}

export function useProjects(
  options: UseProjectsOptions = {},
): UseQueryResult<ProjectsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { limit, offset } = options;
  return useQuery<ProjectsList, CatamorphicError>({
    queryKey: ["cat", "projects", { limit, offset }],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET("/api/projects", {
          params: { query: { limit, offset } },
        });
        return assertApiOk(result, "Projects response empty");
      }),
  });
}
