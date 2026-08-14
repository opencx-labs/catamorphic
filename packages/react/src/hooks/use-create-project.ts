"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreatedProject } from "../lib/api-types.js";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface CreateProjectInput {
  name: string;
}

export function useCreateProject(): UseMutationResult<
  CreatedProject,
  CatamorphicError,
  CreateProjectInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<CreatedProject, CatamorphicError, CreateProjectInput>({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST("/api/projects", {
          body: input,
        });
        return assertApiOk(result, "Create project response empty");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
