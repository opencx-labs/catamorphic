"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { ProjectFilesList } from "../lib/api-types.js";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export function useProjectFiles(
  projectId: string | undefined,
): UseQueryResult<ProjectFilesList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<ProjectFilesList, CatamorphicError>({
    queryKey: ["cat", "project", projectId, "files"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET("/api/projects/{projectId}/files", {
          params: { path: { projectId } },
        });
        return assertApiOk(result, "Files response empty");
      }),
    enabled: Boolean(projectId),
    // Files can change outside React Query through agents, terminals, git,
    // or another process. A newly mounted file surface must read the current
    // project instead of showing a recently cached directory snapshot.
    refetchOnMount: "always",
  });
}
