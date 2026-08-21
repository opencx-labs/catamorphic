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
import type { AgentSession } from "../types.js";

export interface UpdateAgentSessionInput {
  sessionId: string;
  /** Switch the session to another registered agent. */
  agentId?: string;
  /** Reasoning-effort override; `null` clears back to the agent's default. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
}

/**
 * Re-point a session at another agent and/or change its effort override.
 * Rejected with 409 while a turn is running — callers should surface that
 * rather than retry blindly.
 */
export function useUpdateAgentSession(
  projectId: string | undefined,
): UseMutationResult<AgentSession, CatamorphicError, UpdateAgentSessionInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<AgentSession, CatamorphicError, UpdateAgentSessionInput>({
    mutationFn: ({ sessionId, ...body }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.PATCH(
          "/api/projects/{projectId}/agent/sessions/{sessionId}",
          {
            params: {
              path: { projectId: projectId as string, sessionId },
            },
            body,
          },
        );
        return assertApiOk(result, "Update agent session failed");
      }),
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", sessionId],
      });
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}
