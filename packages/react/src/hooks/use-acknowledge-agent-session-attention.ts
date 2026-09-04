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

/** Mark a server-requested session notification seen by opening the chat. */
export function useAcknowledgeAgentSessionAttention(
  projectId: string | undefined,
): UseMutationResult<AgentSession, CatamorphicError, string> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<AgentSession, CatamorphicError, string>({
    mutationFn: (sessionId) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/attention/acknowledge",
          {
            params: {
              path: { projectId: projectId as string, sessionId },
            },
          },
        );
        return assertApiOk(result, "Acknowledge session attention failed");
      }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", session.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}
