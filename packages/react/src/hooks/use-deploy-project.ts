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

export interface DeployProjectInput {
  message?: string;
  files?: Record<string, string>;
}

/**
 * Deploy the current workdir to the remote. Shares an endpoint with
 * `useCommitChanges` — the distinction is semantic: use `useDeployProject`
 * when you're shipping a release from the "latest committed" state, and
 * `useCommitChanges` when you're committing a set of drafts.
 */
export function useDeployProject(
  projectId: string,
): UseMutationResult<
  DeployResult,
  CatamorphicError,
  DeployProjectInput | void
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<DeployResult, CatamorphicError, DeployProjectInput | void>(
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
          return assertApiOk(result, "Deploy failed");
        }),
      onSuccess: (data) => {
        if (data.status === "deployed") {
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "git"],
          });
          queryClient.invalidateQueries({
            queryKey: ["cat", "project", projectId, "workflows"],
          });
        }
      },
    },
  );
}
