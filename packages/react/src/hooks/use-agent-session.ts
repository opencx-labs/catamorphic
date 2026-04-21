"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { AgentSessionDetail } from "../types.js";

/**
 * Single agent session detail (with messages).
 */
export function useAgentSession(
  projectId: string | undefined,
  sessionId: string | undefined,
): UseQueryResult<AgentSessionDetail, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<AgentSessionDetail, CatamorphicError>({
    queryKey: ["cat", "project", projectId, "agent", "session", sessionId],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/agent/sessions/{sessionId}",
          {
            params: {
              path: {
                projectId: projectId as string,
                sessionId: sessionId as string,
              },
            },
          },
        );
        return assertApiOk(result, "Agent session response empty");
      }),
    enabled: Boolean(projectId && sessionId),
  });
}
