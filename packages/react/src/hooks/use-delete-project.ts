"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { DeletedProject } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export function useDeleteProject(): UseMutationResult<
  DeletedProject,
  Error,
  string
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<DeletedProject, Error, string>({
    mutationFn: async (projectId) => {
      const { data, error } = await apiClient.DELETE(
        "/api/projects/{projectId}",
        { params: { path: { projectId } } },
      );
      if (error) throw error;
      if (!data) throw new Error("Delete project response empty");
      return data;
    },
    onSuccess: (_data, projectId) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
