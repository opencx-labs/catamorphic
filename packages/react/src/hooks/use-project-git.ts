"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { RepoStatus } from "../types.js";

export interface UseProjectGitOptions {
  /** Poll interval in ms. Pass `false` to disable polling. */
  refetchInterval?: number | false;
}

/**
 * Current repository status (branch, dirty, ahead/behind). Polls every 10s
 * by default so banners pick up remote changes without a manual refresh.
 */
export function useProjectGit(
  projectId: string | undefined,
  options: UseProjectGitOptions = {},
): UseQueryResult<RepoStatus, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { refetchInterval = 10_000 } = options;
  return useQuery<RepoStatus, CatamorphicError>({
    queryKey: ["cat", "project", projectId, "git", "status"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET("/api/projects/{projectId}/status", {
          params: { path: { projectId } },
        });
        return assertApiOk(result, "Status response empty");
      }),
    enabled: Boolean(projectId),
    refetchInterval,
  });
}
