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
import type { TriggeredRun, TriggerRunInput } from "../types.js";

export function useTriggerWorkflowRun(
  projectId: string,
  name: string,
): UseMutationResult<
  TriggeredRun,
  CatamorphicError,
  TriggerRunInput | undefined
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    TriggeredRun,
    CatamorphicError,
    TriggerRunInput | undefined
  >({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/workflows/{name}/runs",
          {
            params: { path: { projectId, name } },
            body: input ?? {},
          },
        );
        return assertApiOk(result, "Trigger run failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "workflow", name, "runs"],
      });
    },
  });
}
