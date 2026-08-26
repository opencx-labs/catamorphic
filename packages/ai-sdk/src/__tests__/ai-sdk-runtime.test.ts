import {
  type AgentRuntimeEvent,
  type AgentRuntimeProvider,
  type AgentRuntimeSession,
  AgentRuntimeUnsupportedError,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { defineAgentRuntimeConformance } from "@catamorphic/sandbox/testing";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { AiSdkAgentRuntime } from "../ai-sdk-runtime.js";

const usage = {
  inputTokens: { total: 11, noCache: 7, cacheRead: 3, cacheWrite: 1 },
  outputTokens: { total: 5, text: 4, reasoning: 1 },
};

function createSandboxProvider(): SandboxProvider {
  return {
    workspaceRoot: "/workspace",
    createSandbox: vi.fn(),
    startSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    getSandboxStatus: vi.fn(),
    executeCommand: vi.fn(async () => ({ exitCode: 0, result: "ok" })),
    uploadFiles: vi.fn(),
    downloadFile: vi.fn(async () => "contents"),
    gitClone: vi.fn(),
    gitCheckout: vi.fn(),
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

function questionStream() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-input-start" as const,
          id: "question-call",
          toolName: "ask_user",
        },
        {
          type: "tool-input-delta" as const,
          id: "question-call",
          delta: '{"questions":',
        },
        { type: "tool-input-end" as const, id: "question-call" },
        {
          type: "tool-call" as const,
          toolCallId: "question-call",
          toolName: "ask_user",
          input: JSON.stringify({
            questions: [
              {
                question: "Which database should we use?",
                header: "Database",
                multiSelect: false,
                options: [
                  {
                    label: "PostgreSQL",
                    description: "Relational and durable",
                  },
                  { label: "SQLite", description: "Embedded and local" },
                ],
              },
            ],
          }),
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

function bashStream() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-input-start" as const,
          id: "bash-call",
          toolName: "bash",
        },
        {
          type: "tool-input-delta" as const,
          id: "bash-call",
          delta: '{"command":"pwd"}',
        },
        { type: "tool-input-end" as const, id: "bash-call" },
        {
          type: "tool-call" as const,
          toolCallId: "bash-call",
          toolName: "bash",
          input: '{"command":"pwd"}',
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

function writeStream() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-input-start" as const,
          id: "write-call",
          toolName: "write",
        },
        {
          type: "tool-input-delta" as const,
          id: "write-call",
          delta: '{"path":"src/app.ts","content":"updated"}',
        },
        { type: "tool-input-end" as const, id: "write-call" },
        {
          type: "tool-call" as const,
          toolCallId: "write-call",
          toolName: "write",
          input: '{"path":"src/app.ts","content":"updated"}',
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

function failingQuestionStream() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-input-start" as const,
          id: "question-call",
          toolName: "ask_user",
        },
        { type: "tool-input-end" as const, id: "question-call" },
        {
          type: "tool-call" as const,
          toolCallId: "question-call",
          toolName: "ask_user",
          input: JSON.stringify({
            questions: [
              {
                question: "Which database should we use?",
                header: "Database",
                multiSelect: false,
                options: [{ label: "PostgreSQL" }],
              },
            ],
          }),
        },
        { type: "error" as const, error: new Error("stream failed") },
      ],
    }),
  };
}

function createRuntime(
  streams: NonNullable<
    NonNullable<
      ConstructorParameters<typeof MockLanguageModelV4>[0]
    >["doStream"]
  > = [questionStream(), textStream("Continuing.")],
) {
  return new AiSdkAgentRuntime({
    model: new MockLanguageModelV4({ doStream: streams }),
    sandboxProvider: createSandboxProvider(),
  });
}

async function startSession(
  provider: AgentRuntimeProvider,
): Promise<AgentRuntimeSession> {
  return provider.startSession({
    sessionId: "ai-session",
    projectId: "project-1",
    allocationId: "allocation-1",
    workingDirectory: "/workspace/project",
  });
}

async function collectUntil(args: {
  provider: AgentRuntimeProvider;
  sessionId: string;
  after?: number;
  until: (event: AgentRuntimeEvent) => boolean;
}): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of args.provider.subscribe({
    sessionId: args.sessionId,
    after: { sequence: args.after ?? 0 },
  })) {
    events.push(event);
    if (args.until(event)) break;
  }
  return events;
}

function boundedConformanceProvider(
  provider: AgentRuntimeProvider,
): AgentRuntimeProvider {
  return {
    name: provider.name,
    describe: (args) => provider.describe(args),
    startSession: (args) => provider.startSession(args),
    resumeSession: async (args) => {
      try {
        return await provider.resumeSession(args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AgentRuntimeUnsupportedError"
        ) {
          throw new AgentRuntimeUnsupportedError({
            provider: provider.name,
            operation: "resumeSession",
          });
        }
        throw error;
      }
    },
    stopSession: (args) => provider.stopSession(args),
    startTurn: async (args) => {
      const turn = await provider.startTurn(args);
      await collectUntil({
        provider,
        sessionId: args.sessionId,
        until: (event) =>
          event.turnId === turn.turnId &&
          (event.type === "request.created" ||
            event.type === "turn.completed" ||
            event.type === "turn.failed"),
      });
      return turn;
    },
    retryTurn: async (args) => {
      try {
        return await provider.retryTurn(args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AgentRuntimeUnsupportedError"
        ) {
          throw new AgentRuntimeUnsupportedError({
            provider: provider.name,
            operation: "retryTurn",
          });
        }
        throw error;
      }
    },
    interruptTurn: (args) => provider.interruptTurn(args),
    respond: (args) => provider.respond(args),
    listTasks: async (args) => {
      try {
        return await provider.listTasks(args);
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AgentRuntimeUnsupportedError"
        ) {
          throw new AgentRuntimeUnsupportedError({
            provider: provider.name,
            operation: "listTasks",
          });
        }
        throw error;
      }
    },
    controlTask: (args) => provider.controlTask(args),
    async *subscribe(args) {
      const iterator = provider.subscribe(args)[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 15),
          ),
        ]);
        if (!next || next.done) break;
        yield next.value;
        yield next.value;
      }
      void iterator.return?.();
    },
  };
}

describe("AiSdkAgentRuntime conformance", () => {
  defineAgentRuntimeConformance({
    create: () => boundedConformanceProvider(createRuntime()),
    expected: {
      approvals: true,
      questions: true,
      tasks: false,
      operations: {
        resumeSession: false,
        retryTurn: false,
        interruptTurn: true,
      },
    },
    driver: {
      startSession: ({ provider }) => startSession(provider),
      startTurn: ({ provider, session }) =>
        provider.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Run the conformance turn." },
        }),
      responseFor: () => ({ kind: "question", answers: ["PostgreSQL"] }),
      controlTask: async () => {},
      assertTaskControl: () => {},
      resumeSession: ({ provider, session }) =>
        provider.resumeSession({
          sessionId: session.sessionId,
          providerSessionId: "unsupported",
          projectId: session.projectId,
          allocationId: session.allocationId,
          workingDirectory: session.workingDirectory,
          after: { sequence: 0 },
        }),
    },
  });
});

describe("AiSdkAgentRuntime", () => {
  it("publishes native partial text, tool progress, usage, result, and turn end in sequence", async () => {
    const runtime = createRuntime([textStream("Hello world")]);
    const session = await startSession(runtime);
    expect(session.providerSessionId).toBeNull();

    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Say hello." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" && event.turnId === turn.turnId,
    });

    expect(
      events.map((event) => ({ type: event.type, sequence: event.sequence })),
    ).toEqual([
      { type: "session.started", sequence: 1 },
      { type: "diagnostic", sequence: 2 },
      { type: "turn.started", sequence: 3 },
      { type: "message.delta", sequence: 4 },
      { type: "message.completed", sequence: 5 },
      { type: "usage.updated", sequence: 6 },
      { type: "turn.completed", sequence: 7 },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        message: { role: "assistant", delta: "Hello world" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage.updated",
        usage: {
          inputTokens: 11,
          outputTokens: 5,
          totalTokens: 16,
          model: "mock-model-id",
          contextWindow: { used: 11 },
        },
      }),
    );
  });

  it("answers a typed question after startTurn returned and continues the same logical turn", async () => {
    const runtime = createRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Choose a database." },
    });

    const beforeAnswer = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "request.created",
    });
    const request = beforeAnswer.find(
      (event) => event.type === "request.created",
    );
    if (request?.type !== "request.created") {
      throw new Error("The question request was not emitted");
    }
    expect(beforeAnswer.map((event) => event.type)).toEqual([
      "session.started",
      "diagnostic",
      "turn.started",
      "tool.requested",
      "tool.progressed",
      "tool.started",
      "request.created",
    ]);
    expect(request.request).toMatchObject({
      kind: "question",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      question: {
        prompt: "Which database should we use?",
        options: [
          { id: "PostgreSQL", label: "PostgreSQL" },
          { id: "SQLite", label: "SQLite" },
        ],
      },
    });

    const beforeResponse = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      after: request.sequence,
      until: (event) => event.type === "usage.updated",
    });
    expect(beforeResponse.map((event) => event.type)).toEqual([
      "usage.updated",
    ]);

    await runtime.respond({
      sessionId: session.sessionId,
      requestId: request.request.requestId,
      response: { kind: "question", answers: ["PostgreSQL"] },
    });
    const afterAnswer = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      after: beforeResponse.at(-1)?.sequence,
      until: (event) => event.type === "turn.completed",
    });

    expect(afterAnswer.map((event) => event.type)).toEqual([
      "request.resolved",
      "tool.completed",
      "message.delta",
      "message.completed",
      "usage.updated",
      "turn.completed",
    ]);
    expect(
      [...beforeResponse, ...afterAnswer]
        .filter((event) => event.type === "usage.updated")
        .map((event) => event.usage),
    ).toEqual([
      {
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 16,
        model: "mock-model-id",
        contextWindow: { used: 11 },
      },
      {
        inputTokens: 22,
        outputTokens: 10,
        totalTokens: 32,
        model: "mock-model-id",
        contextWindow: { used: 22 },
      },
    ]);
    expect(afterAnswer.at(-1)?.turnId).toBe(turn.turnId);
  });

  it("settles a parked request when the provider stream fails", async () => {
    const runtime = createRuntime([failingQuestionStream()]);
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Choose a database." },
    });

    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.failed",
    });
    const request = events.find((event) => event.type === "request.created");
    if (request?.type !== "request.created") {
      throw new Error("The question request was not emitted");
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "request.resolved",
        requestId: request.request.requestId,
        resolution: { kind: "question", answers: [] },
      }),
    );
    await expect(
      runtime.respond({
        sessionId: session.sessionId,
        requestId: request.request.requestId,
        response: { kind: "question", answers: ["PostgreSQL"] },
      }),
    ).rejects.toThrow("Pending agent request not found");
    await vi.waitFor(async () => {
      await expect(
        runtime.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Continue." },
        }),
      ).resolves.toEqual(
        expect.objectContaining({ sessionId: session.sessionId }),
      );
    });
  });

  it("emits workspace changes only after a successful write result", async () => {
    const runtime = new AiSdkAgentRuntime({
      model: new MockLanguageModelV4({
        doStream: [writeStream(), textStream("Done.")],
      }),
      sandboxProvider: createSandboxProvider(),
    });
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Update the file." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });
    const completed = events.findIndex(
      (event) =>
        event.type === "tool.completed" && event.tool.toolId === "write-call",
    );
    const changed = events.findIndex(
      (event) => event.type === "workspace.changed",
    );

    expect(completed).toBeGreaterThan(-1);
    expect(changed).toBeGreaterThan(completed);
    expect(events[changed]).toMatchObject({
      type: "workspace.changed",
      changes: [{ path: "src/app.ts", kind: "created" }],
    });
  });

  it("does not emit a workspace change when a write fails", async () => {
    const sandbox = createSandboxProvider();
    vi.mocked(sandbox.uploadFiles).mockRejectedValueOnce(
      new Error("disk full"),
    );
    const runtime = new AiSdkAgentRuntime({
      model: new MockLanguageModelV4({
        doStream: [writeStream(), textStream("Could not write.")],
      }),
      sandboxProvider: sandbox,
    });
    const session = await startSession(runtime);
    await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Update the file." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "turn.completed",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        tool: expect.objectContaining({ toolId: "write-call" }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "workspace.changed" }),
    );
  });

  it("cancels a parked request when its turn is interrupted", async () => {
    const runtime = createRuntime();
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Choose a database." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) => event.type === "request.created",
    });
    const request = events.find((event) => event.type === "request.created");
    if (request?.type !== "request.created") {
      throw new Error("The question request was not emitted");
    }

    await runtime.interruptTurn({
      sessionId: session.sessionId,
      turnId: turn.turnId,
    });

    await expect(
      runtime.respond({
        sessionId: session.sessionId,
        requestId: request.request.requestId,
        response: { kind: "question", answers: ["PostgreSQL"] },
      }),
    ).rejects.toThrow("Pending agent request not found");
    await vi.waitFor(async () => {
      await expect(
        runtime.startTurn({
          sessionId: session.sessionId,
          message: { role: "user", content: "Continue." },
        }),
      ).resolves.toEqual(
        expect.objectContaining({ sessionId: session.sessionId }),
      );
    });
  });

  it("evaluates dynamic policy at use time and maps an automatic denial", async () => {
    const seen: string[] = [];
    const runtime = new AiSdkAgentRuntime({
      model: new MockLanguageModelV4({
        doStream: [bashStream(), textStream("Denied safely.")],
      }),
      sandboxProvider: createSandboxProvider(),
      decideToolUse: async ({ toolName }) => {
        seen.push(toolName);
        return { decision: "deny", reason: "Policy denied the command" };
      },
    });
    const session = await startSession(runtime);
    const turn = await runtime.startTurn({
      sessionId: session.sessionId,
      message: { role: "user", content: "Run pwd." },
    });
    const events = await collectUntil({
      provider: runtime,
      sessionId: session.sessionId,
      until: (event) =>
        event.type === "turn.completed" && event.turnId === turn.turnId,
    });

    expect(seen).toEqual(["bash"]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "request.created" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        tool: expect.objectContaining({ toolId: "bash-call" }),
      }),
    );
  });
});
