"use client";

import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import type {
  ParseWorkflowRequest,
  ParseWorkflowResponse,
} from "../lib/api-types.js";
import {
  type CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export type { ParseWorkflowRequest, ParseWorkflowResponse };

/**
 * Mutation for live-parsing draft workflow code. The `@catamorphic/parser`
 * package depends on `ts-morph` (→ `node:fs`) and cannot run in a browser, so
 * the server exposes `POST /api/playground/parse` as a pure CPU wrapper over
 * the parser. Hosts that build their own WorkflowEditor-style UI use this
 * hook's `mutateAsync` as the `onParse` callback.
 */
export function useParseWorkflow(): UseMutationResult<
  ParseWorkflowResponse,
  CatamorphicError,
  ParseWorkflowRequest
> {
  const { apiClient } = useCatamorphic();
  return useMutation<
    ParseWorkflowResponse,
    CatamorphicError,
    ParseWorkflowRequest
  >({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const { data, error, response } = await apiClient.POST(
          "/api/playground/parse",
          { body: input },
        );
        if (error) {
          throw toCatamorphicError({
            response,
            body: error,
            fallbackMessage: "Parse request failed",
          });
        }
        // `data` is `WorkflowGraph | null` — null is a legitimate parse miss.
        return data ?? null;
      }),
  });
}
