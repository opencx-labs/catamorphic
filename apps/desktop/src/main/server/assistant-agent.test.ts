import type { ExtraTool } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assistantAgentId,
  parseAssistantAgentId,
  rosterAgentId,
} from "../../shared/voice.js";
import {
  assistantDelegation,
  assistantHostTools,
  assistantSubsession,
  assistantWorkspaceTools,
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

  it("starts sessions on its base agent, or one the person names, on any model, and no copy of itself", () => {
    expect(assistantDelegation("a1").agents).toEqual([
      { agent: "a1", model: "any", effort: "any", delegate: true },
      { agent: "*", model: "any", effort: "any", delegate: true },
    ]);
  });

  it("hands its sessions a brief that leads back to it, under a title", () => {
    const child = assistantSubsession({
      assistantSessionId: "assistant-chat",
      task: "Tidy the docs folder",
      title: "Tidy the docs",
    });
    expect(child.title).toBe("Tidy the docs");
    // The relay, where to read what was said, and how to reach the person.
    expect(child.task).toContain("Tidy the docs folder");
    expect(child.task).toContain("read_project_session");
    expect(child.task).toContain(
      "send_project_session_message (session_id assistant-chat, delivery_mode steer)",
    );
    expect(child.task).toContain('"Tidy the docs:"');
    // Untitled, it is named by its task's first words.
    const untitled = assistantSubsession({
      assistantSessionId: "assistant-chat",
      task: "Find out why the nightly deploy failed and   fix it if it is ours to fix",
    });
    expect(untitled.title).toBe(
      "Find out why the nightly deploy failed and fix it if it is…",
    );
    expect(untitled.task).toContain(`"${untitled.title}:"`);
    // One that only reads cannot message the assistant: its result says it all.
    const reader = assistantSubsession({
      assistantSessionId: "assistant-chat",
      task: "Review the README",
      readOnly: true,
    });
    expect(reader.task).not.toContain("send_project_session_message");
    expect(reader.task).toContain(
      "put everything they should hear in your final reply",
    );
    expect(() =>
      assistantSubsession({ assistantSessionId: "assistant-chat", task: "  " }),
    ).toThrow("A subsession task is required");
  });

  it("discovers none of the session tools it replaces, and starts sessions like any agent", () => {
    expect(
      withoutReplacedTools([
        { name: "list_project_sessions" },
        { name: "read_project_session" },
        { name: "send_project_session_message" },
        { name: "interrupt_subsession" },
        { name: "wait_for_subsessions" },
        { name: "spawn_subsession" },
        { name: "type_in_terminal" },
      ]).map((tool) => tool.name),
    ).toEqual(["spawn_subsession", "type_in_terminal"]);
  });

  it("keeps the base agent's tools, with its own session tools in place of Work's", () => {
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: {},
      execute: async () => null,
    });
    expect(
      assistantHostTools({
        workspace: [
          tool("open_surface"),
          tool("spawn_subsession"),
          tool("read_project_session"),
        ],
        sessions: [tool("list_sessions")],
        follow: async () => {},
        baseAgentId: "a1",
      }).map((each) => each.name),
    ).toEqual(["open_surface", "spawn_subsession", "list_sessions"]);
  });

  it("briefs the sessions it starts with Work's spawn_subsession and follows them", async () => {
    const spawned: Record<string, unknown>[] = [];
    const followed: unknown[] = [];
    const spawn: ExtraTool = {
      name: "spawn_subsession",
      description: "Start a subagent",
      parameters: {},
      execute: async (input: Record<string, unknown>) => {
        spawned.push(input);
        return { sessionId: "child", title: input.title };
      },
    };
    const follow = async (input: unknown) => {
      followed.push(input);
    };
    const context = {
      projectId: "p1",
      sessionId: "assistant-chat",
      stopWaiting: new AbortController().signal,
    };
    const [served] = assistantHostTools({
      workspace: [spawn],
      sessions: [],
      follow,
      baseAgentId: "a1",
    });
    await served?.execute(
      {
        task: "Count the lines in words.txt",
        model: "opus",
        context_mode: "fresh",
      },
      context,
    );
    // Left without an agent, it runs on the person's own: the one the
    // assistant is built on, never a copy of the assistant.
    expect(spawned[0]).toMatchObject({
      agent: "a1",
      model: "opus",
      context_mode: "fresh",
      title: "Count the lines in words.txt",
    });
    expect(spawned[0]?.task).toContain(
      "relayed it as:\n\nCount the lines in words.txt",
    );
    expect(followed).toEqual([
      {
        follower: { projectId: "p1", sessionId: "assistant-chat" },
        followed: { projectId: "p1", sessionId: "child" },
        title: "Count the lines in words.txt",
      },
    ]);
    // Its agent field says what leaving it out does.
    const field = served?.parameters.agent;
    expect(field instanceof z.ZodType ? field.description : undefined).toBe(
      "An agent id from your instructions' list; leave out for the person's own agent",
    );
    // Discovered, it is the same tool; an agent it names is kept.
    const [discovered] = assistantWorkspaceTools({
      tools: [spawn],
      follow,
      baseAgentId: "a1",
    });
    await discovered?.execute(
      { task: "Again", title: "Again", agent: "reviewer" },
      context,
    );
    expect(spawned[1]).toMatchObject({ agent: "reviewer" });
    expect(spawned[1]?.task).toContain('"Again:"');
  });

  describe("its window tools", () => {
    /** Each tool reports the project it acted in, beside what it found. */
    const tool = (
      name: string,
      found: Record<string, unknown> = {},
      only?: string,
    ) => ({
      name,
      description: name,
      parameters: {},
      execute: async (
        input: Record<string, unknown>,
        context: { projectId: string },
      ) => {
        if (only && context.projectId !== only)
          throw new Error(`No terminal found for ${String(input.key)}`);
        return { ...found, project: context.projectId, input };
      },
    });
    const windowsOf = () => ({
      personProject: () => "catamorphic",
      projectNamed: async (name: string) =>
        name.toLowerCase() === "opencx" ? "opencx" : null,
      seenElsewhere: new Map<string, string>(),
    });
    const home = { projectId: "home", sessionId: "assistant" };

    it("look where the person is, not where its chat lives", async () => {
      const [overview, read, open, point, todo] = inThePersonsWindow(
        [
          tool("workspace_overview"),
          tool("read_tab"),
          tool("open_surface"),
          tool("point_at"),
          tool("update_todo_list"),
        ],
        windowsOf(),
      );
      for (const [each, input] of [
        [overview, {}],
        [read, { key: "window" }],
        [open, { target: "https://example.com" }],
        [point, { target: "browser:pr" }],
      ] as const)
        expect(await each?.execute(input, home)).toMatchObject({
          project: "catamorphic",
        });
      // Its own things stay with its chat.
      expect(await todo?.execute({}, home)).toMatchObject({ project: "home" });
    });

    it("leave what it drives itself with its chat, whose turn hands it back", async () => {
      const [act, open, control, point] = inThePersonsWindow(
        [
          tool("browser_act"),
          tool("open_browser"),
          tool("surface_control"),
          tool("point_at"),
        ],
        windowsOf(),
      );
      expect(await act?.execute({ key: "browser:pr" }, home)).toMatchObject({
        project: "home",
      });
      expect(
        await open?.execute({ url: "https://x.test" }, home),
      ).toMatchObject({ project: "home" });
      expect(
        await control?.execute({ key: "browser:pr", action: "close" }, home),
      ).toMatchObject({ project: "home" });
      // A chip is on its own chat.
      expect(
        await point?.execute({ target: "chip:terminal:mine" }, home),
      ).toMatchObject({ project: "home" });
    });

    it("read its own terminal where its chat is when the person's window lacks it", async () => {
      const [read] = inThePersonsWindow(
        [tool("read_tab", {}, "home")],
        windowsOf(),
      );
      expect(await read?.execute({ key: "terminal:mine" }, home)).toMatchObject(
        {
          project: "home",
        },
      );
    });

    it("look at another project's window by name, and at what they saw there", async () => {
      const windows = windowsOf();
      const [overview, read] = inThePersonsWindow(
        [
          tool("workspace_overview", {
            tabs: [{ key: "browser:elsewhere-pr" }, { key: "app:dashboard" }],
          }),
          tool("read_tab"),
        ],
        windows,
      );
      expect(overview?.parameters).toHaveProperty("project");
      expect(read?.parameters).toHaveProperty("project");
      expect(
        await overview?.execute({ project: "OpenCX" }, home),
      ).toMatchObject({ project: "opencx", input: {} });
      expect(
        await read?.execute({ key: "browser:elsewhere-pr" }, home),
      ).toMatchObject({ project: "opencx" });
      // A key made from a name is in every window: the person's is meant.
      expect(await read?.execute({ key: "app:dashboard" }, home)).toMatchObject(
        { project: "catamorphic" },
      );
      expect(windows.seenElsewhere.has("app:dashboard")).toBe(false);
      await expect(
        overview?.execute({ project: "Website" }, home),
      ).rejects.toThrow('No project named "Website"');
    });

    it("open a file in the person's project, not its own folder", async () => {
      const seen: unknown[] = [];
      const [open] = inThePersonsWindow(
        [
          {
            name: "open_surface",
            description: "open_surface",
            parameters: {},
            execute: async (_input, context) => {
              seen.push(context);
              return null;
            },
          },
        ],
        windowsOf(),
      );
      const stopWaiting = new AbortController().signal;
      await open?.execute(
        { target: "file:docs/plan.md" },
        { ...home, workingDirectory: "/work/home", stopWaiting },
      );
      expect(seen).toEqual([
        { projectId: "catamorphic", sessionId: "assistant", stopWaiting },
      ]);
    });

    it("stay with its chat when no window shows the person's project", async () => {
      const [overview] = inThePersonsWindow([tool("workspace_overview")], {
        ...windowsOf(),
        personProject: () => null,
      });
      expect(await overview?.execute({}, home)).toMatchObject({
        project: "home",
      });
    });
  });
});
