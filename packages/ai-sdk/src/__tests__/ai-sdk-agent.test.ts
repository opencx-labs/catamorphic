import { agentToolResult, type SandboxProvider } from "@catamorphic/sandbox";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

vi.mock("@catamorphic/mcp", () => ({
  connectMcpServer: vi.fn(),
}));

import { connectMcpServer } from "@catamorphic/mcp";
import { AiSdkCodingAgent } from "../ai-sdk-agent.js";

const connectMcpServerMock = vi.mocked(connectMcpServer);

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// The turn's accounting event (ADR 0057): totalUsage sums the mock usage
// above across the turn's model steps.
const usageEvent = (steps: number) => ({
  type: "usage" as const,
  usage: {
    model: "mock-model-id",
    inputTokens: 10 * steps,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 5 * steps,
    reasoningTokens: 0,
  },
});

function createProvider(files: Record<string, string> = {}): SandboxProvider {
  return {
    workspaceRoot: "/workspace",
    createSandbox: vi.fn(),
    startSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    getSandboxStatus: vi.fn(),
    executeCommand: vi.fn(async () => ({ exitCode: 0, result: "ok" })),
    uploadFiles: vi.fn(async (_sandboxId, uploaded, basePath) => {
      for (const [filePath, content] of Object.entries(uploaded)) {
        if (typeof content === "string") {
          files[`${basePath}/${filePath}`.replaceAll("//", "/")] = content;
        }
      }
    }),
    downloadFile: vi.fn(async (_sandboxId, filePath) => {
      const content = files[filePath];
      if (content === undefined) throw new Error(`Missing file: ${filePath}`);
      return content;
    }),
    gitClone: vi.fn(),
    gitCheckout: vi.fn(),
  };
}

function toolCallStream(toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "tool-1",
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function textStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text-1" },
        { type: "text-delta" as const, id: "text-1", delta: text },
        { type: "text-end" as const, id: "text-1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function errorStream(error: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "error" as const, error },
      ],
    }),
  };
}

async function start(agent: AiSdkCodingAgent) {
  return agent.startSession({
    projectId: "project-1",
    userId: "user-1",
    sandboxId: "sandbox-1",
    sessionId: "chat-1",
    workingDirectory: "/workspace/project",
  });
}

async function collect(
  agent: AiSdkCodingAgent,
  session: Awaited<ReturnType<typeof start>>,
  message: string,
) {
  const events = [];
  for await (const event of agent.sendMessage(session, message)) {
    events.push(event);
  }
  return events;
}

describe("AiSdkCodingAgent", () => {
  it("continues after non-blocking questions and incorporates later input in the same turn and future history", async () => {
    const provider = createProvider();
    const pending: Array<{ id: string; content: string }> = [];
    provider.executeCommand = vi.fn(async () => {
      pending.push({ id: "answer-1", content: "Use the orange theme" });
      return { exitCode: 0, result: "Independent work completed" };
    });
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("ask_user", {
          blocking: false,
          questions: [
            {
              question: "Which theme?",
              header: "Theme",
              multiSelect: false,
              options: [
                { label: "Orange", description: "Warm" },
                { label: "Blue", description: "Cool" },
              ],
            },
          ],
        }),
        toolCallStream("bash", { command: "echo working" }),
        textStream("Applied your answer"),
        textStream("I remember the orange theme"),
      ],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);
    const askQuestion = vi.fn(async () => "Question is open. Keep working.");
    const acknowledgeMessages = vi.fn(async () => {});
    const events = [];
    for await (const event of agent.sendMessage(session, "Build it", {
      askQuestion,
      readPendingMessages: async () => pending,
      acknowledgeMessages,
    }))
      events.push(event);
    expect(askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ blocking: false, requestId: "tool-1" }),
    );
    expect(provider.executeCommand).toHaveBeenCalledOnce();
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain(
      "Use the orange theme",
    );
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "Use the orange theme",
    );
    expect(acknowledgeMessages).toHaveBeenCalledExactlyOnceWith({
      ids: ["answer-1"],
    });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(
      events.some(
        (event) => event.type === "question" || event.type === "error",
      ),
    ).toBe(false);
    await collect(agent, session, "What theme did I choose?");
    expect(
      JSON.stringify(model.doStreamCalls[3]?.prompt).match(
        /Use the orange theme/g,
      ),
    ).toHaveLength(1);
  });

  it("defaults questions to blocking and waits for the host's answer before the next model step", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("ask_user", {
          questions: [
            {
              question: "Which theme?",
              header: "Theme",
              multiSelect: false,
              options: [
                { label: "Orange", description: "Warm" },
                { label: "Blue", description: "Cool" },
              ],
            },
          ],
        }),
        textStream("Continuing with orange"),
      ],
    });
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: createProvider(),
    });
    const session = await start(agent);
    const answer = deferred<string>();
    const askQuestion = vi.fn(() => answer.promise);
    const completed = (async () => {
      const events = [];
      for await (const event of agent.sendMessage(session, "Ask first", {
        askQuestion,
      }))
        events.push(event);
      return events;
    })();
    try {
      await vi.waitFor(() => expect(askQuestion).toHaveBeenCalledOnce());
      expect(askQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ blocking: true }),
      );
      expect(model.doStreamCalls).toHaveLength(1);
    } finally {
      answer.resolve("Orange");
    }
    const events = await completed;
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Orange");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("stages plugin docs when starting a session", async () => {
    const provider = createProvider();
    const model = new MockLanguageModelV4({ doStream: textStream("unused") });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });

    await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      sessionId: "chat-1",
      workingDirectory: "/workspace/project",
      attachedPlugins: [
        {
          packageName: "@acme/mail",
          displayName: "Mail",
          description: "Send mail",
          files: { "README.md": "# Mail" },
        },
      ],
    });

    expect(provider.uploadFiles).toHaveBeenCalledWith(
      "sandbox-1",
      { "_plugins/acme__mail/README.md": "# Mail" },
      "/workspace/project",
    );
  });

  it("mounts MCP server tools beside the built-ins and maps their calls", async () => {
    const callToolRaw = vi.fn(async () => ({
      content: [{ type: "text", text: "3 open issues" }],
      structuredContent: { open: 3 },
    }));
    connectMcpServerMock.mockResolvedValueOnce({
      tools: [
        {
          name: "list_issues",
          description: "List issues",
          inputSchema: {
            type: "object",
            properties: { team: { type: "string" } },
          },
        },
      ],
      callTool: vi.fn(async () => "unused"),
      callToolRaw,
      readResource: vi.fn(),
      close: vi.fn(async () => {}),
    });
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("mcp__linear__list_issues", { team: "core" }),
        textStream("You have 3 open issues."),
      ],
    });
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: provider,
      mcpServers: {
        linear: { transport: "http", url: "https://mcp.linear.app/mcp" },
      },
    });
    const session = await start(agent);

    const events = await collect(agent, session, "What's on my plate?");

    expect(connectMcpServerMock).toHaveBeenCalledWith(
      { transport: "http", url: "https://mcp.linear.app/mcp" },
      // No onElicit configured on this agent, so the opts arg is undefined.
      undefined,
    );
    expect(callToolRaw).toHaveBeenCalledWith("list_issues", { team: "core" });
    // Call-time event, then a cumulative event carrying the result the
    // moment it lands (MCP Apps views render the structured payload).
    expect(events).toEqual([
      {
        type: "tool_call",
        toolName: "linear/list_issues",
        toolInput: { team: "core" },
        toolUseId: "tool-1",
      },
      {
        type: "tool_call",
        toolName: "linear/list_issues",
        toolInput: { team: "core" },
        toolUseId: "tool-1",
        toolResult: { open: 3 },
      },
      { type: "text", content: "You have 3 open issues." },
      usageEvent(2),
      { type: "done" },
    ]);
  });

  it("gates MCP tools by policy: deny refuses, ask consults the host, always-allow sticks", async () => {
    const callToolRaw = vi.fn(async (_name: string, _args: unknown) => ({
      content: [{ type: "text", text: "sent" }],
    }));
    const server = {
      tools: [
        {
          name: "post_message",
          description: "Post",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false },
        },
        {
          name: "list_channels",
          description: "List",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "delete_channel",
          description: "Delete",
          inputSchema: { type: "object", properties: {} },
          annotations: { destructiveHint: true },
        },
      ],
      callTool: vi.fn(async () => "unused"),
      callToolRaw,
      readResource: vi.fn(),
      close: vi.fn(async () => {}),
    };
    connectMcpServerMock.mockResolvedValueOnce(server);
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("mcp__slack__list_channels", {}),
        toolCallStream("mcp__slack__delete_channel", {}),
        toolCallStream("mcp__slack__post_message", { text: "hi" }),
        toolCallStream("mcp__slack__post_message", { text: "again" }),
        textStream("done"),
      ],
    });
    const asks: string[] = [];
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: provider,
      mcpServers: {
        slack: { transport: "http", url: "https://mcp.slack.com/mcp" },
      },
      // Connection ceiling: auto (read-only allowed, rest asks), delete off.
      mcpPolicies: { slack: [{ tools: { delete_channel: "deny" } }] },
      onToolPermission: async (request) => {
        asks.push(request.tool);
        return { decision: "allow", remember: "always" };
      },
    });
    const session = await start(agent);
    const events = await collect(agent, session, "go");

    // list_channels: read-only → ran without asking.
    // delete_channel: denied → never called, error result carries the reason.
    // post_message: asked once ("always"), then ran again without asking.
    expect(asks).toEqual(["post_message"]);
    expect(callToolRaw.mock.calls.map((call) => call[0])).toEqual([
      "list_channels",
      "post_message",
      "post_message",
    ]);
    expect(JSON.stringify(events)).toMatch(/delete_channel.*turned off/);
  });

  it("an ask with nobody to ask fails closed", async () => {
    connectMcpServerMock.mockResolvedValueOnce({
      tools: [
        {
          name: "post_message",
          description: "Post",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: vi.fn(async () => "unused"),
      callToolRaw: vi.fn(async () => ({ content: [] })),
      readResource: vi.fn(),
      close: vi.fn(async () => {}),
    });
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("mcp__slack__post_message", {}),
        textStream("ok"),
      ],
    });
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: provider,
      mcpServers: {
        slack: { transport: "http", url: "https://mcp.slack.com/mcp" },
      },
      mcpPolicies: { slack: [{}] },
    });
    const session = await start(agent);
    const events = await collect(agent, session, "go");
    expect(JSON.stringify(events)).toMatch(/no one to ask/);
  });

  it("reconnects a server in place when its config changes between turns (rotated token)", async () => {
    const mkServer = (label: string) => ({
      tools: [
        {
          name: "whoami",
          description: "who",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      callTool: vi.fn(async () => label),
      callToolRaw: vi.fn(async () => ({
        content: [{ type: "text", text: label }],
      })),
      readResource: vi.fn(),
      close: vi.fn(async () => {}),
    });
    const first = mkServer("first");
    const second = mkServer("second");
    connectMcpServerMock.mockClear();
    connectMcpServerMock.mockResolvedValueOnce(first);
    connectMcpServerMock.mockResolvedValueOnce(second);
    let token = "Bearer old";
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("mcp__api__whoami", {}),
        textStream("one"),
        toolCallStream("mcp__api__whoami", {}),
        textStream("two"),
      ],
    });
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: provider,
      mcpServers: () => ({
        api: {
          transport: "http",
          url: "https://api.example/mcp",
          headers: { Authorization: token },
        },
      }),
    });
    const session = await start(agent);
    await collect(agent, session, "first turn");
    expect(first.callToolRaw).toHaveBeenCalledTimes(1);
    expect(connectMcpServerMock).toHaveBeenCalledTimes(1);

    token = "Bearer new";
    await collect(agent, session, "second turn");
    // Same session, same tool name — but the call went to the fresh
    // connection carrying the new header, and the stale one was closed.
    expect(connectMcpServerMock).toHaveBeenCalledTimes(2);
    expect(connectMcpServerMock.mock.calls[1]?.[0]).toMatchObject({
      headers: { Authorization: "Bearer new" },
    });
    expect(first.close).toHaveBeenCalled();
    expect(second.callToolRaw).toHaveBeenCalledTimes(1);
    expect(first.callToolRaw).toHaveBeenCalledTimes(1);
  });

  it("skips MCP servers that fail to connect instead of breaking the session", async () => {
    connectMcpServerMock.mockRejectedValueOnce(new Error("boom"));
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: textStream("Hello anyway."),
    });
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: provider,
      mcpServers: {
        broken: { transport: "stdio", command: "definitely-not-installed" },
      },
    });
    const session = await start(agent);

    const events = await collect(agent, session, "Hi");

    expect(events).toEqual([
      { type: "text", content: "Hello anyway." },
      usageEvent(1),
      { type: "done" },
    ]);
  });

  it("executes filesystem tools in the dev sandbox and maps events", async () => {
    const files: Record<string, string> = {};
    const provider = createProvider(files);
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("write", {
          path: "src/generated.ts",
          content: "export const generated = true;\n",
        }),
        textStream("Created the file."),
      ],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    const events = await collect(agent, session, "Create the generated file");

    expect(files["/workspace/project/src/generated.ts"]).toBe(
      "export const generated = true;\n",
    );
    expect(events).toEqual([
      { type: "file_edit", content: "write", filePath: "src/generated.ts" },
      { type: "text", content: "Created the file." },
      usageEvent(2),
      { type: "done" },
    ]);
  });

  it("reads and edits project files through the sandbox provider", async () => {
    const files = {
      "/workspace/project/src/value.ts": "export const value = 'old';\n",
    };
    const provider = createProvider(files);
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("read", { path: "src/value.ts" }),
        toolCallStream("edit", {
          path: "src/value.ts",
          oldText: "'old'",
          newText: "'new'",
        }),
        textStream("Updated the value."),
      ],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    const events = await collect(agent, session, "Update the value");

    expect(provider.downloadFile).toHaveBeenCalledWith(
      "sandbox-1",
      "/workspace/project/src/value.ts",
    );
    expect(files["/workspace/project/src/value.ts"]).toBe(
      "export const value = 'new';\n",
    );
    expect(events).toContainEqual({
      type: "tool_call",
      toolName: "read",
      toolInput: { path: "src/value.ts" },
    });
    expect(events).toContainEqual({
      type: "file_edit",
      content: "edit",
      filePath: "src/value.ts",
    });
  });

  it("runs bash with the project working directory and timeout", async () => {
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("bash", { command: "bun test", timeoutMs: 2_500 }),
        textStream("Tests passed."),
      ],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    const events = await collect(agent, session, "Run tests");

    expect(provider.executeCommand).toHaveBeenCalledWith(
      "sandbox-1",
      "bun test",
      { cwd: "/workspace/project", timeout: 3 },
    );
    expect(events[0]).toEqual({ type: "command", content: "bun test" });
  });

  it("retains AI SDK response messages across turns", async () => {
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [textStream("First response"), textStream("Second response")],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    await collect(agent, session, "First request");
    await collect(agent, session, "Second request");

    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("First request");
    expect(secondPrompt).toContain("First response");
    expect(secondPrompt).toContain("Second request");
  });

  it("rejects escaping paths while allowing the model to recover", async () => {
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("write", { path: "../escape.txt", content: "no" }),
        textStream("The write was rejected."),
      ],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    const events = await collect(agent, session, "Escape the project");

    expect(provider.uploadFiles).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "diagnostic",
      content:
        "Tool write failed: Path escapes the project working directory: ../escape.txt",
    });
    expect(events).toContainEqual({
      type: "text",
      content: "The write was rejected.",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("does not emit done after a terminal model error", async () => {
    const provider = createProvider();
    const model = new MockLanguageModelV4({
      doStream: errorStream(new Error("model failed")),
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    const events = await collect(agent, session, "Fail this turn");

    expect(events).toEqual([{ type: "error", content: "model failed" }]);
  });

  it("truncates large tool output before returning it to the model", async () => {
    const provider = createProvider();
    vi.mocked(provider.executeCommand).mockResolvedValue({
      exitCode: 0,
      result: "x".repeat(110_000),
    });
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream("bash", { command: "verbose-command" }),
        textStream("Handled output."),
      ],
    });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });
    const session = await start(agent);

    await collect(agent, session, "Run the verbose command");

    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("...[output truncated]");
    expect(secondPrompt).not.toContain("x".repeat(100_001));
  });
});

describe("pruneEmptyOptionalArgs", () => {
  it("drops empty optional values and keeps required ones", async () => {
    const { pruneEmptyOptionalArgs } = await import("../ai-sdk-agent.js");
    expect(
      pruneEmptyOptionalArgs(
        { query: "from:me", context_channel_id: "", cursor: null, limit: 5 },
        {
          type: "object",
          properties: {},
          required: ["query"],
        },
      ),
    ).toEqual({ query: "from:me", limit: 5 });
    expect(
      pruneEmptyOptionalArgs(
        { query: "" },
        { type: "object", required: ["query"] },
      ),
    ).toEqual({ query: "" });
  });

  it("keeps null / empty when the property's schema means them", async () => {
    const { pruneEmptyOptionalArgs } = await import("../ai-sdk-agent.js");
    const schema = {
      type: "object",
      properties: {
        due_date: { type: ["string", "null"], description: "null clears" },
        owner: { anyOf: [{ type: "string" }, { type: "null" }] },
        legacy: { type: "string", nullable: true },
        note: { type: "string" },
        channel: { type: "string", pattern: "^C[A-Z0-9]+$" },
        code: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["", "fast"] },
        count: { type: "integer" },
      },
      required: [],
    };
    expect(
      pruneEmptyOptionalArgs(
        {
          due_date: null,
          owner: null,
          legacy: null,
          note: "",
          channel: "",
          code: "",
          mode: "",
          count: null,
          unknown: "",
        },
        schema,
      ),
    ).toEqual({
      due_date: null,
      owner: null,
      legacy: null,
      note: "",
      mode: "",
    });
  });
});

it("aborts an active model request when the session is disposed", async () => {
  let signal: AbortSignal | undefined;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      signal = options.abortSignal;
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal?.reason), {
          once: true,
        }),
      );
      return textStream("unreachable");
    },
  });
  const agent = new AiSdkCodingAgent({
    model,
    sandboxProvider: createProvider(),
  });
  const session = await start(agent);
  const turn = collect(agent, session, "Keep working");
  await vi.waitFor(() => expect(signal).toBeDefined());
  await agent.dispose(session);
  await turn;
  expect(signal?.aborted).toBe(true);
  expect(agent.hasSession(session.providerSessionId ?? "")).toBe(false);
});

it.each(["host", "mcp"] as const)(
  "preserves %s image blocks for the model without storing bytes in tool activity",
  async (source) => {
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
    const result = agentToolResult({
      content: [
        { type: "text", text: "A screenshot" },
        { type: "image", mimeType: "image/png", data },
      ],
    });
    if (source === "mcp")
      connectMcpServerMock.mockResolvedValueOnce({
        tools: [
          {
            name: "screenshot",
            description: "Read screen",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        callTool: vi.fn(),
        callToolRaw: vi.fn(async () => result),
        readResource: vi.fn(),
        close: vi.fn(async () => {}),
      });
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream(
          source === "host" ? "screenshot" : "mcp__computer__screenshot",
          {},
        ),
        textStream("Seen"),
      ],
    });
    const agent = new AiSdkCodingAgent({
      model,
      sandboxProvider: createProvider(),
      ...(source === "host"
        ? {
            extraTools: [
              {
                name: "screenshot",
                description: "Read screen",
                parameters: {},
                execute: async () => result,
              },
            ],
          }
        : {
            mcpServers: {
              computer: { transport: "http", url: "http://127.0.0.1/unused" },
            },
          }),
    });
    const events = await collect(
      agent,
      await start(agent),
      "Inspect the screen",
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      '"mediaType":"image/png"',
    );
    expect(JSON.stringify(events)).not.toContain(data);
  },
);

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
