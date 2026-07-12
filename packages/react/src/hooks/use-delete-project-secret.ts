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

export interface DeleteSecretInput {
  name: string;
}

/**
 * Delete a project secret.
 */
export function useDeleteProjectSecret(
  projectId: string | undefined,
  environment: "test" | "production" = "production",
): UseMutationResult<
  { deleted: boolean },
  CatamorphicError,
  DeleteSecretInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<{ deleted: boolean }, CatamorphicError, DeleteSecretInput>(
    {
      mutationFn: ({ name }) =>
        runWithCatamorphicError(async () => {
          const result = await apiClient.DELETE(
            "/api/projects/{projectId}/secrets/{name}",
            {
              params: {
                path: {
                  projectId: projectId as string,
                  name: encodeURIComponent(name),
                },
                query: { environment },
              },
            },
          );
          return assertApiOk(result, "Delete secret failed");
        }),
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ["cat", "project", projectId, "secrets", environment],
        });
        queryClient.invalidateQueries({
          queryKey: ["cat", "project", projectId, "plugins"],
        });
      },
    },
  );
}
