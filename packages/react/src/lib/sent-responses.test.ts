import { sessionStateFromSnapshot } from "@catamorphic/agent-protocol";
import { expect, it } from "vitest";
import { question, snapshot } from "../test/session-fixtures.js";
import { withSentResponses } from "./sent-responses.js";

const sent = new Map([
  [
    "q1",
    {
      response: { kind: "question" as const, answers: ["Grid"] },
      sentAt: "2026-10-18T10:00:00.000Z",
    },
  ],
]);

it("reads a pending request as answered with the response sent to it", () => {
  const state = sessionStateFromSnapshot(
    snapshot({ requests: [question("q1"), question("q2")] }),
  );
  const shown = withSentResponses(state, sent);
  expect(shown.requests.q1).toMatchObject({
    status: "resolved",
    response: { kind: "question", answers: ["Grid"] },
    resolvedAt: "2026-10-18T10:00:00.000Z",
  });
  expect(shown.requests.q2).toBe(state.requests.q2);
  expect(state.requests.q1?.status).toBe("pending");
});

it("lets the session's own request win once it moved on", () => {
  const state = sessionStateFromSnapshot(
    snapshot({
      requests: [
        question("q1", {
          status: "resolved",
          response: { kind: "question", answers: ["List"] },
        }),
      ],
    }),
  );
  expect(withSentResponses(state, sent)).toBe(state);
  expect(withSentResponses(state, new Map())).toBe(state);
});
