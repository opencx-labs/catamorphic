"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { DeployResult } from "../types.js";

export interface CommitChangesInput {
  message?: string;
  /**
   * Optional explicit draft files to commit. When omitted, the server
   * commits whatever is currently dirty in the workdir.
   */
  files?: Record<string, string>;
}

/**
 * Commit any pending changes and push to the remote. Thin wrapper over
 * `POST /api/projects/{projectId}/deploy` — on `deployed` the hook
 * invalidates git-state + workflow queries; on `conflict` the caller
 * forwards the returned `conflicts` to the conflict resolver UI.
 */
export function useCommitChanges(
  projectId: string,
): UseMutationResult<
  DeployResult,
  CatamorphicError,
  CommitChangesInput | void
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<DeployResult, CatamorphicError, CommitChangesInput | void>(
    {
      mutationFn: (input) =>
        runWithCatamorphicError(async () => {
          const result = await apiClient.POST(
            "/api/projects/{projectId}/deploy",
            {
              params: { path: { projectId } },
              body: input ?? {},
            },
          );
          return assertApiOk(result, "Commit/deploy failed");
        }),
      onSuccess: (data) => {
        if (data.status === "deployed") {
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "git"],
          });
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "files"],
          });
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "workflows"],
          });
        }
      },
    },
  );
}
