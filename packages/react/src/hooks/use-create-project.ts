"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreatedProject } from "../lib/api-types.js";
import { useCatamorphic } from "../provider.js";

export interface CreateProjectInput {
  name: string;
  templateId?: string;
}

export function useCreateProject(): UseMutationResult<
  CreatedProject,
  Error,
  CreateProjectInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<CreatedProject, Error, CreateProjectInput>({
    mutationFn: async (input) => {
      const { data, error } = await apiClient.POST("/api/projects", {
        body: input,
      });
      if (error) throw error;
      if (!data) throw new Error("Create project response empty");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
