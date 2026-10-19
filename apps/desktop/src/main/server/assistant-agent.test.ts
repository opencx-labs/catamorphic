import { describe, expect, it } from "vitest";
import {
  assistantAgentId,
  parseAssistantAgentId,
  rosterAgentId,
} from "../../shared/voice.js";
import {
  assistantDelegation,
  assistantHostTools,
  inThePersonsWindow,
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

  describe("its window tools", () => {
    /** Each tool reports the project it acted in, beside what it found. */
    const tool = (name: string, found: Record<string, unknown> = {}) => ({
      name,
      description: name,
      parameters: {},
      execute: async (
        input: Record<string, unknown>,
        context: { projectId: string },
      ) => ({ ...found, project: context.projectId, input }),
    });
    const windows = {
      personProject: () => "catamorphic",
      projectNamed: async (name: string) =>
        name.toLowerCase() === "opencx" ? "opencx" : null,
    };
    const home = { projectId: "home", sessionId: "assistant" };

    it("look where the person is, not where its chat lives", async () => {
      const [overview, read, todo] = inThePersonsWindow(
        [
          tool("workspace_overview"),
          tool("read_tab"),
          tool("update_todo_list"),
        ],
        windows,
      );
      expect(await overview?.execute({}, home)).toMatchObject({
        project: "catamorphic",
      });
      expect(await read?.execute({ key: "window" }, home)).toMatchObject({
        project: "catamorphic",
      });
      // Its own things stay with its chat.
      expect(await todo?.execute({}, home)).toMatchObject({ project: "home" });
    });

    it("look at another project's window by name, and act on what they saw there", async () => {
      const [overview, act] = inThePersonsWindow(
        [
          tool("workspace_overview", {
            tabs: [{ key: "browser:elsewhere-pr" }],
          }),
          tool("browser_act"),
        ],
        windows,
      );
      expect(overview?.parameters).toHaveProperty("project");
      expect(act?.parameters).not.toHaveProperty("project");
      expect(
        await overview?.execute({ project: "OpenCX" }, home),
      ).toMatchObject({ project: "opencx", input: {} });
      expect(
        await act?.execute({ key: "browser:elsewhere-pr" }, home),
      ).toMatchObject({ project: "opencx" });
      expect(
        await act?.execute({ key: "browser:on-screen" }, home),
      ).toMatchObject({ project: "catamorphic" });
      await expect(
        overview?.execute({ project: "Website" }, home),
      ).rejects.toThrow('No project named "Website"');
    });

    it("leave its own terminals with its chat", async () => {
      const [control] = inThePersonsWindow([tool("surface_control")], windows);
      expect(
        await control?.execute({ key: "terminal:mine", action: "close" }, home),
      ).toMatchObject({ project: "home" });
      expect(
        await control?.execute({ key: "browser:page", action: "close" }, home),
      ).toMatchObject({ project: "catamorphic" });
    });

    it("stay with its chat when no window shows the person's project", async () => {
      const [overview] = inThePersonsWindow([tool("workspace_overview")], {
        ...windows,
        personProject: () => null,
      });
      expect(await overview?.execute({}, home)).toMatchObject({
        project: "home",
      });
    });
  });
});
