import { expect, it } from "vitest";
import { startsNewChat } from "./agent-switch.js";

it("switches in place before a chat starts and on its harness, else starts a new chat", () => {
  expect(startsNewChat({ bound: null, next: "codex" })).toBe(false);
  expect(startsNewChat({ bound: "claude-code", next: "claude-code" })).toBe(
    false,
  );
  expect(startsNewChat({ bound: "claude-code", next: "codex" })).toBe(true);
});
