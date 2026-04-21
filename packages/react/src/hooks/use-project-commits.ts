"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { CommitsList } from "../types.js";

export interface UseProjectCommitsOptions {
  limit?: number;
}

export function useProjectCommits(
  projectId: string | undefined,
  options: UseProjectCommitsOptions = {},
): UseQueryResult<CommitsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { limit } = options;
  return useQuery<CommitsList, CatamorphicError>({
    queryKey: ["cat", "project", projectId, "git", "commits", { limit }],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/commits",
          { params: { path: { projectId }, query: { limit } } },
        );
        return assertApiOk(result, "Commits response empty");
      }),
    enabled: Boolean(projectId),
  });
}
