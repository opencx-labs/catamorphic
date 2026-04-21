"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { WorkflowGraph } from "../lib/api-types.js";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

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
    queryKey: ["cat", "project", projectId, "workflow", name, { ref }],
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
        return assertApiOk(result, "Workflow response empty");
      }),
    enabled: Boolean(projectId && name),
  });
}
