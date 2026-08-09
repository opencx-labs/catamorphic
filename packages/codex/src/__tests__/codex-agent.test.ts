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

async function collect(agent: CodexAgent, message: string) {
  const events = [];
  for await (const event of agent.sendMessage(session, message)) {
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

  it("passes MCP servers as mcp_servers config overrides", () => {
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
    });

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

  it("passes no config when there are no MCP servers", () => {
    new CodexAgent();
    expect(codexCtor.mock.calls[0]?.[0]).not.toHaveProperty("config");
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
