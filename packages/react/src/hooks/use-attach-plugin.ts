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
import type { AttachedPlugin } from "../types.js";

export interface AttachPluginInput {
  packageName: string;
}

/**
 * Attach a plugin to a project. Invalidates the project's plugin list +
 * secrets (because plugin descriptors may declare new required secrets).
 */
export function useAttachPlugin(
  projectId: string | undefined,
): UseMutationResult<AttachedPlugin, CatamorphicError, AttachPluginInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<AttachedPlugin, CatamorphicError, AttachPluginInput>({
    mutationFn: ({ packageName }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/plugins",
          {
            params: { path: { projectId: projectId as string } },
            body: { packageName },
          },
        );
        return assertApiOk(result, "Attach plugin failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "plugins"],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "secrets"],
      });
    },
  });
}
