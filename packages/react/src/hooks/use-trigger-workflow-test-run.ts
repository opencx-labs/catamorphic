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
import type { TriggeredTestRun, TriggerTestRunInput } from "../types.js";

export function useTriggerWorkflowTestRun(
  projectId: string,
  name: string,
): UseMutationResult<
  TriggeredTestRun,
  CatamorphicError,
  TriggerTestRunInput | undefined
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/workflows/{name}/test-runs",
          {
            params: { path: { projectId, name } },
            body: input ?? {},
          },
        );
        return assertApiOk(result, "Trigger test run failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "workflow", name, "runs"],
      });
    },
  });
}
