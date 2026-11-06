import type {
  RuntimeRequestResponse,
  SessionState,
} from "@catamorphic/agent-protocol";

/** A response this client sent to a request, and when. */
export interface SentResponse {
  response: RuntimeRequestResponse;
  sentAt: string;
}

/**
 * The session as it reads with the responses this client sent and the
 * session does not show yet: each still-pending request reads as answered
 * with its response, so a question closes the moment it is answered and
 * the answer takes its place in the conversation, as a sent message shows
 * before the session has it. The session's own state wins once it moves.
 */
export function withSentResponses(
  state: SessionState,
  sent: ReadonlyMap<string, SentResponse>,
): SessionState {
  const answered = [...sent].flatMap(([id, answer]) => {
    const request = state.requests[id];
    return request?.status === "pending"
      ? [
          [
            id,
            {
              ...request,
              status: "resolved" as const,
              response: answer.response,
              resolvedAt: answer.sentAt,
            },
          ] as const,
        ]
      : [];
  });
  if (answered.length === 0) return state;
  return {
    ...state,
    requests: { ...state.requests, ...Object.fromEntries(answered) },
  };
}
