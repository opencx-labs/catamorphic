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

export interface UseRetryFailedBatchItemsOptions {
  projectId: string;
  workflowName: string;
}

export interface RetryFailedBatchItemsInput {
  batchRunId: string;
}

export function useRetryFailedBatchItems({
  projectId,
  workflowName,
}: UseRetryFailedBatchItemsOptions): UseMutationResult<
  BatchRun,
  CatamorphicError,
  RetryFailedBatchItemsInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<BatchRun, CatamorphicError, RetryFailedBatchItemsInput>({
    mutationFn: ({ batchRunId }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/batch-runs/{batchRunId}/retry-failed",
          { params: { path: { batchRunId } } },
        );
        return assertApiOk(result, "Retry failed batch items failed");
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
      queryClient.invalidateQueries({
        queryKey: ["cat", "batch-run", batchRun.id, "items"],
      });
    },
  });
}
