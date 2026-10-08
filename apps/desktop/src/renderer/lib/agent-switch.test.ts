import { describe, expect, it } from "vitest";
import {
  agentSwitchNone,
  canSwitchAgent,
  switchableAgents,
} from "./agent-switch.js";

const agents = [
  { id: "claude", harness: "claude-code" as const },
  { id: "claude-work", harness: "claude-code" as const },
  { id: "codex", harness: "codex" as const },
  { id: "builtin", harness: "ai-sdk" as const },
];

describe("agent switching", () => {
  it("lets a chat that has not started take any agent", () => {
    expect(
      switchableAgents({ agents, currentId: "claude", started: false }).map(
        (agent) => agent.id,
      ),
    ).toEqual(["claude-work", "codex", "builtin"]);
  });

  it("keeps a started chat on its harness", () => {
    expect(
      switchableAgents({ agents, currentId: "claude", started: true }).map(
        (agent) => agent.id,
      ),
    ).toEqual(["claude-work"]);
    expect(
      canSwitchAgent({ started: true, current: "claude-code", next: "codex" }),
    ).toBe(false);
    expect(
      canSwitchAgent({
        started: true,
        current: "claude-code",
        next: "claude-code",
      }),
    ).toBe(true);
    expect(agentSwitchNone("codex")).toBe(
      "This chat runs on Codex, and no other agent does. Start a new chat to use another agent.",
    );
  });

  it("does not lock a chat whose agent is gone", () => {
    expect(
      switchableAgents({ agents, currentId: "deleted", started: true }).map(
        (agent) => agent.id,
      ),
    ).toEqual(["claude", "claude-work", "codex", "builtin"]);
  });
});
