"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { DeletedProject } from "../lib/api-types.js";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export function useDeleteProject(): UseMutationResult<
  DeletedProject,
  CatamorphicError,
  string
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<DeletedProject, CatamorphicError, string>({
    mutationFn: (projectId) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.DELETE("/api/projects/{projectId}", {
          params: { path: { projectId } },
        });
        return assertApiOk(result, "Delete project response empty");
      }),
    onSuccess: (_data, projectId) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
