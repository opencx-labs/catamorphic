"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { WorkflowList } from "../lib/api-types.js";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import { workflowKeys } from "../workflow-keys.js";

export interface UseWorkflowsOptions {
  ref?: string;
}

export function useWorkflows(
  projectId: string | undefined,
  options: UseWorkflowsOptions = {},
): UseQueryResult<WorkflowList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { ref } = options;
  return useQuery<WorkflowList, CatamorphicError>({
    queryKey: workflowKeys.list({ projectId, ref }),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/workflows",
          {
            params: { path: { projectId }, query: { ref } },
          },
        );
        return assertApiOk(result, "Workflows response empty");
      }),
    enabled: Boolean(projectId),
  });
}
