import type { ProviderSession } from "@catamorphic/sandbox";
import type { ThreadEvent } from "@openai/codex-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startThread = vi.fn();
const resumeThread = vi.fn();
const codexCtor = vi.fn();

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: unknown) {
      codexCtor(options);
    }
    startThread = startThread;
    resumeThread = resumeThread;
  },
}));

import { CodexAgent, isDaemonizingCommand } from "../codex-agent.js";

const session: ProviderSession = {
  providerSessionId: "thread-1",
  sessionId: "chat-1",
  projectId: "project-1",
  sandboxId: "",
  workingDirectory: "/workspace/project",
};

function scriptedThread(events: ThreadEvent[]) {
  return {
    runStreamed: async () => ({
      events: (async function* () {
        for (const event of events) yield event;
      })(),
    }),
  };
}

async function collect(
  agent: CodexAgent,
  message: string,
  providerSession: ProviderSession = session,
) {
  const events = [];
  for await (const event of agent.sendMessage(providerSession, message)) {
    events.push(event);
  }
  return events;
}

describe("isDaemonizingCommand", () => {
  it.each([
    ["npm run dev &", true],
    ["nohup python server.py", true],
    ["cd app && nohup ./serve.sh", true],
    ["docker run -d postgres", true],
    ["docker compose up -d", true],
    ["pm2 start api", true],
    ["tmux new-session -d -s watch 'npm run dev'", true],
    ["npm run build", false],
    ["git status && git diff", false],
    ["grep -r 'a & b' src", false],
    ["docker run --rm node:22 node -v", false],
  ])("%s → %s", (command, expected) => {
    expect(isDaemonizingCommand(command)).toBe(expected);
  });
});

describe("CodexAgent", () => {
  beforeEach(() => {
    startThread.mockReset();
    resumeThread.mockReset();
    codexCtor.mockReset();
  });

  it("keeps completed SDK error items non-fatal", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        {
          type: "item.completed",
          item: {
            id: "diagnostic-1",
            type: "error",
            message: "A recoverable tool result could not be decoded",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "answer-1",
            type: "agent_message",
            text: "The useful answer still completed.",
          },
        },
        { type: "turn.completed", usage: dummyUsage() },
      ]),
    );

    const events = await collect(new CodexAgent(), "continue");

    expect(events).toContainEqual({
      type: "diagnostic",
      content: "A recoverable tool result could not be decoded",
    });
    expect(events).toContainEqual({
      type: "text",
      content: "The useful answer still completed.",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("flags daemonizing commands as detected background processes", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        {
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "npm run dev &",
            aggregated_output: "[1] 4242",
            exit_code: 0,
            status: "completed",
          },
        },
        { type: "turn.completed", usage: dummyUsage() },
      ]),
    );
    const events = await collect(new CodexAgent(), "start the dev server");

    expect(events).toContainEqual({
      type: "background",
      status: "detected",
      backgroundId: "codex-daemon-item_1",
      content: "npm run dev &",
    });
  });

  it("flags commands still running when the turn ends", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        {
          type: "item.started",
          item: {
            id: "item_2",
            type: "command_execution",
            command: "npm run watch",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        { type: "turn.completed", usage: dummyUsage() },
      ]),
    );
    const events = await collect(new CodexAgent(), "watch the build");

    expect(events).toContainEqual({
      type: "background",
      status: "detected",
      backgroundId: "codex-exec-item_2",
      content: "npm run watch",
    });
    // Ends with the ordinary turn completion.
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("does not flag commands that completed normally", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        {
          type: "item.started",
          item: {
            id: "item_3",
            type: "command_execution",
            command: "bun test",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "item_3",
            type: "command_execution",
            command: "bun test",
            aggregated_output: "ok",
            exit_code: 0,
            status: "completed",
          },
        },
        { type: "turn.completed", usage: dummyUsage() },
      ]),
    );
    const events = await collect(new CodexAgent(), "run tests");

    expect(events.some((event) => event.type === "background")).toBe(false);
  });

  const turnDone = () =>
    scriptedThread([{ type: "turn.completed", usage: dummyUsage() }]);

  it("passes MCP servers as mcp_servers config overrides, per spawn", async () => {
    resumeThread.mockReturnValueOnce(turnDone());
    await collect(
      new CodexAgent({
        mcpServers: {
          linear: {
            transport: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer x" },
          },
          "local files": {
            transport: "stdio",
            command: "npx",
            args: ["-y", "fs-mcp"],
            env: { ROOT: "/data" },
          },
        },
      }),
      "hello",
    );

    expect(codexCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          mcp_servers: {
            linear: {
              url: "https://mcp.linear.app/mcp",
              http_headers: { Authorization: "Bearer x" },
            },
            local_files: {
              command: "npx",
              args: ["-y", "fs-mcp"],
              env: { ROOT: "/data" },
            },
          },
        },
      }),
    );
  });

  it("can replace private multi-agent tools with host subsessions", async () => {
    resumeThread.mockReturnValueOnce(turnDone());
    await collect(
      new CodexAgent({ disableNativeSubagents: true }),
      "Delegate this review",
    );

    expect(codexCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { features: { multi_agent: false } },
      }),
    );
  });

  it("reads a live server source at every spawn (rotated token, no rebuild)", async () => {
    let token = "Bearer old";
    const agent = new CodexAgent({
      mcpServers: () => ({
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: token },
        },
      }),
    });
    resumeThread.mockReturnValueOnce(turnDone());
    await collect(agent, "one");
    token = "Bearer new";
    resumeThread.mockReturnValueOnce(turnDone());
    await collect(agent, "two");
    type Spawn = {
      config: {
        mcp_servers: { linear: { http_headers: { Authorization: string } } };
      };
    };
    const tokens = codexCtor.mock.calls.map(
      (call) => (call[0] as Spawn).config.mcp_servers.linear.http_headers,
    );
    expect(tokens.map((headers) => headers.Authorization)).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
  });

  it("passes no config when there are no MCP servers", async () => {
    resumeThread.mockReturnValueOnce(turnDone());
    await collect(new CodexAgent(), "hello");
    expect(codexCtor).toHaveBeenCalledTimes(1);
    expect(codexCtor.mock.calls[0]?.[0]).not.toHaveProperty("config");
  });

  it("mounts session-scoped MCP servers after agent-wide servers", async () => {
    const agent = new CodexAgent({
      mcpServers: {
        workspace: { transport: "http", url: "https://profile.example/mcp" },
      },
      mcpServersForSession: (context) => ({
        workspace: {
          transport: "http",
          url: `http://127.0.0.1/${context.projectId}/${context.sessionId}`,
          defaultToolsApprovalMode: "approve",
        },
      }),
    });
    await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "",
      workingDirectory: "/workspace/project",
      sessionId: "chat-1",
    });
    resumeThread.mockReturnValueOnce(turnDone());
    await collect(agent, "hello");
    expect(codexCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          mcp_servers: {
            workspace: {
              url: "http://127.0.0.1/project-1/chat-1",
              default_tools_approval_mode: "approve",
            },
          },
        },
      }),
    );
  });

  it("restores session-scoped MCP servers for a persisted thread", async () => {
    const agent = new CodexAgent({
      mcpServersForSession: (context) => ({
        workspace: {
          transport: "http",
          url: `http://127.0.0.1/${context.projectId}/${context.sessionId}`,
        },
      }),
    });
    resumeThread.mockReturnValueOnce(turnDone());

    await collect(agent, "hello", {
      projectId: "persisted-project",
      sessionId: "persisted-chat",
      providerSessionId: "codex-thread",
      sandboxId: "",
      workingDirectory: "/workspace/project",
    });

    expect(codexCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          mcp_servers: {
            workspace: {
              url: "http://127.0.0.1/persisted-project/persisted-chat",
            },
          },
        },
      }),
    );
  });

  it("refreshes session MCP context when the host changes checkout", async () => {
    const contexts: unknown[] = [];
    const agent = new CodexAgent({
      mcpServersForSession: (context) => {
        contexts.push({ ...context });
        return {};
      },
    });
    const started = await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "",
      sessionId: "chat-1",
      workingDirectory: "/workspace/project",
      caller: { tenantId: "tenant-1", externalUserId: "user-1" },
    });
    resumeThread
      .mockReturnValueOnce(turnDone())
      .mockReturnValueOnce(turnDone());

    await collect(agent, "first", {
      ...started,
      providerSessionId: "codex-thread",
    });
    await collect(agent, "second", {
      ...started,
      providerSessionId: "codex-thread",
      workingDirectory: "/workspace/worktrees/chat-1",
    });

    expect(contexts).toEqual([
      {
        projectId: "project-1",
        sessionId: "chat-1",
        workingDirectory: "/workspace/project",
        caller: { tenantId: "tenant-1", externalUserId: "user-1" },
      },
      {
        projectId: "project-1",
        sessionId: "chat-1",
        workingDirectory: "/workspace/worktrees/chat-1",
        caller: { tenantId: "tenant-1", externalUserId: "user-1" },
      },
    ]);
  });
});

function dummyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}
