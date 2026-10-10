import { describe, expect, it } from "vitest";
import {
  assistantAgentId,
  parseAssistantAgentId,
  rosterAgentId,
} from "../../shared/voice.js";
import {
  assistantDelegation,
  assistantHostTools,
  withoutReplacedTools,
} from "./assistant-agent.js";

describe("the assistant", () => {
  it("is addressed as a variant of one of the person's agents", () => {
    expect(assistantAgentId({ agentId: "a1", builtIn: false })).toBe(
      "assistant:a1",
    );
    expect(assistantAgentId({ agentId: "a1", builtIn: true })).toBe(
      "work-assistant:a1",
    );
    expect(parseAssistantAgentId("assistant:a1")).toEqual({
      agentId: "a1",
      builtIn: false,
    });
    expect(parseAssistantAgentId("work-assistant:a1")).toEqual({
      agentId: "a1",
      builtIn: true,
    });
    expect(parseAssistantAgentId("a1")).toBeNull();
    expect(parseAssistantAgentId("assistant:")).toBeNull();
    expect(rosterAgentId("work-assistant:a1")).toBe("a1");
    expect(rosterAgentId("project:p:s")).toBe("project:p:s");
  });

  it("starts its sessions on the base agent, or on one the person names", () => {
    expect(assistantDelegation("a1").routes).toEqual([
      expect.objectContaining({ id: "work", target: "a1" }),
      expect.objectContaining({ id: "named", target: "*" }),
    ]);
  });

  it("discovers none of the session tools it replaces", () => {
    expect(
      withoutReplacedTools([
        { name: "list_project_sessions" },
        { name: "read_project_session" },
        { name: "send_project_session_message" },
        { name: "interrupt_subsession" },
        { name: "type_in_terminal" },
      ]).map((tool) => tool.name),
    ).toEqual(["type_in_terminal"]);
  });

  it("keeps the base agent's tools, with its own session tools in place of Work's", () => {
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: {},
      execute: async () => null,
    });
    expect(
      assistantHostTools(
        [
          tool("open_surface"),
          tool("spawn_subsession"),
          tool("read_project_session"),
        ],
        [tool("start_session")],
      ).map((each) => each.name),
    ).toEqual(["open_surface", "start_session"]);
  });
});
