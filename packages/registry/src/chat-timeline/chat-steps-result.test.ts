import type { WorkItem } from "@catamorphic/react";
import { expect, it } from "vitest";
import { turnStepsOf } from "./chat-steps.js";
import { toolCall } from "./timeline-fixtures.js";

const submitted = (id: string, overrides: Partial<WorkItem> = {}) =>
  toolCall(id, "turn-1", {
    tool: "mcp__work__submit_result",
    server: "work",
    input: { name: "review", value: { verdict: "COMMENT" } },
    status: "completed",
    ...overrides,
  } as Partial<Extract<WorkItem, { kind: "tool_call" }>>) as WorkItem;

it("shows an accepted result as one row, and a refused submission as a tool step", () => {
  const call = submitted("call-1");
  const result: WorkItem = {
    ...call,
    id: "result-1",
    kind: "result",
    name: "review",
    value: { verdict: "COMMENT", score: 4 },
    input: { itemId: "input-1", position: 1 },
    commit: null,
  };
  const refused = submitted("call-0", {
    status: "failed",
  });
  const steps = turnStepsOf(
    [refused, call, result].map((item) => ({ kind: "work", item })),
    { requests: {} },
  );
  expect(steps.map((step) => [step.kind, step.label])).toEqual([
    ["tool", "Submitted a result"],
    ["result", "Submitted the review result"],
  ]);
  expect(steps[1]?.detail).toContain('"score": 4');
});
