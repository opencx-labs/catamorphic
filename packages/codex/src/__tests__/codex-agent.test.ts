import { access, readFile } from "node:fs/promises";
import type {
  ProviderSession,
  SandboxProvider,
  TurnOptions,
} from "@catamorphic/sandbox";
import type { ThreadEvent } from "@openai/codex-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startThread = vi.fn();
const resumeThread = vi.fn();
const codexCtor = vi.fn();
const setContext = vi.fn();

vi.mock("../app-server.js", () => ({
  CodexAppServer: class {
    setContext = setContext;
    available = true;
    close = vi.fn();
    constructor(options: unknown) {
      codexCtor(options);
    }
    startThread = startThread;
    resumeThread = resumeThread;
  },
}));

import { CodexAgent, sandboxPathEnv } from "../codex-agent.js";

/** A sandbox whose operations are never reached in these tests. */
function fakeSandboxProvider(withProcesses: boolean): SandboxProvider {
  const never = () => Promise.reject(new Error("not in this test"));
  return {
    workspaceRoot: "/workspace",
    createSandbox: never,
    startSandbox: never,
    stopSandbox: never,
    destroySandbox: never,
    getSandboxStatus: never,
    // A process provider maps the virtual workspace onto a host folder.
    executeCommand: async (_sandboxId, command, opts) =>
      command === "pwd -P" && opts?.cwd
        ? {
            exitCode: 0,
            result: `${opts.cwd.replace("/workspace", "/host/sandbox-1/workspace")}\n`,
          }
        : never(),
    uploadFiles: never,
    downloadFile: never,
    gitClone: never,
    gitCheckout: never,
    ...(withProcesses
      ? {
          processes: {
            startProcess: never,
            readProcessOutput: never,
            signalProcess: never,
            listProcesses: never,
            writeProcessInput: never,
          },
        }
      : {}),
  };
}

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
  turn?: TurnOptions,
) {
  const events = [];
  for await (const event of agent.sendMessage(providerSession, message, turn)) {
    events.push(event);
  }
  return events;
}

describe("CodexAgent", () => {
  beforeEach(() => {
    startThread.mockReset();
    resumeThread.mockReset();
    codexCtor.mockReset();
    setContext.mockReset();
  });

  it("enables native approval requests for a host with only a tool-permission handler", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([{ type: "turn.completed", usage: dummyUsage() }]),
    );
    const agent = new CodexAgent({
      onToolPermission: async () => ({ decision: "deny" }),
    });
    await collect(agent, "continue");
    expect(resumeThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({ approvalPolicy: "on-request" }),
    );
    await agent.dispose(session);
  });

  it("defaults to workspace-write without approvals on the host", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([{ type: "turn.completed", usage: dummyUsage() }]),
    );
    const agent = new CodexAgent({});
    await collect(agent, "continue");
    expect(resumeThread).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      }),
    );
    await agent.dispose(session);
  });

  it("honors the configured sandbox and approvals, and a turn's own (ADR 0182)", async () => {
    resumeThread.mockReturnValue(
      scriptedThread([{ type: "turn.completed", usage: dummyUsage() }]),
    );
    const agent = new CodexAgent({
      sandboxMode: "danger-full-access",
      approvalPolicy: "untrusted",
      onToolPermission: async () => ({ decision: "deny" }),
    });
    await collect(agent, "continue");
    expect(resumeThread).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({
        sandboxMode: "danger-full-access",
        approvalPolicy: "untrusted",
      }),
    );
    await collect(agent, "continue", session, {
      harnessPermissions: {
        sandbox: "read-only",
        approvals: "on-failure",
        permissionMode: "bypassPermissions",
      },
    });
    expect(resumeThread).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({
        sandboxMode: "read-only",
        approvalPolicy: "on-failure",
      }),
    );
    await agent.dispose(session);
  });

  it("runs the app server in the turn's sandbox with the gateway as its model provider (ADR 0180)", async () => {
    startThread.mockReturnValue(
      scriptedThread([
        { type: "thread.started", thread_id: "thread-9" },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            cache_write_input_tokens: 0,
          },
        },
      ]),
    );
    const agent = new CodexAgent({ sandbox: {}, apiKey: "host-key" });
    const events = [];
    for await (const event of agent.sendMessage(
      { ...session, providerSessionId: null },
      "hello",
      {
        sandbox: {
          provider: fakeSandboxProvider(true),
          sandboxId: "sandbox-1",
          stateDirectory: "/workspace/.work-session",
        },
        modelGateway: {
          alias: "openai",
          api: "openai",
          baseUrl: "https://work.example.test/api/gateway/model/openai",
          keyFile: "/workspace/.work-session/grants/openai",
        },
      },
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const options = codexCtor.mock.calls[0]?.[0];
    // No host key and no host environment: the gateway is the provider.
    expect(options).not.toHaveProperty("apiKey");
    expect(options).not.toHaveProperty("env");
    expect(options.codexPathOverride).toBe("codex");
    expect(options.config).toMatchObject({
      model_provider: "work",
      model_providers: {
        work: {
          base_url: "https://work.example.test/api/gateway/model/openai",
          wire_api: "responses",
          auth: { command: "sh", args: ["-c", 'cat "$WORK_MODEL_KEY_FILE"'] },
        },
      },
    });
  });

  it("runs the app server with the owner's own login and Codex's own provider (ADR 0184)", async () => {
    startThread.mockReturnValue(
      scriptedThread([
        { type: "thread.started", thread_id: "thread-10" },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            cache_write_input_tokens: 0,
          },
        },
      ]),
    );
    const agent = new CodexAgent({ sandbox: {}, apiKey: "host-key" });
    const events = [];
    for await (const event of agent.sendMessage(
      { ...session, providerSessionId: null },
      "hello",
      {
        sandbox: {
          provider: fakeSandboxProvider(true),
          sandboxId: "sandbox-1",
          stateDirectory: "/workspace/.work-session",
        },
        personalLogin: {
          harness: "codex",
          home: "/workspace/.work-session/home/codex",
        },
      },
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    // Codex hears the directory as the sandbox's processes name it.
    expect(startThread.mock.calls[0]?.[0]).toMatchObject({
      workingDirectory: "/host/sandbox-1/workspace/project",
    });
    const options = codexCtor.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("apiKey");
    expect(options).not.toHaveProperty("env");
    expect(options.config?.model_provider).toBeUndefined();
    expect(options.config?.model_providers).toBeUndefined();
    expect(
      sandboxPathEnv({
        auth: { kind: "personal", home: "/workspace/.work-session/home/codex" },
      }),
    ).toEqual({ CODEX_HOME: "/workspace/.work-session/home/codex" });
  });

  it("continues a moved sandbox session from the host's transcript", async () => {
    startThread.mockReturnValue(
      scriptedThread([{ type: "turn.completed", usage: dummyUsage() }]),
    );
    const agent = new CodexAgent({ sandbox: {} });
    const started = await agent.startSession({
      projectId: "project-1",
      userId: "member",
      sandboxId: "sandbox-2",
      workingDirectory: "/workspace/project",
      sessionId: "chat-moved",
      history: [
        { role: "user", content: "Remember the word OSPREY." },
        { role: "assistant", content: "Remembered: OSPREY." },
      ],
    });
    await collect(agent, "What word?", started, {
      sandbox: {
        provider: fakeSandboxProvider(true),
        sandboxId: "sandbox-2",
        stateDirectory: "/workspace/.work-session",
      },
      personalLogin: {
        harness: "codex",
        home: "/workspace/.work-session/home/codex",
      },
    });
    expect(setContext).toHaveBeenCalledWith(
      expect.stringContaining("User: Remember the word OSPREY."),
    );
  });

  it("refuses a sandbox turn whose sandbox cannot run processes", async () => {
    const agent = new CodexAgent({ sandbox: {} });
    const events = [];
    for await (const event of agent.sendMessage(session, "hello", {
      sandbox: {
        provider: fakeSandboxProvider(false),
        sandboxId: "sandbox-1",
        stateDirectory: "/workspace/.work-session",
      },
    }))
      events.push(event);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(String(events[0]?.content)).toContain("cannot run it");
    expect(codexCtor).not.toHaveBeenCalled();
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

  it("settles a failed turn with an error and terminal event", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        { type: "turn.failed", error: { message: "Permission denied" } },
      ]),
    );
    expect(await collect(new CodexAgent(), "write the file")).toEqual([
      { type: "error", content: "Permission denied" },
      { type: "done" },
    ]);
  });

  it("keeps recovered stream retries out of the durable failure state", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        { type: "error", message: "Reconnecting... 2/5" },
        { type: "turn.completed", usage: dummyUsage() },
      ]),
    );
    const events = await collect(new CodexAgent(), "continue");
    expect(events).toContainEqual({
      type: "diagnostic",
      content: "Reconnecting... 2/5",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("fails an incomplete stream even if the process exits without throwing", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([{ type: "error", message: "Connection closed" }]),
    );
    const events = await collect(new CodexAgent(), "continue");
    expect(events).toContainEqual({
      type: "error",
      content: "Connection closed",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("delivers image bytes to resumed turns and removes staged files afterwards", async () => {
    let imagePath: string | undefined;
    resumeThread.mockReturnValueOnce({
      runStreamed: async (
        input: Array<{ type: string; path?: string; text?: string }>,
      ) => {
        imagePath = input.find((item) => item.type === "local_image")?.path;
        expect(imagePath).toBeDefined();
        expect(await readFile(imagePath ?? "", "utf8")).toBe("image bytes");
        expect(input[0]?.text).not.toContain("not delivered");
        return scriptedThread([
          { type: "turn.completed", usage: dummyUsage() },
        ]).runStreamed();
      },
    });
    for await (const _event of new CodexAgent().sendMessage(
      session,
      "Inspect this",
      {
        attachments: [
          {
            kind: "image",
            name: "../../unsafe.png",
            mediaType: "image/png",
            dataBase64: Buffer.from("image bytes").toString("base64"),
          },
        ],
      },
    )) {
      /* consume the turn */
    }
    await expect(access(imagePath ?? "")).rejects.toThrow();
  });

  it("removes staged attachments when startup fails", async () => {
    let imagePath: string | undefined;
    resumeThread.mockReturnValueOnce({
      runStreamed: async (input: Array<{ type: string; path?: string }>) => {
        imagePath = input.find((item) => item.type === "local_image")?.path;
        throw new Error("Spawn failed");
      },
    });
    for await (const _event of new CodexAgent().sendMessage(
      session,
      "Inspect",
      {
        attachments: [
          {
            kind: "image",
            name: "x.png",
            mediaType: "image/png",
            dataBase64: "eA==",
          },
        ],
      },
    )) {
      /* consume the turn */
    }
    expect(imagePath).toBeDefined();
    await expect(access(imagePath ?? "")).rejects.toThrow();
  });

  it("turns reasoning summary headings into the live status", async () => {
    resumeThread.mockReturnValueOnce(
      scriptedThread([
        {
          type: "item.completed",
          item: {
            id: "reasoning_1",
            type: "reasoning",
            text: "**Reviewing database migrations**\n\nI should read the schema first.",
          },
        },
        { type: "turn.completed", usage: dummyUsage() },
      ]),
    );
    const events = await collect(new CodexAgent(), "check the migrations");
    expect(events[0]).toEqual({
      type: "status",
      content: "Reviewing database migrations",
    });
  });

  it("reports command start and end on the same step", async () => {
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
    expect(events.slice(0, 2)).toEqual([
      {
        type: "command",
        content: "bun test",
        status: "started",
        toolUseId: "item_3",
      },
      {
        type: "command",
        content: "bun test\nok",
        status: "ended",
        toolUseId: "item_3",
      },
    ]);
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
      new CodexAgent({
        disableNativeSubagents: true,
        disableNativeGoals: true,
      }),
      "Delegate this review",
    );

    expect(codexCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { features: { multi_agent: false, goals: false } },
      }),
    );
  });

  it("aborts an in-flight SDK turn when the host interrupts it", async () => {
    let turnSignal: AbortSignal | undefined;
    startThread.mockReturnValueOnce({
      runStreamed: async (
        _input: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        turnSignal = options?.signal;
        return {
          events: (async function* () {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                reject(new Error("Turn aborted"));
              });
            });
          })(),
        };
      },
    });
    const agent = new CodexAgent();

    const collecting = collect(agent, "Keep working", {
      ...session,
      providerSessionId: null,
    });
    await vi.waitFor(() => expect(turnSignal).toBeDefined());
    agent.interrupt("chat-1");

    await expect(collecting).resolves.toEqual([
      { type: "error", content: "Turn aborted" },
      { type: "done" },
    ]);
    expect(turnSignal?.aborted).toBe(true);
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

  it("refreshes host context separately from user messages and defers capability discovery", async () => {
    const capabilities = {
      discover: vi.fn(async () => ({ items: [] })),
      invoke: vi.fn(async () => ({})),
    };
    const delivered: unknown[] = [];
    resumeThread.mockImplementation(() => ({
      runStreamed: async (
        input: string | Array<{ type: string; text?: string }>,
        run: { turnOptions?: { context?: unknown } },
      ) => {
        expect(typeof input === "string" ? input : input[0]?.text).toBe(
          "hello",
        );
        delivered.push(run.turnOptions?.context);
        return turnDone().runStreamed();
      },
    }));
    const agent = new CodexAgent();
    for (const text of ["Host A", "Host B"]) {
      const context = [{ source: "session", trust: "host" as const, text }];
      for await (const _event of agent.sendMessage(session, "hello", {
        context,
        capabilities,
      })) {
        /* drain */
      }
      // Stable instructions stay developer instructions; the turn's
      // context rides turn/start beside the message (ADR 0152).
      expect(setContext).toHaveBeenLastCalledWith(undefined);
      expect(delivered.at(-1)).toEqual(context);
      expect(codexCtor.mock.calls.at(-1)?.[0]).toMatchObject({
        config: {
          mcp_servers: {
            catamorphic_capabilities: {
              default_tools_approval_mode: "approve",
              url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
            },
          },
        },
      });
    }
    expect(capabilities.discover).not.toHaveBeenCalled();
    expect(capabilities.invoke).not.toHaveBeenCalled();
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
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}
