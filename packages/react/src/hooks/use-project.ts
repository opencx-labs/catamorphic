"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { Project } from "../lib/api-types.js";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export function useProject(
  projectId: string | undefined,
): UseQueryResult<Project, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<Project, CatamorphicError>({
    queryKey: ["cat", "project", projectId],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET("/api/projects/{projectId}", {
          params: { path: { projectId } },
        });
        return assertApiOk(result, "Project not found");
      }),
    enabled: Boolean(projectId),
  });
}
