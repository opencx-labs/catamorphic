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
import type { CreatedBranch } from "../types.js";

export interface CreateBranchInput {
  name?: string;
  fromRef?: string;
}

export function useCreateBranch(
  projectId: string,
): UseMutationResult<
  CreatedBranch,
  CatamorphicError,
  CreateBranchInput | undefined
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    CreatedBranch,
    CatamorphicError,
    CreateBranchInput | undefined
  >({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/branches",
          {
            params: { path: { projectId } },
            body: input ?? {},
          },
        );
        return assertApiOk(result, "Create branch failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "git"],
      });
    },
  });
}
