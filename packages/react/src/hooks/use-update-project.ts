"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { UpdatedProject } from "../lib/api-types.js";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface UpdateProjectInput {
  name?: string;
}

export function useUpdateProject(
  projectId: string,
): UseMutationResult<UpdatedProject, CatamorphicError, UpdateProjectInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<UpdatedProject, CatamorphicError, UpdateProjectInput>({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.PATCH("/api/projects/{projectId}", {
          params: { path: { projectId } },
          body: input,
        });
        return assertApiOk(result, "Update project response empty");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
