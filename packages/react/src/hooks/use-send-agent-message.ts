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

export interface AgentChatAttachment {
  kind: "image" | "document";
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface SendAgentMessageInput {
  sessionId: string;
  message: string;
  attachments?: AgentChatAttachment[];
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
      mutationFn: ({ sessionId, message, attachments }) =>
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
              body: {
                message,
                ...(attachments && attachments.length > 0
                  ? { attachments }
                  : {}),
              },
            },
          );
          return assertApiOk(result, "Send agent message failed");
        }),
      // Settled, not success: on failure the server has still persisted the
      // user message and a failed assistant message — without a refetch the
      // timeline would keep showing the stale in-progress placeholder.
      onSettled: (_data, _error, { sessionId }) => {
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
