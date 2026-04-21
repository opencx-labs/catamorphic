"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { BranchInfo } from "../types.js";

export function useProjectBranches(
  projectId: string | undefined,
): UseQueryResult<BranchInfo[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<BranchInfo[], CatamorphicError>({
    queryKey: ["cat", "project", projectId, "git", "branches"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/branches",
          { params: { path: { projectId } } },
        );
        return assertApiOk(result, "Branches response empty");
      }),
    enabled: Boolean(projectId),
  });
}
