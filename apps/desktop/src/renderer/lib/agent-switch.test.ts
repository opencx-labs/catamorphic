import { expect, it } from "vitest";
import { agentHarnessId, startsNewChat } from "./agent-switch.js";
import { type ProjectAgentInfo, projectAgentAsInfo } from "./desktop-api.js";

it("switches in place before a chat starts and on its harness, else starts a new chat", () => {
  expect(startsNewChat({ bound: null, next: "codex" })).toBe(false);
  expect(startsNewChat({ bound: "claude-code", next: "claude-code" })).toBe(
    false,
  );
  expect(startsNewChat({ bound: "claude-code", next: "codex" })).toBe(true);
});

it("binds a chat on an ACP agent to that agent alone, as the registry names it (ADR 0241)", () => {
  expect(agentHarnessId({ id: "claude", harness: "claude-code" })).toBe(
    "claude-code",
  );
  expect(agentHarnessId({ id: "hermes-id", harness: "acp" })).toBe(
    "acp:hermes-id",
  );
  const echoer = { id: "project:p1:echoer", harness: "acp" };
  expect(agentHarnessId(echoer)).toBe("acp:project:p1:echoer");
  // Two ACP agents never continue each other's chats.
  expect(
    startsNewChat({ bound: "acp:hermes-id", next: agentHarnessId(echoer) }),
  ).toBe(true);
});
