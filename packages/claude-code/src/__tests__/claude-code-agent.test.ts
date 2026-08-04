import type { ProviderSession } from "@catamorphic/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
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
    expect(options.settingSources).toEqual([]);
    expect(options.allowedTools).toContain("Bash");
    // Custom env is merged over process.env, not a replacement.
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/accounts/a1");
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const)("maps %s effort to the SDK effort level", async (effort, expected) => {
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    const agent = new ClaudeCodeAgent();

    await collect(agent, "Think about it", { effort });

    expect(lastQueryOptions().effort).toBe(expected);
  });

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

  it("captures the session id from the kickoff turn on startSession", async () => {
    queryMock.mockReturnValueOnce(
      scriptedQuery([
        initMessage("sess-new"),
        assistantMessage([{ type: "text", text: "OK." }]),
        { ...successResult, session_id: "sess-new" },
      ]),
    );
    const agent = new ClaudeCodeAgent();

    const started = await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      workingDirectory: "/workspace/project",
      systemPrompt: "You are the Catamorphic project agent.",
    });

    expect(started.providerSessionId).toBe("sess-new");
    const options = lastQueryOptions();
    expect(options.maxTurns).toBe(1);
    expect(options.systemPrompt).toBe("You are the Catamorphic project agent.");

    // The stored system prompt is re-sent on subsequent turns.
    queryMock.mockReturnValueOnce(scriptedQuery([successResult]));
    for await (const _event of agent.sendMessage(
      { ...started, providerSessionId: "sess-new" },
      "Next step",
    )) {
      // drain
    }
    expect(lastQueryOptions().systemPrompt).toBe(
      "You are the Catamorphic project agent.",
    );
  });
});
