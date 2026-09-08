"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { randomId } from "../lib/random-id.js";
import { useCatamorphic } from "../provider.js";
import type { SessionDeliveryReceipt } from "../types.js";

export type AgentChatTextSource =
  | { type: "paste" }
  | {
      type: "selection";
      filePath: string;
      startLine?: number;
      endLine?: number;
    }
  | { type: "url"; url: string }
  | { type: "path"; path: string }
  | {
      /** An open workspace tab; `key` addresses it through workspace tools. */
      type: "tab";
      key: string;
      kind: string;
      title: string;
      url?: string;
      filePath?: string;
    };

// The marker helpers live beside the harness renderers in the sandbox
// package (browser-safe "./attachments" subpath, not the node-only root
// barrel) so pills mean the same thing on both sides of the wire.
export {
  ATTACHMENT_MARKER,
  messageWithAttachmentNames,
} from "@catamorphic/sandbox/attachments";

export interface AgentChatMediaAttachment {
  kind: "image" | "document";
  name: string;
  mediaType: string;
  dataBase64: string;
}

/** Text context (paste / editor selection / URL / path) beside a message. */
export interface AgentChatTextAttachment {
  kind: "text";
  name: string;
  text: string;
  source: AgentChatTextSource;
}

export type AgentChatAttachment =
  | AgentChatMediaAttachment
  | AgentChatTextAttachment;

export interface SendAgentMessageInput {
  sessionId: string;
  message: string;
  attachments?: AgentChatAttachment[];
  deliveryMode?: "next_turn" | "interrupt";
  idempotencyKey?: string;
}

/**
 * Send a user message to an agent session.
 */
export function useSendAgentMessage(
  projectId: string | undefined,
): UseMutationResult<
  SessionDeliveryReceipt,
  CatamorphicError,
  SendAgentMessageInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    SessionDeliveryReceipt,
    CatamorphicError,
    SendAgentMessageInput
  >({
    mutationFn: async ({
      sessionId,
      message,
      attachments,
      deliveryMode,
      idempotencyKey,
    }) => {
      const requestId = idempotencyKey ?? randomId();
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await runWithCatamorphicError(async () => {
            const result = await apiClient.POST(
              "/api/projects/{projectId}/agent/sessions/{sessionId}/messages",
              {
                signal: AbortSignal.timeout(15_000),
                params: {
                  path: {
                    projectId: projectId as string,
                    sessionId,
                  },
                },
                body: {
                  idempotencyKey: requestId,
                  message,
                  ...(attachments && attachments.length > 0
                    ? { attachments }
                    : {}),
                  ...(deliveryMode ? { deliveryMode } : {}),
                },
              },
            );
            return assertApiOk(result, "Send agent message failed");
          });
        } catch (error) {
          if (
            attempt >= 2 ||
            !(error instanceof CatamorphicError) ||
            (error.status !== undefined && error.status < 500)
          )
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
        }
      }
    },
    // Settled, not success: on failure the server has still persisted the
    // user message and a failed assistant message — without a refetch the
    // timeline would keep showing the stale in-progress placeholder.
    onSettled: (_data, _error, { sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", sessionId],
      });
    },
  });
}
