"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { UpdatedProject } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export interface UpdateProjectInput {
  name?: string;
}

export function useUpdateProject(
  projectId: string,
): UseMutationResult<UpdatedProject, Error, UpdateProjectInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<UpdatedProject, Error, UpdateProjectInput>({
    mutationFn: async (input) => {
      const { data, error } = await apiClient.PATCH(
        "/api/projects/{projectId}",
        {
          params: { path: { projectId } },
          body: input,
        },
      );
      if (error) throw error;
      if (!data) throw new Error("Update project response empty");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
