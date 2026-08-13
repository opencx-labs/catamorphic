import type { ProviderSession } from "@catamorphic/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn((config: { name: string }) => ({
    type: "sdk",
    name: config.name,
  })),
  tool: vi.fn((name: string) => ({ name })),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAgent } from "../claude-code-agent.js";

const queryMock = vi.mocked(query);

/** Build a Query-shaped async generator yielding the scripted messages. */
function scriptedQuery(messages: unknown[]) {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })() as unknown as ReturnType<typeof query>;
}

function initMessage(sessionId: string) {
  return { type: "system", subtype: "init", session_id: sessionId };
}

function assistantMessage(content: unknown[]) {
  return {
    type: "assistant",
    session_id: "sess-1",
    parent_tool_use_id: null,
    message: { content },
  };
}

const successResult = {
  type: "result",
  subtype: "success",
  session_id: "sess-1",
  is_error: false,
  result: "ok",
};

const session: ProviderSession = {
  providerSessionId: "sess-1",
  sessionId: "chat-1",
  projectId: "project-1",
  sandboxId: "sandbox-1",
  workingDirectory: "/workspace/project",
};

async function collect(agent: ClaudeCodeAgent, message: string, opts?: object) {
  const events = [];
  for await (const event of agent.sendMessage(session, message, opts)) {
    events.push(event);
  }
  return events;
}

function lastQueryOptions() {
  const call = queryMock.mock.calls.at(-1);
  if (!call) throw new Error("query was not called");
  return call[0].options ?? {};
}

describe("ClaudeCodeAgent", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("maps a scripted stream to coarse agent events", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        initMessage("sess-1"),
        assistantMessage([
          { type: "text", text: "Working on it." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "bun test" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Edit",
            input: {
              file_path: "src/app.ts",
              old_string: "a",
              new_string: "b",
            },
          },
          {
            type: "tool_use",
            id: "toolu_3",
            name: "Skill",
            input: { skill: "pdf" },
          },
        ]),
        successResult,
      ]),
    );
    const agent = new ClaudeCodeAgent();

    const events = await collect(agent, "Run the tests");

    expect(events).toEqual([
      { type: "text", content: "Working on it." },
      { type: "command", content: "bun test" },
      { type: "file_edit", filePath: "src/app.ts", content: "edit" },
      { type: "tool_call", toolName: "Skill", toolInput: { skill: "pdf" } },
      { type: "done" },
    ]);
  });

  it("maps error results to an error event followed by done", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "sess-1",
          is_error: true,
          errors: ["credit balance too low"],
        },
      ]),
    );
    const agent = new ClaudeCodeAgent();

    const events = await collect(agent, "Do something");

    expect(events).toEqual([
      { type: "error", content: "credit balance too low" },
      { type: "done" },
    ]);
  });

  it("surfaces SDK throws as error events instead of rejecting", async () => {
    async function* failingQuery() {
      // The init message maps to no events; the throw mid-stream is what the
      // harness must convert into error + done.
      yield initMessage("sess-1");
      throw new Error("spawn claude ENOENT");
    }
    queryMock.mockReturnValueOnce(
      failingQuery() as unknown as ReturnType<typeof query>,
    );
    const agent = new ClaudeCodeAgent();

    const events = await collect(agent, "Hello");

    expect(events).toEqual([
      { type: "error", content: "spawn claude ENOENT" },
      { type: "done" },
    ]);
  });

  it("passes resume, cwd, model, and effort through to query()", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent({
      model: "claude-sonnet-4-5",
      effort: "medium",
      env: { CLAUDE_CONFIG_DIR: "/accounts/a1" },
    });

    await collect(agent, "Continue the task", { model: "claude-opus-4-6" });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = queryMock.mock.calls[0]?.[0];
    expect(params?.prompt).toBe("Continue the task");
    const options = lastQueryOptions();
    expect(options.resume).toBe("sess-1");
    expect(options.cwd).toBe("/workspace/project");
    // Turn override wins over the constructor default.
    expect(options.model).toBe("claude-opus-4-6");
    expect(options.effort).toBe("medium");
    expect(options.permissionMode).toBe("acceptEdits");
    // A real Claude Code shell: repo CLAUDE.md/.claude and the agent-home's
    // user settings are recognized, exactly like the CLI.
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.allowedTools).toContain("Bash");
    // Custom env is merged over process.env, not a replacement.
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/accounts/a1");
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const)(
    "maps %s effort to the SDK effort level",
    async (effort, expected) => {
      queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
      const agent = new ClaudeCodeAgent();

      await collect(agent, "Think about it", { effort });

      expect(lastQueryOptions().effort).toBe(expected);
    },
  );

  it("leaves effort unset when neither defaults nor the turn set one", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent();

    await collect(agent, "Quick question");

    expect(lastQueryOptions().effort).toBeUndefined();
  });

  it("denies tools outside the allowlist via canUseTool", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent();
    await collect(agent, "Hello");

    const canUseTool = lastQueryOptions().canUseTool;
    if (!canUseTool) throw new Error("canUseTool was not passed to query");
    const decision = await canUseTool(
      "KillShell",
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_deny",
        requestId: "req_1",
      },
    );

    expect(decision).toEqual({
      behavior: "deny",
      message: "This tool is not available in the Catamorphic desktop harness.",
    });
  });

  it("redirects denied shell tools to the workspace terminals", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent();
    await collect(agent, "Hello");

    const canUseTool = lastQueryOptions().canUseTool;
    if (!canUseTool) throw new Error("canUseTool was not passed to query");
    const decision = await canUseTool(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_bash",
        requestId: "req_1",
      },
    );

    if (!decision) throw new Error("expected a permission decision");
    expect(decision.behavior).toBe("deny");
    expect("message" in decision ? decision.message : "").toContain(
      "run_terminal",
    );
  });

  it("swaps built-in shell tools for workspace terminals per-turn", async () => {
    const agent = new ClaudeCodeAgent({
      disableBash: true,
      extraTools: [
        {
          name: "run_terminal",
          description: "Run a command in a workspace terminal",
          parameters: {},
          execute: async () => "ok",
        },
      ],
    });

    // A session started with host context mounts the workspace server, so
    // the built-in shell tools are removed from the model's context.
    const started = await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      sessionId: "chat-1",
      workingDirectory: "/workspace/project",
    });
    const startedId = started.providerSessionId;
    if (!startedId) throw new Error("expected a chosen session id");
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        initMessage(startedId),
        { ...successResult, session_id: startedId },
      ]),
    );
    for await (const _event of agent.sendMessage(started, "First step")) {
      // drain
    }
    let options = lastQueryOptions();
    expect(options.allowedTools).toContain("mcp__workspace__run_terminal");
    expect(options.allowedTools).not.toContain("Bash");
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "PowerShell", "Monitor"]),
    );

    // A session resurrected after a host restart (no stored context) runs
    // without the workspace server — the built-ins come back so the agent
    // still has a shell.
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    await collect(agent, "Continue");
    options = lastQueryOptions();
    expect(options.allowedTools).toContain("Bash");
    expect(options.allowedTools).not.toContain("mcp__workspace__run_terminal");
    expect(options.disallowedTools).toBeUndefined();
  });

  it("maps subagent lifecycle and attributes nested activity", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        initMessage("sess-1"),
        assistantMessage([
          {
            type: "tool_use",
            id: "task_1",
            name: "Agent",
            input: {
              subagent_type: "code-reviewer",
              description: "Review the diff",
              prompt: "Review it",
            },
          },
        ]),
        // Nested activity streams with parent_tool_use_id set; subagent
        // text must NOT leak into this chat's transcript.
        {
          type: "assistant",
          session_id: "sess-1",
          parent_tool_use_id: "task_1",
          message: {
            content: [
              { type: "text", text: "internal subagent monologue" },
              {
                type: "tool_use",
                id: "toolu_9",
                name: "Grep",
                input: { pattern: "TODO" },
              },
            ],
          },
        },
        // The closing tool_result for the Task ends the subagent.
        {
          type: "user",
          session_id: "sess-1",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "tool_result", tool_use_id: "task_1", content: "done" },
            ],
          },
        },
        successResult,
      ]),
    );
    const agent = new ClaudeCodeAgent();

    const events = await collect(agent, "Review my changes");

    expect(events).toEqual([
      {
        type: "subagent",
        status: "started",
        subagentId: "task_1",
        subagentType: "code-reviewer",
        content: "Review the diff",
      },
      {
        type: "tool_call",
        toolName: "Grep",
        toolInput: { pattern: "TODO" },
        subagentId: "task_1",
      },
      { type: "subagent", status: "ended", subagentId: "task_1" },
      { type: "done" },
    ]);
  });

  it("emits background events from the PostToolUse hooks", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent();
    await collect(agent, "Start the dev server");

    const hooks = lastQueryOptions().hooks?.PostToolUse ?? [];
    const bashMatcher = hooks.find((entry) => entry.matcher === "Bash");
    const stopMatcher = hooks.find(
      (entry) => entry.matcher === "TaskStop|KillShell",
    );
    if (!bashMatcher || !stopMatcher) {
      throw new Error("background hooks were not registered");
    }

    // Second turn drains what the hooks captured during the stream.
    queryMock.mockImplementationOnce((params) => {
      return (async function* () {
        const context = {
          signal: new AbortController().signal,
        };
        await params.options?.hooks?.PostToolUse?.[0]?.hooks[0]?.(
          {
            hook_event_name: "PostToolUse",
            session_id: "sess-1",
            transcript_path: "/tmp/t",
            cwd: "/workspace/project",
            tool_name: "Bash",
            tool_use_id: "toolu_bg",
            tool_input: { command: "npm run dev", run_in_background: true },
            tool_response: { backgroundTaskId: "bash_1" },
          } as never,
          "toolu_bg",
          context,
        );
        await params.options?.hooks?.PostToolUse?.[1]?.hooks[0]?.(
          {
            hook_event_name: "PostToolUse",
            session_id: "sess-1",
            transcript_path: "/tmp/t",
            cwd: "/workspace/project",
            tool_name: "TaskStop",
            tool_use_id: "toolu_stop",
            tool_input: { task_id: "bash_1" },
            tool_response: {},
          } as never,
          "toolu_stop",
          context,
        );
        yield successResult;
      })() as unknown as ReturnType<typeof query>;
    });
    const events = await collect(agent, "and stop it");

    expect(events).toEqual([
      {
        type: "background",
        status: "started",
        backgroundId: "bash_1",
        content: "npm run dev",
      },
      { type: "background", status: "ended", backgroundId: "bash_1" },
      { type: "done" },
    ]);
  });

  it("passes external MCP servers and plugins through to query()", async () => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent({
      mcpServers: {
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer x" },
        },
        files: { transport: "stdio", command: "npx", args: ["-y", "fs-mcp"] },
      },
      plugins: [{ name: "acme", path: "/plugins/acme" }],
    });

    await collect(agent, "List my issues");

    const options = lastQueryOptions();
    expect(options.mcpServers).toEqual({
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer x" },
      },
      files: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"] },
    });
    expect(options.plugins).toEqual([
      { type: "local", path: "/plugins/acme", skipMcpDiscovery: true },
    ]);
    expect(options.allowedTools).toContain("mcp__linear");
    expect(options.allowedTools).toContain("mcp__files");
    // Background management and subagent tools ride the allowlist.
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(["Agent", "Task", "TaskOutput", "TaskStop"]),
    );
  });

  it("starts sessions without a kickoff turn and creates the transcript on the first real message", async () => {
    const agent = new ClaudeCodeAgent();

    const started = await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      sessionId: "chat-1",
      workingDirectory: "/workspace/project",
      systemPrompt: "You are the Catamorphic project agent.",
    });

    // No query at session start — the transcript must begin with the user's
    // own first message, not a synthetic prompt the model treats as a
    // standing instruction.
    expect(queryMock).not.toHaveBeenCalled();
    const startedId = started.providerSessionId;
    if (!startedId) throw new Error("expected a chosen session id");
    expect(startedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // First turn: create the session under our chosen id.
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        initMessage(startedId),
        { ...successResult, session_id: startedId },
      ]),
    );
    for await (const _event of agent.sendMessage(started, "First step")) {
      // drain
    }
    let options = lastQueryOptions();
    expect(options.sessionId).toBe(startedId);
    expect(options.resume).toBeUndefined();
    // Host instructions APPEND to the claude_code preset, never replace it.
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are the Catamorphic project agent.",
    });

    // Later turns resume the transcript the first turn created.
    queryMock.mockReturnValueOnce(
      scriptedQuery([{ ...successResult, session_id: startedId }]),
    );
    for await (const _event of agent.sendMessage(started, "Next step")) {
      // drain
    }
    options = lastQueryOptions();
    expect(options.resume).toBe(startedId);
    expect(options.sessionId).toBeUndefined();
    // Host instructions APPEND to the claude_code preset, never replace it.
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are the Catamorphic project agent.",
    });
  });

  it("keeps creating (not resuming) when the first turn fails before the CLI boots", async () => {
    const agent = new ClaudeCodeAgent();
    const started = await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      sessionId: "chat-1",
      workingDirectory: "/workspace/project",
    });
    const startedId = started.providerSessionId;

    // Spawn failure: no init message, so no transcript was created.
    async function* failingQuery() {
      throw new Error("spawn claude ENOENT");
      yield undefined;
    }
    queryMock.mockReturnValueOnce(
      failingQuery() as unknown as ReturnType<typeof query>,
    );
    for await (const _event of agent.sendMessage(started, "First try")) {
      // drain
    }
    expect(lastQueryOptions().sessionId).toBe(startedId);

    // The retry must create again, not resume a transcript that never existed.
    queryMock.mockReturnValueOnce(
      scriptedQuery([initMessage(startedId ?? ""), successResult]),
    );
    for await (const _event of agent.sendMessage(started, "Second try")) {
      // drain
    }
    expect(lastQueryOptions().sessionId).toBe(startedId);
    expect(lastQueryOptions().resume).toBeUndefined();
  });
});
