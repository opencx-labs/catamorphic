import type { SandboxProvider } from "@catamorphic/sandbox";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AiSdkCodingAgent } from "../ai-sdk-agent.js";

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

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
  it("stages plugin docs when starting a session", async () => {
    const provider = createProvider();
    const model = new MockLanguageModelV4({ doStream: textStream("unused") });
    const agent = new AiSdkCodingAgent({ model, sandboxProvider: provider });

    await agent.startSession({
      projectId: "project-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
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

  it("rejects filesystem paths outside the project", async () => {
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
      type: "error",
      content:
        "Tool write failed: Path escapes the project working directory: ../escape.txt",
    });
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
