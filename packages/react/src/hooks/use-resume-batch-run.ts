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

export interface UseResumeBatchRunOptions {
  projectId: string;
  workflowName: string;
}

export interface ResumeBatchRunInput {
  batchRunId: string;
}

export function useResumeBatchRun({
  projectId,
  workflowName,
}: UseResumeBatchRunOptions): UseMutationResult<
  BatchRun,
  CatamorphicError,
  ResumeBatchRunInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<BatchRun, CatamorphicError, ResumeBatchRunInput>({
    mutationFn: ({ batchRunId }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/batch-runs/{batchRunId}/resume",
          { params: { path: { batchRunId } } },
        );
        return assertApiOk(result, "Resume batch run failed");
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
