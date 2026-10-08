import { expect, it } from "vitest";
import { switchContinuity } from "./agent-switch.js";

it("continues natively before a chat starts and on its own harness, from a summary on another", () => {
  expect(
    switchContinuity({ started: false, current: "claude-code", next: "codex" }),
  ).toBe("native");
  expect(
    switchContinuity({
      started: true,
      current: "claude-code",
      next: "claude-code",
    }),
  ).toBe("native");
  expect(
    switchContinuity({ started: true, current: "claude-code", next: "codex" }),
  ).toBe("summary");
  // A chat whose agent is gone has no harness to compare against.
  expect(
    switchContinuity({ started: true, current: undefined, next: "codex" }),
  ).toBe("native");
});
