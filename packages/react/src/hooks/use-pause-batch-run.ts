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
import type { BatchRun } from "../types.js";

export interface UsePauseBatchRunOptions {
  projectId: string;
  workflowName: string;
}

export interface PauseBatchRunInput {
  batchRunId: string;
}

export function usePauseBatchRun({
  projectId,
  workflowName,
}: UsePauseBatchRunOptions): UseMutationResult<
  BatchRun,
  CatamorphicError,
  PauseBatchRunInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<BatchRun, CatamorphicError, PauseBatchRunInput>({
    mutationFn: ({ batchRunId }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/batch-runs/{batchRunId}/pause",
          { params: { path: { batchRunId } } },
        );
        return assertApiOk(result, "Pause batch run failed");
      }),
    onSuccess: (batchRun) => {
      queryClient.setQueryData(["cat", "batch-run", batchRun.id], batchRun);
      queryClient.invalidateQueries({
        queryKey: [
          "cat",
          "project",
          projectId,
          "workflow",
          workflowName,
          "batch-runs",
        ],
      });
    },
  });
}
