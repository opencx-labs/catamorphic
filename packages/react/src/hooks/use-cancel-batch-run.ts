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

export interface UseCancelBatchRunOptions {
  projectId: string;
  workflowName: string;
}

export interface CancelBatchRunInput {
  batchRunId: string;
}

export function useCancelBatchRun({
  projectId,
  workflowName,
}: UseCancelBatchRunOptions): UseMutationResult<
  BatchRun,
  CatamorphicError,
  CancelBatchRunInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<BatchRun, CatamorphicError, CancelBatchRunInput>({
    mutationFn: ({ batchRunId }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/batch-runs/{batchRunId}/cancel",
          {
            params: { path: { batchRunId } },
          },
        );
        return assertApiOk(result, "Cancel batch run failed");
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
