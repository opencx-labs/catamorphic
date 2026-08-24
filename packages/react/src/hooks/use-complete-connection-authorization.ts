"use client";

import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export function useCompleteConnectionAuthorization(): UseMutationResult<
  unknown,
  CatamorphicError,
  { authorizationId: string; callback: Record<string, string> }
> {
  const { apiClient } = useCatamorphic();
  return useMutation({
    mutationFn: ({ authorizationId, callback }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/connection-authorizations/complete",
          { body: { state: authorizationId, callback } },
        );
        return assertApiOk(result, "Authorization could not be completed");
      }),
  });
}
