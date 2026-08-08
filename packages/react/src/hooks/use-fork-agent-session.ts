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

export interface ForkAgentSessionInput {
  sessionId: string;
  /**
   * Fork point: the transcript is copied up to and including this
   * message. Omitted = the whole settled transcript.
   */
  messageId?: string;
}

/**
 * Fork a conversation: a new session on the same agent carrying a copy
 * of the transcript up to the fork point. The new session records its
 * parent (`parentSessionId`) and continues independently.
 */
export function useForkAgentSession(
  projectId: string | undefined,
): UseMutationResult<AgentSession, CatamorphicError, ForkAgentSessionInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<AgentSession, CatamorphicError, ForkAgentSessionInput>({
    mutationFn: ({ sessionId, messageId }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/fork",
          {
            params: {
              path: { projectId: projectId as string, sessionId },
            },
            body: messageId ? { messageId } : {},
          },
        );
        return assertApiOk(result, "Fork agent session failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}
