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
import type { Run } from "../types.js";

export function useCancelWorkflowRun(
  projectId: string,
  name: string,
): UseMutationResult<Run, CatamorphicError, string> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<Run, CatamorphicError, string>({
    mutationFn: (runId) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST("/api/runs/{runId}/cancel", {
          params: { path: { runId } },
        });
        return assertApiOk(result, "Cancel run failed");
      }),
    onSuccess: (_data, runId) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "workflow", name, "runs"],
      });
      queryClient.invalidateQueries({ queryKey: ["cat", "run", runId] });
    },
  });
}
