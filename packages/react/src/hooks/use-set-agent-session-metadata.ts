"use client";

import type { JsonValue, SessionMetadata } from "@catamorphic/agent-protocol";
import { type UseMutationResult, useMutation } from "@tanstack/react-query";
import {
  type CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface SetAgentSessionMetadataInput {
  sessionId: string;
  /** Each key takes its value; null removes the key (ADR 0226). */
  metadata: Record<string, JsonValue | null>;
}

const isMetadata = (value: unknown): value is SessionMetadata =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Write a session's metadata as a person (ADR 0226): a JSON merge patch by
 * key. The change reaches every reader through the session's own event, so
 * nothing is invalidated here. A plain fetch: the client cannot infer a
 * body of recursive JSON.
 */
export function useSetAgentSessionMetadata(
  projectId: string | undefined,
): UseMutationResult<
  SessionMetadata,
  CatamorphicError,
  SetAgentSessionMetadataInput
> {
  const { apiClient } = useCatamorphic();
  return useMutation({
    mutationFn: ({ sessionId, metadata }) =>
      runWithCatamorphicError(async () => {
        const url = `${apiClient.baseUrl}/api/projects/${encodeURIComponent(projectId ?? "")}/agent/sessions/${encodeURIComponent(sessionId)}/metadata`;
        const response = await apiClient.fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadata }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok)
          throw toCatamorphicError({
            response,
            body,
            fallbackMessage: "Could not update this chat",
          });
        const written =
          isMetadata(body) && isMetadata(body.metadata) ? body.metadata : {};
        return written;
      }),
  });
}
