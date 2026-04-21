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
import type { RepoStatus } from "../types.js";

export function useCheckoutBranch(
  projectId: string,
): UseMutationResult<RepoStatus, CatamorphicError, string> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<RepoStatus, CatamorphicError, string>({
    mutationFn: (ref) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/checkout",
          {
            params: { path: { projectId } },
            body: { ref },
          },
        );
        return assertApiOk(result, "Checkout failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "git"],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "files"],
      });
    },
  });
}
