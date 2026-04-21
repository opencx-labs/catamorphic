"use client";

import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import type {
  ParseWorkflowRequest,
  ParseWorkflowResponse,
} from "../lib/api-types.js";
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
  Error,
  ParseWorkflowRequest
> {
  const { apiClient } = useCatamorphic();
  return useMutation<ParseWorkflowResponse, Error, ParseWorkflowRequest>({
    mutationFn: async (input) => {
      const { data, error } = await apiClient.POST("/api/playground/parse", {
        body: input,
      });
      if (error) throw error;
      // `data` is `WorkflowGraph | null` — null is a legitimate parse miss.
      return data ?? null;
    },
  });
}
