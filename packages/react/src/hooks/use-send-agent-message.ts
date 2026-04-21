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
import type { SentAgentMessage } from "../types.js";

export interface SendAgentMessageInput {
  sessionId: string;
  message: string;
}

/**
 * Send a user message to an agent session.
 */
export function useSendAgentMessage(
  projectId: string | undefined,
): UseMutationResult<
  SentAgentMessage,
  CatamorphicError,
  SendAgentMessageInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<SentAgentMessage, CatamorphicError, SendAgentMessageInput>(
    {
      mutationFn: ({ sessionId, message }) =>
        runWithCatamorphicError(async () => {
          const result = await apiClient.POST(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/messages",
            {
              params: {
                path: {
                  projectId: projectId as string,
                  sessionId,
                },
              },
              body: { message },
            },
          );
          return assertApiOk(result, "Send agent message failed");
        }),
      onSuccess: (_data, { sessionId }) => {
        queryClient.invalidateQueries({
          queryKey: [
            "cat",
            "project",
            projectId,
            "agent",
            "session",
            sessionId,
          ],
        });
      },
    },
  );
}
