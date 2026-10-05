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
import type { SecretValueChange } from "../types.js";

export interface SetMemberSecretInput {
  name: string;
  /** A member's external user id, or `me` for the caller's own value. */
  member: string;
  value: string;
}

export interface DeleteMemberSecretInput {
  name: string;
  /** A member's external user id, or `me` for the caller's own value. */
  member: string;
}

/**
 * Set or replace one member's own value of a project secret (ADR 0205):
 * the caller's own (`me`), or anyone's with `secrets:write`. The member's
 * own chats receive it instead of the shared value.
 */
export function useSetMemberSecret(
  projectId: string | undefined,
): UseMutationResult<
  SecretValueChange,
  CatamorphicError,
  SetMemberSecretInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<SecretValueChange, CatamorphicError, SetMemberSecretInput>(
    {
      mutationFn: ({ name, member, value }) =>
        runWithCatamorphicError(async () => {
          const result = await apiClient.PUT(
            "/api/projects/{projectId}/secrets/{name}/members/{member}",
            {
              params: {
                path: {
                  projectId: projectId as string,
                  name: encodeURIComponent(name),
                  member: encodeURIComponent(member),
                },
              },
              body: { value },
            },
          );
          return assertApiOk(result, "Set member secret failed");
        }),
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ["cat", "project", projectId, "secrets"],
        });
      },
    },
  );
}

/** Remove one member's own value of a project secret. */
export function useDeleteMemberSecret(
  projectId: string | undefined,
): UseMutationResult<
  { deleted: boolean },
  CatamorphicError,
  DeleteMemberSecretInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    { deleted: boolean },
    CatamorphicError,
    DeleteMemberSecretInput
  >({
    mutationFn: ({ name, member }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.DELETE(
          "/api/projects/{projectId}/secrets/{name}/members/{member}",
          {
            params: {
              path: {
                projectId: projectId as string,
                name: encodeURIComponent(name),
                member: encodeURIComponent(member),
              },
            },
          },
        );
        return assertApiOk(result, "Delete member secret failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "secrets"],
      });
    },
  });
}
