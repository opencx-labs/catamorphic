"use client";

import type { paths } from "@catamorphic/api-client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export type AgentSessionsList =
  paths["/api/projects/{projectId}/agent/sessions"]["get"]["responses"][200]["content"]["application/json"];

export interface UseAgentSessionsOptions {
  limit?: number;
  offset?: number;
  /** Polling cadence for sessions created by workflows or another client. */
  refetchInterval?: number | false;
}

/**
 * List agent (coding session) records for a project.
 */
export function useAgentSessions(
  projectId: string | undefined,
  options: UseAgentSessionsOptions = {},
): UseQueryResult<AgentSessionsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { limit, offset, refetchInterval = 2_000 } = options;
  return useQuery<AgentSessionsList, CatamorphicError>({
    queryKey: [
      "cat",
      "project",
      projectId,
      "agent",
      "sessions",
      { limit, offset },
    ],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/agent/sessions",
          {
            params: {
              path: { projectId: projectId as string },
              query: { limit, offset },
            },
          },
        );
        return assertApiOk(result, "Agent sessions response empty");
      }),
    enabled: Boolean(projectId),
    refetchInterval,
  });
}
