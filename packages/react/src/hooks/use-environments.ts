"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface EnvironmentList {
  items: Array<{
    name: string;
    label: string;
    description?: string;
    available: boolean;
    compatible: boolean;
    preferred: boolean;
    allowed: boolean;
    reasons: string[];
    binding?: {
      trust: "local" | "managed";
      isolation: "none" | "process" | "sandbox";
      capabilities: string[];
      resources: Record<string, number | boolean>;
    };
  }>;
  defaultEnvironment?: string;
}

export function useEnvironments(
  projectId: string | undefined,
  options: { workload: "agent" | "workflow"; agentId?: string },
): UseQueryResult<EnvironmentList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<EnvironmentList, CatamorphicError>({
    queryKey: [
      "cat",
      "project",
      projectId,
      "environments",
      options.workload,
      options.agentId,
    ],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId is required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/environments",
          {
            params: {
              path: { projectId },
              query: {
                workload: options.workload,
                ...(options.agentId ? { agentId: options.agentId } : {}),
              },
            },
          },
        );
        return assertApiOk(result, "Environment discovery failed");
      }),
    enabled: Boolean(projectId),
  });
}
