import type { ExtraToolContext } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import type { WorkspaceBridge } from "../agent-bridge.js";
import { buildWorkspaceToolkit } from "./workspace-tools.js";

const context: ExtraToolContext = {
  projectId: "project",
  sessionId: "session",
};

describe("workspace coordination tools", () => {
  it("reads and atomically replaces the session todo list", async () => {
    const toolkit = buildWorkspaceToolkit({} as WorkspaceBridge);
    const stored = [
      {
        id: "7bea6ee8-f61c-4c4d-9dda-0ac77f6ed973",
        title: "Review the project",
        description: "Inspect the current implementation before editing.",
        status: "pending" as const,
      },
    ];
    const replacements: unknown[] = [];
    toolkit.setTodoListBridge({
      read: async () => stored,
      replace: async (_projectId, _sessionId, items) => {
        replacements.push(items);
        return items.map((item, index) => ({
          ...item,
          id: item.id ?? `00000000-0000-4000-8000-00000000000${index}`,
        }));
      },
    });

    const read = toolkit.tools.find((tool) => tool.name === "read_todo_list");
    const update = toolkit.tools.find(
      (tool) => tool.name === "update_todo_list",
    );
    expect(await read?.execute({}, context)).toEqual({ items: stored });
    expect(
      await update?.execute(
        {
          items: [
            {
              id: stored[0]?.id,
              title: "Review the project",
              description: "The existing implementation has been reviewed.",
              status: "completed",
            },
            {
              title: "Run checks",
              description: "Run focused tests and the repository merge gate.",
              status: "in_progress",
            },
          ],
        },
        context,
      ),
    ).toMatchObject({ completed: 1, total: 2 });
    expect(await update?.execute({ items: [] }, context)).toEqual({
      items: [],
      completed: 0,
      total: 0,
    });
    expect(replacements).toEqual([expect.any(Array), []]);
  });

  it("reads peers and bounded transcripts through the coordination bridge", async () => {
    const toolkit = buildWorkspaceToolkit({} as WorkspaceBridge);
    toolkit.setSessionCoordinationBridge({
      list: async () => [{ id: "peer", title: "Other session" }],
      read: async () => ({
        title: "Other session",
        messages: Array.from({ length: 50 }, (_, index) => ({
          role: "user",
          content: `message ${index}`,
        })),
      }),
      setActivity: async () => {},
    });
    const list = toolkit.tools.find(
      (tool) => tool.name === "list_project_sessions",
    );
    const read = toolkit.tools.find(
      (tool) => tool.name === "read_project_session",
    );
    expect(await list?.execute({}, context)).toEqual([
      { id: "peer", title: "Other session" },
    ]);
    expect(await read?.execute({ session_id: "peer" }, context)).toMatchObject({
      omitted: 10,
    });
  });

  it("changes checkout only through explicit tools", async () => {
    const terminalDirectories: Array<string | undefined> = [];
    const toolkit = buildWorkspaceToolkit({
      runTerminal: async (
        _projectId,
        _sessionId,
        _command,
        _terminalId,
        _timeoutMs,
        workingDirectory,
      ) => {
        terminalDirectories.push(workingDirectory);
        return {
          key: "terminal:test",
          terminalId: "test",
          output: "",
          commandRunning: false,
          exitCode: 0,
          offset: 0,
        };
      },
    } as WorkspaceBridge);
    const checkoutContext: ExtraToolContext = {
      ...context,
      workingDirectory: "/primary",
    };
    let active = "primary";
    toolkit.setCheckoutBridge({
      current: async () => ({ kind: active, path: `/${active}` }),
      list: async () => [],
      create: async () => {
        active = "managed";
        return { kind: "managed", path: "/managed" };
      },
      use: async (_projectId, _sessionId, checkoutPath) => {
        active = "external";
        return { kind: "external", path: checkoutPath };
      },
      usePrimary: async () => {
        active = "primary";
        return { kind: "primary", path: "/primary" };
      },
    });
    expect(
      await toolkit.tools
        .find((tool) => tool.name === "create_worktree")
        ?.execute({}, checkoutContext),
    ).toMatchObject({ kind: "managed", path: "/managed" });
    await toolkit.tools
      .find((tool) => tool.name === "run_terminal")
      ?.execute({ command: "pwd" }, checkoutContext);
    expect(terminalDirectories).toEqual(["/managed"]);
    expect(
      await toolkit.tools
        .find((tool) => tool.name === "use_worktree")
        ?.execute({ path: "/external" }, checkoutContext),
    ).toMatchObject({ kind: "external", path: "/external" });
    await toolkit.tools
      .find((tool) => tool.name === "run_terminal")
      ?.execute({ command: "pwd" }, checkoutContext);
    expect(terminalDirectories).toEqual(["/managed", "/external"]);
    expect(
      await toolkit.tools
        .find((tool) => tool.name === "use_project_checkout")
        ?.execute({}, checkoutContext),
    ).toMatchObject({ kind: "primary" });
    await toolkit.tools
      .find((tool) => tool.name === "run_terminal")
      ?.execute({ command: "pwd" }, checkoutContext);
    expect(terminalDirectories).toEqual(["/managed", "/external", "/primary"]);
  });

  it("hides private chats from overview and transcript expansion", async () => {
    const bridge = {
      overview: async () => ({
        tabs: [
          { key: "chat:public", kind: "chat" },
          { key: "chat:private", kind: "chat" },
        ],
        chats: [
          { key: "chat:public", sessionId: "public" },
          { key: "chat:private", sessionId: "private" },
        ],
      }),
      readTab: async () => ({
        kind: "chat",
        sessionId: "private",
        title: "Incognito",
      }),
    } as unknown as WorkspaceBridge;
    const toolkit = buildWorkspaceToolkit(bridge);
    toolkit.setSessionVisibility(
      async (_projectId, sessionId) => sessionId === "public",
    );

    const overview = await toolkit.tools
      .find((tool) => tool.name === "workspace_overview")
      ?.execute({}, context);
    expect(overview).toEqual({
      tabs: [{ key: "chat:public", kind: "chat" }],
      chats: [{ key: "chat:public", sessionId: "public" }],
    });
    await expect(
      toolkit.tools
        .find((tool) => tool.name === "read_tab")
        ?.execute({ key: "chat:private" }, context),
    ).rejects.toThrow(/private/);
  });

  it("binds sync and pull requests to the current session checkout", async () => {
    const toolkit = buildWorkspaceToolkit({} as WorkspaceBridge);
    const calls: string[] = [];
    toolkit.setGitBridge({
      sync: async (projectId, sessionId) => {
        calls.push(`sync:${projectId}:${sessionId}`);
        return { status: "isolated", branch: "feature" };
      },
      createPullRequest: async (projectId, sessionId, input) => {
        calls.push(`pr:${projectId}:${sessionId}:${input.title}`);
        return { url: "https://example.test/pr/1", number: 1, branch: "pr" };
      },
    });

    await toolkit.tools
      .find((tool) => tool.name === "sync_project")
      ?.execute({}, context);
    await toolkit.tools
      .find((tool) => tool.name === "create_pull_request")
      ?.execute({ title: "Review this" }, context);

    expect(calls).toEqual([
      "sync:project:session",
      "pr:project:session:Review this",
    ]);
  });
});
