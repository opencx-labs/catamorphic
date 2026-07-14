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
import type { TriggerBatchRunInput, TriggeredBatchRun } from "../types.js";

export interface UseTriggerBatchRunOptions {
  projectId: string;
  workflowName: string;
}

export function useTriggerBatchRun({
  projectId,
  workflowName,
}: UseTriggerBatchRunOptions): UseMutationResult<
  TriggeredBatchRun,
  CatamorphicError,
  TriggerBatchRunInput | undefined
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();

  return useMutation<
    TriggeredBatchRun,
    CatamorphicError,
    TriggerBatchRunInput | undefined
  >({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/workflows/{name}/batch-runs",
          {
            params: { path: { projectId, name: workflowName } },
            body: input ?? {},
          },
        );
        return assertApiOk(result, "Trigger batch run failed");
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
