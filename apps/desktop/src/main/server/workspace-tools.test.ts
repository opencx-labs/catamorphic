import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentCapabilityTools,
  type ExtraToolContext,
} from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkspaceBridge } from "../agent-bridge.js";
import { WORKSPACE_TOOLS_PLAYBOOK } from "./workspace-context-agent.js";
import {
  buildWorkspaceToolkit,
  WORKSPACE_TOOL_POLICY,
} from "./workspace-tools.js";

const context: ExtraToolContext = {
  projectId: "project",
  sessionId: "session",
};

describe("workspace coordination tools", () => {
  it("keeps the eager surface explicit, complete, and small", () => {
    const toolkit = buildWorkspaceToolkit({} as WorkspaceBridge);
    expect(toolkit.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(WORKSPACE_TOOL_POLICY).sort(),
    );
    expect(
      toolkit.tools
        .filter((tool) => tool.eager)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["open_surface", "update_todo_list", "workspace_overview"]);
    expect(WORKSPACE_TOOLS_PLAYBOOK.length).toBeLessThan(1800);
    const eager = [
      ...toolkit.tools.filter((tool) => tool.eager),
      ...agentCapabilityTools({
        discover: async () => ({ items: [] }),
        invoke: async () => null,
      }),
    ];
    const wire = eager.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(
        z.object(
          z.record(z.string(), z.instanceof(z.ZodType)).parse(tool.parameters),
        ),
      ),
    }));
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(6000);
    expect(
      toolkit.tools.every(
        (tool) =>
          typeof tool.nativeOnly === "boolean" &&
          typeof tool.readOnly === "boolean",
      ),
    ).toBe(true);
  });

  it("rejects directory links before creating a broken editor tab", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "workspace-target-"));
    const opened: string[] = [];
    const toolkit = buildWorkspaceToolkit({
      openTarget: async (_project, _session, target) => {
        opened.push(target);
        return { key: "editor:1", opened: "focused" };
      },
    } as WorkspaceBridge);
    try {
      await expect(
        toolkit.tools
          .find((tool) => tool.name === "open_surface")
          ?.execute(
            { target: "file:.:1" },
            { ...context, workingDirectory: directory },
          ),
      ).rejects.toThrow("directory");
      expect(opened).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("previews apps by default and publishes only on an explicit request", async () => {
    const toolkit = buildWorkspaceToolkit({} as WorkspaceBridge);
    const published: boolean[] = [];
    toolkit.setAppBuilder(async (_project, _name, publish) => {
      published.push(publish);
      return { status: publish ? "published" : "preview_ready" };
    });
    const build = toolkit.tools.find((tool) => tool.name === "build_app");
    await build?.execute({ name: "dashboard" }, context);
    await build?.execute({ name: "dashboard", publish: true }, context);
    expect(published).toEqual([false, true]);
  });
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
      send: async () => ({}),
      spawn: async () => ({}),
      listSubsessions: async () => [],
      waitForSubsessions: async () => [],
      interruptSubsession: async () => {},
      requestAttention: async () => ({}),
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

  it("delegates and controls child sessions through the coordination bridge", async () => {
    const toolkit = buildWorkspaceToolkit({} as WorkspaceBridge);
    const calls: unknown[] = [];
    toolkit.setSessionCoordinationBridge({
      list: async () => [],
      read: async () => null,
      send: async (...args) => {
        calls.push(["send", ...args]);
        return { queued: true };
      },
      spawn: async (...args) => {
        calls.push(["spawn", ...args]);
        return { delegationId: "delegation", session: { id: "child" } };
      },
      listSubsessions: async (...args) => {
        calls.push(["list", ...args]);
        return [{ session: { id: "child" }, status: "running" }];
      },
      waitForSubsessions: async (...args) => {
        calls.push(["wait", ...args]);
        return [{ session: { id: "child" }, status: "completed" }];
      },
      interruptSubsession: async (...args) => {
        calls.push(["interrupt", ...args]);
      },
      requestAttention: async (...args) => {
        calls.push(["attention", ...args]);
        return { attentionRequired: true };
      },
      setActivity: async () => {},
    });

    const execute = (name: string, input: Record<string, unknown> = {}) =>
      toolkit.tools.find((tool) => tool.name === name)?.execute(input, context);
    await execute("send_project_session_message", {
      session_id: "peer",
      message: "Context",
      delivery_mode: "message_only",
    });
    await execute("spawn_subsession", {
      task: "Review the API",
      route_id: "reviewer",
      agent_id: "agent-small",
      context_mode: "fresh",
      title: "API review",
    });
    await execute("list_project_sessions", { children_only: true });
    await execute("wait_for_subsessions", {
      session_ids: ["child"],
      timeout_ms: 25,
    });
    await execute("interrupt_subsession", { session_id: "child" });
    await execute("request_user_attention");

    expect(calls).toEqual([
      ["send", "project", "session", "peer", "Context", "message_only"],
      [
        "spawn",
        "project",
        "session",
        {
          task: "Review the API",
          routeId: "reviewer",
          agentId: "agent-small",
          contextMode: "fresh",
          title: "API review",
        },
      ],
      ["list", "project", "session"],
      ["wait", "project", "session", { sessionIds: ["child"], timeoutMs: 25 }],
      ["interrupt", "project", "session", "child"],
      ["attention", "project", "session"],
    ]);
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
      returnToPrimary: async () => {
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
        .find((tool) => tool.name === "use_worktree")
        ?.execute({ path: null }, checkoutContext),
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
