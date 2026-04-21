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
import type { Secret } from "../types.js";

export interface UpsertSecretInput {
  name: string;
  value: string;
}

/**
 * Set or replace a project secret value.
 */
export function useUpsertProjectSecret(
  projectId: string | undefined,
): UseMutationResult<Secret, CatamorphicError, UpsertSecretInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<Secret, CatamorphicError, UpsertSecretInput>({
    mutationFn: ({ name, value }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.PUT(
          "/api/projects/{projectId}/secrets/{name}",
          {
            params: {
              path: {
                projectId: projectId as string,
                name: encodeURIComponent(name),
              },
            },
            body: { value },
          },
        );
        return assertApiOk(result, "Upsert secret failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "secrets"],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "plugins"],
      });
    },
  });
}
