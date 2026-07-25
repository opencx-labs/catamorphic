"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { adaptWorkflowGraph, type WorkflowGraph } from "../lib/api-types.js";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import { workflowKeys } from "../workflow-keys.js";

export interface UseWorkflowOptions {
  ref?: string;
}

export function useWorkflow(
  projectId: string | undefined,
  name: string | undefined,
  options: UseWorkflowOptions = {},
): UseQueryResult<WorkflowGraph, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { ref } = options;
  return useQuery<WorkflowGraph, CatamorphicError>({
    queryKey: workflowKeys.detail({ projectId, name, ref }),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !name) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId and name are required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/workflows/{name}",
          {
            params: { path: { projectId, name }, query: { ref } },
          },
        );
        return adaptWorkflowGraph(
          assertApiOk(result, "Workflow response empty"),
        );
      }),
    enabled: Boolean(projectId && name),
  });
}
