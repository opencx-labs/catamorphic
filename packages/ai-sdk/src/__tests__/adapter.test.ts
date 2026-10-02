import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { ConnectedMcpServer } from "@catamorphic/mcp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type AiSdkLocal, createAiSdkAdapter } from "../adapter.js";
import {
  hangingCall,
  type ModelCallOptions,
  type ModelTranscript,
  rejectedCall,
  replayModel,
  replyCall,
  streamErrorCall,
  toolCallsCall,
} from "../testing/index.js";
import { attemptStart, FakeHost, type ThreadStore } from "./fake-host.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-adapter-")),
);
const sandboxes = new LocalProcessSandboxProvider({ root });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function sandboxLocal(): Promise<AiSdkLocal> {
  const handle = await sandboxes.createSandbox({});
  return {
    sandbox: {
      provider: sandboxes,
      sandboxId: handle.id,
      workingDirectory: "/workspace",
    },
    shell: {},
  };
}

function prompt(call: ModelCallOptions | undefined): string {
  return JSON.stringify(call?.prompt ?? null);
}

function fresh(thread = "thread-1") {
  return { mode: "fresh" as const, providerThreadId: thread };
}

function resume(thread = "thread-1") {
  return {
    mode: "resume" as const,
    providerThreadId: thread,
    nativeRef: { id: thread, strength: "strong" as const },
  };
}

async function run(input: {
  transcript: ModelTranscript;
  attempt?: Parameters<typeof attemptStart>[0];
  local?: AiSdkLocal;
  store?: ThreadStore;
  host?: Omit<
    ConstructorParameters<typeof FakeHost>[0],
    "adapter" | "attempt" | "local" | "store"
  >;
  adapter?: Omit<Parameters<typeof createAiSdkAdapter>[0], "model">;
  beforeCall?: NonNullable<Parameters<typeof replayModel>[1]>["beforeCall"];
}) {
  const replay = replayModel(
    input.transcript,
    input.beforeCall ? { beforeCall: input.beforeCall } : undefined,
  );
  const adapter = createAiSdkAdapter({ model: replay.model, ...input.adapter });
  const host = new FakeHost({
    adapter,
    attempt: attemptStart(input.attempt ?? { thread: fresh() }),
    ...(input.local ? { local: input.local } : {}),
    ...(input.store ? { store: input.store } : {}),
    ...input.host,
  });
  return { host, replay };
}

function completed(host: FakeHost) {
  const [event] = host.of("turn.completed");
  if (!event) throw new Error("The turn never completed");
  return event;
}

describe("ai-sdk adapter: streaming", () => {
  it("streams a reply as items, reports thread first, status from reasoning, usage, then completion", async () => {
    const { host, replay } = await run({
      transcript: {
        calls: [
          replyCall("Hello there, friend.", {
            reasoning: "**Planning the greeting**\nSay hello.",
            usage: { input: 120, output: 30, cacheRead: 100 },
          }),
        ],
      },
      attempt: {
        thread: fresh(),
        context: "<session_context>\nToday is Friday.\n</session_context>",
        systemPrompt: "Be brief.",
        input: { itemId: "item-1", text: "Say hi", attachments: [] },
      },
    });
    await host.done;
    expect(host.events[0]).toEqual({
      type: "thread",
      ref: { id: "thread-1", strength: "strong" },
    });
    expect(host.events.map((event) => event.type)).toEqual([
      "thread",
      "turn.started",
      "item.started",
      "item.delta",
      "item.completed",
      "status",
      "item.started",
      "item.delta",
      "item.delta",
      "item.completed",
      "usage",
      "turn.completed",
    ]);
    expect(host.textsOf("reasoning")).toEqual([
      "**Planning the greeting**\nSay hello.",
    ]);
    expect(host.of("status")).toEqual([
      { type: "status", text: "Planning the greeting" },
    ]);
    expect(host.assistantTexts()).toEqual(["Hello there, friend."]);
    expect(host.of("usage")[0]?.usage).toEqual({
      model: "replay-model",
      inputTokens: 20,
      cachedInputTokens: 100,
      cacheCreationTokens: 0,
      outputTokens: 30,
      reasoningTokens: 0,
      contextTokens: 150,
    });
    const done = completed(host);
    expect(done.status).toBe("completed");
    expect(done.ref?.strength).toBe("strong");
    // The context sits beside the message, instructions in the system prompt.
    const sent = replay.calls[0]?.prompt ?? [];
    expect(sent[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(sent[0])).toContain("Be brief.");
    expect(sent.slice(1).map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(JSON.stringify(sent[1])).toContain("Today is Friday.");
    expect(JSON.stringify(sent[2])).toContain("Say hi");
    // The thread is stored: the turn, its step, and the boundary.
    expect(
      host.store
        .get("thread-1")
        ?.map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? entry.kind
            : null,
        ),
    ).toEqual(["turn", "step", "turn_end"]);
  });
});

describe("ai-sdk adapter: tool loop", () => {
  it("writes, edits and runs commands on the sandbox as file changes and commands, text split around tools", async () => {
    const local = await sandboxLocal();
    const { host } = await run({
      local,
      transcript: {
        calls: [
          toolCallsCall(
            [
              {
                id: "write-1",
                name: "write",
                input: { path: "notes/plan.md", content: "draft one" },
              },
            ],
            { text: "Writing the plan." },
          ),
          toolCallsCall([
            {
              id: "edit-1",
              name: "edit",
              input: {
                path: "notes/plan.md",
                oldText: "one",
                newText: "two",
              },
            },
          ]),
          toolCallsCall([
            {
              id: "bash-1",
              name: "bash",
              input: {
                command: "cat notes/plan.md; echo; exit 3",
                description: "Show the plan",
              },
            },
          ]),
          replyCall("Done."),
        ],
      },
    });
    await host.done;
    expect(completed(host).status).toBe("completed");
    const sandbox = local.sandbox;
    if (!sandbox) throw new Error("no sandbox");
    expect(
      await sandboxes.downloadFile(
        sandbox.sandboxId,
        "/workspace/notes/plan.md",
      ),
    ).toBe("draft two");
    const started = host.of("item.started");
    expect(started.map((event) => event.item.kind)).toEqual([
      "assistant_message",
      "file_change",
      "file_change",
      "command",
      "assistant_message",
    ]);
    expect(started[1]?.item).toMatchObject({
      kind: "file_change",
      path: "notes/plan.md",
      change: null,
    });
    expect(started[2]?.item).toMatchObject({ change: "modified" });
    expect(started[3]?.item).toMatchObject({
      kind: "command",
      command: "cat notes/plan.md; echo; exit 3",
      description: "Show the plan",
    });
    const commandDone = host
      .of("item.completed")
      .find((event) => event.key === started[3]?.key);
    expect(commandDone).toMatchObject({
      status: "completed",
      item: { output: "draft two", exitCode: 3 },
    });
    expect(host.assistantTexts()).toEqual(["Writing the plan.", "Done."]);
    // Each item completes after it starts and before the next one starts.
    const order = host.events
      .filter(
        (event): event is Extract<HarnessEvent, { key: string }> =>
          event.type === "item.started" || event.type === "item.completed",
      )
      .map((event) => `${event.type}:${event.key}`);
    expect(order).toEqual(
      started.flatMap((event) => [
        `item.started:${event.key}`,
        `item.completed:${event.key}`,
      ]),
    );
  });

  it("refuses paths outside the project and lets the model recover", async () => {
    const { host, replay } = await run({
      local: await sandboxLocal(),
      transcript: {
        calls: [
          toolCallsCall([
            {
              id: "write-1",
              name: "write",
              input: { path: "../escape.txt", content: "x" },
            },
          ]),
          replyCall("I cannot write there."),
        ],
      },
    });
    await host.done;
    expect(completed(host).status).toBe("completed");
    expect(
      host.of("item.completed").find((event) => event.key === "tool:write-1")
        ?.status,
    ).toBe("failed");
    expect(prompt(replay.calls[1])).toContain("Path escapes");
  });

  it("calls host tools through the host, with the item's key, and reads their results", async () => {
    const { host, replay } = await run({
      attempt: {
        thread: fresh(),
        hostTools: [
          {
            name: "update_todo_list",
            description: "Update the todo list",
            inputSchema: {
              type: "object",
              properties: { items: { type: "array" } },
            },
          },
          {
            name: "read_tab",
            description: "Read a tab",
            inputSchema: { type: "object", properties: {} },
            server: "desktop",
          },
        ],
      },
      host: {
        tools: {
          update_todo_list: () => ({
            content: [{ type: "text", text: "Saved 1 item." }],
            structured: { count: 1 },
          }),
          read_tab: () => ({
            content: [{ type: "text", text: "No such tab." }],
            isError: true,
          }),
        },
      },
      transcript: {
        calls: [
          toolCallsCall([
            {
              id: "todo-1",
              name: "update_todo_list",
              input: { items: [{ title: "Ship" }] },
            },
            { id: "tab-1", name: "read_tab", input: {} },
          ]),
          replyCall("Listed."),
        ],
      },
    });
    await host.done;
    const toolCalls = host.calls.filter((call) => call.kind === "tool");
    expect(toolCalls).toEqual(
      expect.arrayContaining([
        {
          kind: "tool",
          name: "update_todo_list",
          input: { items: [{ title: "Ship" }] },
          itemKey: "tool:todo-1",
        },
        { kind: "tool", name: "read_tab", input: {}, itemKey: "tool:tab-1" },
      ]),
    );
    expect(
      host.of("item.started").map((event) => [event.key, event.item]),
    ).toEqual(
      expect.arrayContaining([
        [
          "tool:todo-1",
          expect.objectContaining({
            kind: "tool_call",
            tool: "update_todo_list",
            server: "workspace",
          }),
        ],
        [
          "tool:tab-1",
          expect.objectContaining({ tool: "read_tab", server: "desktop" }),
        ],
      ]),
    );
    const results = host.of("item.completed");
    expect(results.find((event) => event.key === "tool:todo-1")).toMatchObject({
      status: "completed",
      item: {
        result: {
          content: [{ type: "text", text: "Saved 1 item." }],
          structured: { count: 1 },
        },
      },
    });
    expect(results.find((event) => event.key === "tool:tab-1")).toMatchObject({
      status: "failed",
      item: { error: "No such tab." },
    });
    expect(prompt(replay.calls[1])).toContain("Saved 1 item.");
    expect(prompt(replay.calls[1])).toContain("No such tab.");
  });
});

function fakeMcp(): ConnectedMcpServer & {
  callToolRaw: ReturnType<typeof vi.fn>;
} {
  return {
    tools: [
      {
        name: "chat.post",
        description: "Post a message",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            thread: { type: "string", pattern: "^T" },
          },
          required: ["text"],
        },
      },
    ],
    callTool: vi.fn(async () => "unused"),
    callToolRaw: vi.fn(async () => ({
      content: [{ type: "text", text: "posted" }],
    })),
    readResource: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

describe("ai-sdk adapter: MCP tools and approvals", () => {
  for (const decision of ["approved", "denied"] as const) {
    it(`asks the person before a policed MCP tool runs (${decision})`, async () => {
      const server = fakeMcp();
      const { host, replay } = await run({
        adapter: { connectMcp: async () => server },
        attempt: {
          thread: fresh(),
          mcpServers: {
            slack: { transport: "http", url: "https://mcp.test/slack" },
          },
          toolPolicies: { slack: [{ default: "ask" }] },
        },
        host: {
          answer: (_key, request) =>
            request.kind === "approval"
              ? { kind: "approval", decision }
              : undefined,
        },
        transcript: {
          calls: [
            toolCallsCall([
              {
                id: "post-1",
                name: "mcp__slack__chat_post",
                input: { text: "hi", thread: "" },
              },
            ]),
            replyCall(decision === "approved" ? "Posted." : "Not posted."),
          ],
        },
      });
      await host.done;
      const opened = host.of("request.opened");
      expect(opened).toHaveLength(1);
      expect(opened[0]?.request).toMatchObject({
        kind: "approval",
        approval: {
          tool: { server: "slack", name: "chat.post", input: { text: "hi" } },
        },
      });
      expect(
        host.of("item.started").find((event) => event.key === "tool:post-1")
          ?.item,
      ).toMatchObject({
        kind: "tool_call",
        tool: "mcp__slack__chat_post",
        server: "slack",
      });
      const done = host
        .of("item.completed")
        .find((event) => event.key === "tool:post-1");
      if (decision === "approved") {
        // Empty optional arguments never reach the server.
        expect(server.callToolRaw).toHaveBeenCalledWith("chat.post", {
          text: "hi",
        });
        expect(done).toMatchObject({
          status: "completed",
          item: { result: "posted" },
        });
      } else {
        expect(server.callToolRaw).not.toHaveBeenCalled();
        expect(done?.status).toBe("failed");
        expect(prompt(replay.calls[1])).toContain("declined");
      }
      expect(completed(host).status).toBe("completed");
      expect(server.close).toHaveBeenCalled();
    });
  }

  it("runs unpoliced servers without asking and skips servers that fail to connect", async () => {
    const server = fakeMcp();
    const { host, replay } = await run({
      adapter: {
        connectMcp: async ({ name }) => {
          if (name === "broken") throw new Error("connection refused");
          return server;
        },
      },
      attempt: {
        thread: fresh(),
        mcpServers: {
          slack: { transport: "http", url: "https://mcp.test/slack" },
          broken: { transport: "http", url: "https://mcp.test/broken" },
        },
      },
      transcript: {
        calls: [
          toolCallsCall([
            {
              id: "post-1",
              name: "mcp__slack__chat_post",
              input: { text: "hi" },
            },
          ]),
          replyCall("Posted."),
        ],
      },
    });
    await host.done;
    expect(host.of("request.opened")).toHaveLength(0);
    expect(server.callToolRaw).toHaveBeenCalled();
    expect(host.of("diagnostic")[0]?.message).toContain("broken");
    expect(JSON.stringify(replay.calls[0]?.tools)).toContain(
      "mcp__slack__chat_post",
    );
  });

  it("passes an MCP elicitation to the person and back", async () => {
    let elicitation:
      | Parameters<
          NonNullable<Parameters<typeof createAiSdkAdapter>[0]["connectMcp"]>
        >[0]["onElicit"]
      | undefined;
    const server = fakeMcp();
    server.callToolRaw.mockImplementation(async () => {
      const answer = await elicitation?.({
        mode: "form",
        message: "Which channel?",
        fields: [{ name: "channel", type: "string", required: true }],
      });
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    });
    const { host } = await run({
      adapter: {
        connectMcp: async ({ onElicit }) => {
          elicitation = onElicit;
          return server;
        },
      },
      attempt: {
        thread: fresh(),
        mcpServers: { slack: { transport: "http", url: "https://mcp.test" } },
      },
      host: {
        answer: () => ({
          kind: "elicitation",
          action: "accept",
          content: { channel: "general" },
        }),
      },
      transcript: {
        calls: [
          toolCallsCall([
            {
              id: "post-1",
              name: "mcp__slack__chat_post",
              input: { text: "hi" },
            },
          ]),
          replyCall("Done."),
        ],
      },
    });
    await host.done;
    expect(host.of("request.opened")[0]?.request).toMatchObject({
      kind: "elicitation",
      origin: { kind: "mcp", id: "slack" },
      elicitation: {
        server: "slack",
        message: "Which channel?",
        schema: { type: "object", required: ["channel"] },
      },
    });
    expect(
      host.of("item.completed").find((event) => event.key === "tool:post-1"),
    ).toMatchObject({
      status: "completed",
      item: {
        result: JSON.stringify({
          action: "accept",
          content: { channel: "general" },
        }),
      },
    });
  });
});

describe("ai-sdk adapter: questions", () => {
  it("asks the person with ask_user and gives the model the answer", async () => {
    const { host, replay } = await run({
      host: {
        answer: (_key, request) =>
          request.kind === "question"
            ? { kind: "question", answers: ["Postgres"] }
            : undefined,
      },
      transcript: {
        calls: [
          toolCallsCall([
            {
              id: "ask-1",
              name: "ask_user",
              input: {
                questions: [
                  {
                    question: "Which database?",
                    header: "Database",
                    options: [
                      { label: "Postgres", description: "Relational" },
                      { label: "SQLite", description: "A file" },
                    ],
                  },
                ],
              },
            },
          ]),
          replyCall("Postgres it is."),
        ],
      },
    });
    await host.done;
    const [opened] = host.of("request.opened");
    expect(opened).toMatchObject({
      key: "ask:ask-1",
      request: {
        kind: "question",
        blocking: true,
        title: "Which database?",
        questions: [{ question: "Which database?", header: "Database" }],
      },
    });
    // A question is its request, never a tool call item.
    expect(host.of("item.started").map((event) => event.item.kind)).toEqual([
      "assistant_message",
    ]);
    expect(prompt(replay.calls[1])).toContain("Answer: Postgres");
    expect(completed(host).status).toBe("completed");
  });
});

describe("ai-sdk adapter: steering and interrupts", () => {
  it("takes steered input before the next model step and reports it consumed", async () => {
    let steerId = "";
    const { host, replay } = await run({
      attempt: {
        thread: fresh(),
        hostTools: [
          {
            name: "slow_work",
            description: "Work for a while",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      host: {
        tools: {
          slow_work: async () => {
            steerId = currentHost.send({
              kind: "steer",
              input: {
                itemId: "steer-1",
                text: "Also mention the weather.",
                attachments: [],
              },
            });
            await currentHost.waitFor(
              () => currentHost.acks(steerId).length > 0,
            );
            return { content: [{ type: "text", text: "worked" }] };
          },
        },
      },
      transcript: {
        calls: [
          toolCallsCall([{ id: "work-1", name: "slow_work", input: {} }]),
          replyCall("Worked, and it is sunny."),
        ],
      },
    });
    const currentHost = host;
    await host.done;
    expect(host.acks(steerId)[0]?.error).toBeUndefined();
    expect(host.of("input.consumed")).toEqual([
      { type: "input.consumed", itemIds: ["steer-1"] },
    ]);
    expect(prompt(replay.calls[1])).toContain("Also mention the weather.");
    expect(prompt(replay.calls[0])).not.toContain("Also mention the weather.");
    // The steer is part of the stored history at the boundary it joined.
    expect(JSON.stringify(host.store.get("thread-1"))).toContain(
      "Also mention the weather.",
    );
  });

  it("takes a steer that arrives during the final answer in one more round", async () => {
    const holder: { host?: FakeHost } = {};
    const { host, replay } = await run({
      transcript: {
        calls: [replyCall("First answer."), replyCall("Second answer.")],
      },
      beforeCall: async ({ index }) => {
        const current = holder.host;
        if (index !== 0 || !current) return;
        const id = current.send({
          kind: "steer",
          input: {
            itemId: "steer-1",
            text: "And another thing.",
            attachments: [],
          },
        });
        await current.waitFor(() => current.acks(id).length > 0);
      },
    });
    holder.host = host;
    await host.done;
    expect(host.of("input.consumed")).toEqual([
      { type: "input.consumed", itemIds: ["steer-1"] },
    ]);
    expect(prompt(replay.calls[0])).not.toContain("And another thing.");
    expect(prompt(replay.calls[1])).toContain("And another thing.");
    expect(host.assistantTexts()).toEqual(["First answer.", "Second answer."]);
    expect(completed(host).status).toBe("completed");
  });

  it("refuses a steer once the turn finished", async () => {
    const replay = replayModel({ calls: [replyCall("Done.")] });
    const events: HarnessEvent[] = [];
    const control = createAiSdkAdapter({ model: replay.model }).start(
      attemptStart({ thread: fresh() }),
      {
        emit: (event) => events.push(event),
        callTool: async () => ({ content: [] }),
        authorize: async () => ({ allowed: true }),
        request: async () => ({ kind: "question", answers: [] }),
        nativeState: {
          append: async () => {},
          load: async () => null,
          subpaths: async () => [],
        },
        signal: new AbortController().signal,
      },
    );
    await control.finished;
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(
      await control.steer({
        itemId: "late",
        text: "Too late",
        attachments: [],
      }),
    ).toBe(false);
  });

  it("interrupts a turn mid-stream, keeps the partial text and completes interrupted", async () => {
    const store: ThreadStore = new Map();
    const { host } = await run({
      store,
      transcript: { calls: [hangingCall("Partial ans")] },
    });
    await host.waitFor((event) => event.type === "item.delta");
    host.send({ kind: "interrupt" });
    await host.done;
    expect(completed(host)).toMatchObject({ status: "interrupted" });
    expect(host.assistantTexts()).toEqual(["Partial ans"]);
    expect(host.of("item.completed")[0]).toMatchObject({
      status: "completed",
      item: { text: "Partial ans" },
    });
    expect(JSON.stringify(store.get("thread-1")?.at(-1))).toContain(
      "interrupted",
    );
  });

  it("withdraws a pending question when interrupted", async () => {
    const { host } = await run({
      transcript: {
        calls: [
          toolCallsCall([
            {
              id: "ask-1",
              name: "ask_user",
              input: {
                questions: [
                  { question: "Which?", header: "Pick", options: [] },
                ],
              },
            },
          ]),
        ],
      },
    });
    await host.waitFor((event) => event.type === "request.opened");
    host.send({ kind: "interrupt" });
    await host.done;
    expect(host.of("request.closed")).toEqual([
      { type: "request.closed", key: "ask:ask-1", reason: "The turn stopped." },
    ]);
    expect(completed(host).status).toBe("interrupted");
  });
});

describe("ai-sdk adapter: failures", () => {
  it.each([
    [429, "Too many requests", "rate_limit"],
    [401, "invalid x-api-key", "auth"],
    [529, "Overloaded", "unavailable"],
    [400, "messages.1: thinking block signature is invalid", "model_incompat"],
  ] as const)(
    "classifies a %s rejection before any work as %s, safe to retry",
    async (statusCode, message, kind) => {
      const { host } = await run({
        transcript: {
          calls: [rejectedCall({ statusCode, message, isRetryable: false })],
        },
      });
      await host.done;
      expect(completed(host)).toMatchObject({
        status: "failed",
        error: { message, kind, retrySafe: true },
      });
    },
  );

  it("never calls a failure after work safe to retry", async () => {
    const { host } = await run({
      local: await sandboxLocal(),
      transcript: {
        calls: [
          toolCallsCall([
            { id: "bash-1", name: "bash", input: { command: "echo hi" } },
          ]),
          streamErrorCall("The server is overloaded"),
        ],
      },
    });
    await host.done;
    const done = completed(host);
    expect(done.status).toBe("failed");
    expect(done.error?.kind).toBe("unavailable");
    expect(done.error?.retrySafe).toBeUndefined();
  });

  it("fails clearly when a resumed thread has no stored history", async () => {
    const { host } = await run({
      attempt: { thread: resume("missing") },
      transcript: { calls: [] },
    });
    await host.done;
    expect(completed(host)).toMatchObject({
      status: "failed",
      error: { message: "This conversation's stored history is missing." },
    });
  });
});

describe("ai-sdk adapter: native state", () => {
  it("resumes from stored native state in a new adapter, as a new process would", async () => {
    const store: ThreadStore = new Map();
    const first = await run({
      store,
      transcript: { calls: [replyCall("The secret is 42.")] },
      attempt: {
        thread: fresh(),
        input: { itemId: "item-1", text: "Remember 42", attachments: [] },
      },
    });
    await first.host.done;
    const second = await run({
      store,
      transcript: { calls: [replyCall("You said 42.")] },
      attempt: {
        thread: resume(),
        input: { itemId: "item-2", text: "What did I say?", attachments: [] },
      },
    });
    await second.host.done;
    expect(completed(second.host).status).toBe("completed");
    expect(second.host.events[0]).toEqual({
      type: "thread",
      ref: { id: "thread-1", strength: "strong" },
    });
    const sent = second.replay.calls[0]?.prompt ?? [];
    expect(sent.slice(1).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(prompt(second.replay.calls[0])).toContain("The secret is 42.");
  });

  it("strips reasoning written by another model when the model changes", async () => {
    const store: ThreadStore = new Map();
    const first = await run({
      store,
      transcript: {
        modelId: "model-a",
        calls: [replyCall("Answer.", { reasoning: "private thoughts" })],
      },
    });
    await first.host.done;
    const same = await run({
      store,
      transcript: { modelId: "model-a", calls: [replyCall("Again.")] },
      attempt: { thread: resume() },
    });
    await same.host.done;
    expect(prompt(same.replay.calls[0])).toContain("private thoughts");
    const other = await run({
      store,
      transcript: { modelId: "model-b", calls: [replyCall("Again.")] },
      attempt: { thread: resume() },
    });
    await other.host.done;
    expect(prompt(other.replay.calls[0])).not.toContain("private thoughts");
  });

  it("retries the last turn natively: a failed turn continues, a finished answer is replaced", async () => {
    const store: ThreadStore = new Map();
    const failed = await run({
      store,
      transcript: {
        calls: [rejectedCall({ statusCode: 529, message: "Overloaded" })],
      },
      attempt: {
        thread: fresh(),
        input: { itemId: "item-1", text: "Plan the trip", attachments: [] },
      },
    });
    await failed.host.done;
    const retried = await run({
      store,
      transcript: { calls: [replyCall("Here is the plan.")] },
      attempt: { thread: resume(), reason: "retry", input: null },
    });
    await retried.host.done;
    expect(completed(retried.host).status).toBe("completed");
    const sent = retried.replay.calls[0]?.prompt ?? [];
    expect(sent.slice(1).map((message) => message.role)).toEqual(["user"]);
    expect(prompt(retried.replay.calls[0])).toContain("Plan the trip");

    const again = await run({
      store,
      transcript: { calls: [replyCall("A better plan.")] },
      attempt: { thread: resume(), reason: "retry", input: null },
    });
    await again.host.done;
    const resent = again.replay.calls[0]?.prompt ?? [];
    expect(resent.slice(1).map((message) => message.role)).toEqual(["user"]);
    expect(prompt(again.replay.calls[0])).not.toContain("Here is the plan.");

    const next = await run({
      store,
      transcript: { calls: [replyCall("Booked.")] },
      attempt: {
        thread: resume(),
        input: { itemId: "item-2", text: "Book it", attachments: [] },
      },
    });
    await next.host.done;
    const history = next.replay.calls[0]?.prompt ?? [];
    expect(history.slice(1).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(prompt(next.replay.calls[0])).toContain("A better plan.");
    expect(prompt(next.replay.calls[0])).not.toContain("Here is the plan.");
  });

  it("refuses a native retry with nothing to retry", async () => {
    const { host } = await run({
      transcript: { calls: [] },
      attempt: { thread: fresh(), input: null, reason: "retry" },
    });
    await host.done;
    expect(completed(host)).toMatchObject({
      status: "failed",
      error: { message: "There is no earlier turn to retry." },
    });
  });

  it("forks a thread through a turn into a new thread that resumes on its own", async () => {
    const store: ThreadStore = new Map();
    const turnOne = await run({
      store,
      transcript: { calls: [replyCall("Turn one answer.")] },
      attempt: {
        thread: fresh(),
        attemptId: "attempt-one",
        input: { itemId: "item-1", text: "Turn one", attachments: [] },
      },
    });
    await turnOne.host.done;
    const throughTurnRef = completed(turnOne.host).ref;
    expect(throughTurnRef).toEqual({ id: "attempt-one", strength: "strong" });
    const turnTwo = await run({
      store,
      transcript: { calls: [replyCall("Turn two answer.")] },
      attempt: {
        thread: resume(),
        input: { itemId: "item-2", text: "Turn two", attachments: [] },
      },
    });
    await turnTwo.host.done;

    const fork = await run({
      store,
      transcript: { calls: [replyCall("Forked answer.")] },
      attempt: {
        thread: {
          mode: "fork",
          providerThreadId: "thread-2",
          source: { id: "thread-1", strength: "strong" },
          ...(throughTurnRef ? { throughTurnRef } : {}),
        },
        input: {
          itemId: "item-3",
          text: "Instead, turn two b",
          attachments: [],
        },
      },
    });
    await fork.host.done;
    expect(fork.host.events[0]).toEqual({
      type: "thread",
      ref: { id: "thread-2", strength: "strong" },
    });
    expect(completed(fork.host).status).toBe("completed");
    const forkPrompt = prompt(fork.replay.calls[0]);
    expect(forkPrompt).toContain("Turn one answer.");
    expect(forkPrompt).not.toContain("Turn two");
    // The source is untouched; the fork resumes from its own copy.
    expect(JSON.stringify(store.get("thread-1"))).not.toContain("turn two b");
    const later = await run({
      store,
      transcript: { calls: [replyCall("Still forked.")] },
      attempt: {
        thread: resume("thread-2"),
        input: { itemId: "item-4", text: "Continue", attachments: [] },
      },
    });
    await later.host.done;
    const laterPrompt = prompt(later.replay.calls[0]);
    expect(laterPrompt).toContain("Turn one answer.");
    expect(laterPrompt).toContain("Forked answer.");
    expect(laterPrompt).not.toContain("Turn two answer.");
  });

  it("fails a fork through a turn the source never finished", async () => {
    const store: ThreadStore = new Map([["thread-1", []]]);
    const { host } = await run({
      store,
      transcript: { calls: [] },
      attempt: {
        thread: {
          mode: "fork",
          providerThreadId: "thread-2",
          source: { id: "thread-1", strength: "strong" },
          throughTurnRef: { id: "nope", strength: "strong" },
        },
      },
    });
    await host.done;
    expect(completed(host).error?.message).toBe(
      "The turn to fork from is not in the stored conversation.",
    );
  });
});
