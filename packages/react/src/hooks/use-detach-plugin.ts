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

export interface DetachPluginInput {
  packageName: string;
}

/**
 * Detach a plugin from a project.
 */
export function useDetachPlugin(
  projectId: string | undefined,
): UseMutationResult<
  { detached: boolean },
  CatamorphicError,
  DetachPluginInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    { detached: boolean },
    CatamorphicError,
    DetachPluginInput
  >({
    mutationFn: ({ packageName }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.DELETE(
          "/api/projects/{projectId}/plugins/{packageName}",
          {
            params: {
              path: {
                projectId: projectId as string,
                packageName: encodeURIComponent(packageName),
              },
            },
          },
        );
        return assertApiOk(result, "Detach plugin failed");
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
