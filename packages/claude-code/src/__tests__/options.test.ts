import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttemptStart } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { classifyClaudeError } from "../errors.js";
import { buildQueryOptions, readAttemptOptions } from "../options.js";
import { askUserAnswerInput } from "../questions.js";
import { hostSessionStore } from "../session-store.js";

function attempt(overrides: Partial<AttemptStart> = {}): AttemptStart {
  return {
    protocol: 1,
    sessionId: "session",
    projectId: "project",
    turnId: "turn",
    attemptId: "attempt",
    reason: "initial",
    harness: "claude-code",
    workingDirectory: "/work",
    stateDirectory: "/state",
    thread: {
      mode: "fresh",
      providerThreadId: "6f0f4c3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f",
    },
    input: { itemId: "item", text: "Hi", attachments: [] },
    systemPrompt: "",
    context: "",
    permissions: {},
    modelAccess: { kind: "host" },
    toolPolicies: {},
    toolAnnotations: {},
    mcpServers: {},
    hostTools: [],
    plugins: [],
    env: {},
    options: {},
    ...overrides,
  };
}

function options(start: AttemptStart) {
  return buildQueryOptions({
    attempt: start,
    options: readAttemptOptions(start.options),
    hostServers: {},
    canUseTool: async () => ({ behavior: "deny", message: "no" }),
    onElicitation: async () => ({ action: "cancel" }),
    hooks: {},
    sessionStore: {
      append: async () => {},
      load: async () => null,
    },
    abortController: new AbortController(),
    stderr: () => {},
  });
}

describe("model access", () => {
  it("reaches the gateway with the grant read by the key helper, and nothing of the host", () => {
    process.env.WORK_TEST_HOST_SECRET = "host-only";
    try {
      const built = options(
        attempt({
          modelAccess: {
            kind: "gateway",
            api: "anthropic",
            baseUrl: "https://gateway.test/anthropic",
            keyFile: "/state/grant",
          },
          env: { EXTRA: "1" },
        }),
      );
      expect(built.env?.ANTHROPIC_BASE_URL).toBe(
        "https://gateway.test/anthropic",
      );
      expect(built.env?.WORK_MODEL_KEY_FILE).toBe("/state/grant");
      expect(built.env?.EXTRA).toBe("1");
      expect(built.env?.WORK_TEST_HOST_SECRET).toBeUndefined();
      expect(built.env?.PATH).toBe(process.env.PATH);
      expect(built.settings).toEqual({
        apiKeyHelper: 'cat "$WORK_MODEL_KEY_FILE"',
      });
      expect(built.pathToClaudeCodeExecutable).toBe("claude");
    } finally {
      delete process.env.WORK_TEST_HOST_SECRET;
    }
  });

  it("gives the CLI the session's secrets the runner read, under Work's own settings (ADR 0206)", () => {
    const built = options(
      attempt({
        modelAccess: {
          kind: "gateway",
          api: "anthropic",
          baseUrl: "https://gateway.test/anthropic",
          keyFile: "/state/grant",
        },
        envFiles: [
          "/workspace/.work-session/env/gateway.sh",
          "/workspace/.work-session/env/secrets.sh",
        ],
        // What the runner adds from the file before the adapter starts.
        env: {
          CLICKHOUSE_API_KEY: "ch-key",
          BASH_ENV: "/workspace/.work-session/env/secrets.sh",
          ANTHROPIC_BASE_URL: "https://elsewhere.test",
        },
      }),
    );
    expect(built.env?.CLICKHOUSE_API_KEY).toBe("ch-key");
    expect(built.env?.BASH_ENV).toBe("/workspace/.work-session/env/secrets.sh");
    expect(built.env?.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.test/anthropic",
    );
  });

  it("refuses a gateway that speaks another API", () => {
    expect(() =>
      options(
        attempt({
          modelAccess: {
            kind: "gateway",
            api: "openai",
            baseUrl: "x",
            keyFile: "y",
          },
        }),
      ),
    ).toThrow(/Anthropic API/);
  });

  it("runs a member's own sign-in from its home, with no gateway", () => {
    const built = options(
      attempt({
        modelAccess: { kind: "sign_in", home: "/members/ada/claude" },
      }),
    );
    expect(built.env?.CLAUDE_CONFIG_DIR).toBe("/members/ada/claude");
    expect(built.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(built.settings).toBeUndefined();
  });

  it("keeps the host's own environment and bundled CLI on the host", () => {
    process.env.WORK_TEST_HOST_VALUE = "kept";
    try {
      const built = options(
        attempt({ env: { CLAUDE_CONFIG_DIR: "/agent-home" } }),
      );
      expect(built.env?.WORK_TEST_HOST_VALUE).toBe("kept");
      expect(built.env?.CLAUDE_CONFIG_DIR).toBe("/agent-home");
      expect(built.pathToClaudeCodeExecutable).toBeUndefined();
      // The host's own switches stay its own.
      expect(built.env?.DISABLE_AUTOUPDATER).toBe(
        process.env.DISABLE_AUTOUPDATER,
      );
    } finally {
      delete process.env.WORK_TEST_HOST_VALUE;
    }
  });

  it("keeps an inherited API key from outranking the host's sign-in", () => {
    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      configDir: process.env.CLAUDE_CONFIG_DIR,
    };
    // No Claude settings of this machine's own route the CLI.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-user-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.ANTHROPIC_API_KEY = "sk-ant-inherited";
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      expect(options(attempt()).env?.ANTHROPIC_API_KEY).toBeUndefined();
      // The agent's own key is the host's choice.
      expect(
        options(attempt({ env: { ANTHROPIC_API_KEY: "sk-ant-agent" } })).env
          ?.ANTHROPIC_API_KEY,
      ).toBe("sk-ant-agent");
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
      expect(options(attempt()).env?.ANTHROPIC_API_KEY).toBeUndefined();
      // A key for the endpoint the host routes Claude Code to is that
      // endpoint's, not a stand-in for the sign-in.
      process.env.ANTHROPIC_BASE_URL = "https://llm-gateway.example.com";
      expect(options(attempt()).env?.ANTHROPIC_API_KEY).toBe(
        "sk-ant-inherited",
      );
    } finally {
      for (const [name, value] of [
        ["ANTHROPIC_API_KEY", saved.key],
        ["ANTHROPIC_BASE_URL", saved.baseUrl],
        ["CLAUDE_CONFIG_DIR", saved.configDir],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("keeps a credential for the gateway the CLI is routed to, wherever the route is set", () => {
    const names = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CONFIG_DIR",
    ] as const;
    const saved = names.map((name) => [name, process.env[name]] as const);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-route-"));
    const settings = (directory: string, env: Record<string, string>) => {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "settings.json"),
        JSON.stringify({ env }),
      );
    };
    const gateway = { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" };
    const env = (start: AttemptStart) => options(start).env ?? {};
    try {
      for (const name of names) delete process.env[name];
      process.env.ANTHROPIC_API_KEY = "sk-ant-inherited";
      process.env.ANTHROPIC_AUTH_TOKEN = "token-inherited";
      process.env.CLAUDE_CONFIG_DIR = path.join(root, "user");
      const project = path.join(root, "project");
      fs.mkdirSync(project);
      // Routed nowhere but Anthropic: neither credential outranks the sign-in.
      expect(env(attempt({ workingDirectory: project }))).not.toHaveProperty(
        "ANTHROPIC_API_KEY",
      );
      expect(env(attempt({ workingDirectory: project }))).not.toHaveProperty(
        "ANTHROPIC_AUTH_TOKEN",
      );
      // Routed by the attempt's env.
      expect(
        env(attempt({ workingDirectory: project, env: gateway }))
          .ANTHROPIC_API_KEY,
      ).toBe("sk-ant-inherited");
      // Routed by the project's Claude settings.
      settings(path.join(project, ".claude"), gateway);
      expect(env(attempt({ workingDirectory: project }))).toMatchObject({
        ANTHROPIC_API_KEY: "sk-ant-inherited",
        ANTHROPIC_AUTH_TOKEN: "token-inherited",
      });
      fs.rmSync(path.join(project, ".claude"), { recursive: true });
      // Routed by the user's Claude settings, in CLAUDE_CONFIG_DIR.
      settings(path.join(root, "user"), gateway);
      expect(
        env(attempt({ workingDirectory: project })).ANTHROPIC_API_KEY,
      ).toBe("sk-ant-inherited");
      // Local settings back on Anthropic win over a user-level gateway.
      fs.mkdirSync(path.join(project, ".claude"));
      fs.writeFileSync(
        path.join(project, ".claude", "settings.local.json"),
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        }),
      );
      expect(env(attempt({ workingDirectory: project }))).not.toHaveProperty(
        "ANTHROPIC_API_KEY",
      );
      // A worktree reads local settings from its main checkout, where the
      // git-ignored file lives.
      fs.rmSync(path.join(root, "user"), { recursive: true });
      const main = path.join(root, "main");
      const linked = path.join(main, ".git", "worktrees", "chat");
      fs.mkdirSync(linked, { recursive: true });
      fs.writeFileSync(path.join(linked, "commondir"), "../..\n");
      const worktree = path.join(root, "chat");
      fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
      fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${linked}\n`);
      expect(
        env(attempt({ workingDirectory: path.join(worktree, "src") })),
      ).not.toHaveProperty("ANTHROPIC_API_KEY");
      fs.mkdirSync(path.join(main, ".claude"));
      fs.writeFileSync(
        path.join(main, ".claude", "settings.local.json"),
        JSON.stringify({ env: gateway }),
      );
      expect(
        env(attempt({ workingDirectory: path.join(worktree, "src") }))
          .ANTHROPIC_API_KEY,
      ).toBe("sk-ant-inherited");
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tools", () => {
  it("removes shell and edits in plan mode, and what the host owns", () => {
    const built = options(
      attempt({
        permissions: { permissionMode: "plan" },
        options: {
          hostOwnsTodos: true,
          hostOwnsSubagents: true,
          hostOwnsBackground: true,
          disableNativeMonitors: true,
        },
      }),
    );
    expect(built.permissionMode).toBe("plan");
    for (const tool of [
      "Bash",
      "Edit",
      "Write",
      "TodoWrite",
      "Task",
      "Agent",
      "Monitor",
      "TaskOutput",
    ])
      expect(built.disallowedTools).toContain(tool);
    expect(built.allowedTools).not.toContain("Bash");
    expect(built.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
  });

  it("allows an unpoliced MCP server whole and sends a policed one's tools to canUseTool", () => {
    const built = options(
      attempt({
        mcpServers: {
          open: { transport: "http", url: "https://open.test/mcp" },
          guarded: { transport: "stdio", command: "guarded" },
        },
        toolPolicies: { guarded: [{ default: "ask" }] },
        hostTools: [
          {
            name: "read_tab",
            description: "Read a tab",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(built.allowedTools).toContain("mcp__open");
    expect(built.allowedTools).not.toContain("mcp__guarded");
    expect(built.allowedTools).toContain("mcp__workspace__read_tab");
    expect(built.mcpServers?.open).toEqual({
      type: "http",
      url: "https://open.test/mcp",
    });
  });

  it("defaults to acceptEdits, then the agent's own default", () => {
    expect(options(attempt()).permissionMode).toBe("acceptEdits");
    expect(
      options(attempt({ options: { permissionMode: "dontAsk" } }))
        .permissionMode,
    ).toBe("dontAsk");
    const bypass = options(
      attempt({
        permissions: { permissionMode: "bypassPermissions" },
        modelAccess: { kind: "sign_in", home: "/h" },
      }),
    );
    expect(bypass.allowDangerouslySkipPermissions).toBe(true);
    expect(bypass.env?.IS_SANDBOX).toBe("1");
  });
});

describe("threads", () => {
  it("creates, resumes and forks by the attempt's binding", () => {
    expect(options(attempt()).sessionId).toBe(
      "6f0f4c3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f",
    );
    const resumed = options(
      attempt({
        thread: {
          mode: "restore",
          providerThreadId: "p",
          nativeRef: { id: "native-1", strength: "strong" },
        },
      }),
    );
    expect(resumed.resume).toBe("native-1");
    expect(resumed.sessionId).toBeUndefined();
    const forked = options(
      attempt({
        thread: {
          mode: "fork",
          providerThreadId: "p2",
          source: { id: "native-1", strength: "strong" },
          throughTurnRef: { id: "assistant-uuid", strength: "strong" },
        },
      }),
    );
    expect(forked).toMatchObject({
      resume: "native-1",
      forkSession: true,
      resumeSessionAt: "assistant-uuid",
    });
  });

  it("stores a transcript in call order, naming only foreign threads", async () => {
    const calls: Array<{ thread?: string; entries: number }> = [];
    const store = hostSessionStore({
      nativeState: {
        append: async ({ thread, entries }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          calls.push({
            ...(thread ? { thread } : {}),
            entries: entries.length,
          });
        },
        load: async ({ thread }) =>
          thread === "source" ? [{ type: "user" }, 3] : null,
        subpaths: async () => [],
      },
      threadFor: (sessionId) => (sessionId === "own" ? undefined : sessionId),
    });
    const big = { type: "assistant", text: "x".repeat(200 * 1024) };
    void store.append({ projectKey: "p", sessionId: "own" }, [big, big]);
    await store.append({ projectKey: "p", sessionId: "own" }, [
      { type: "last-prompt" },
    ]);
    expect(calls).toEqual([{ entries: 2 }, { entries: 1 }]);
    expect(await store.load({ projectKey: "p", sessionId: "source" })).toEqual([
      { type: "user" },
    ]);
    expect(await store.load({ projectKey: "p", sessionId: "own" })).toBeNull();
  });
});

describe("answers and errors", () => {
  const toolInput = {
    questions: [
      {
        question: "Which theme?",
        header: "Theme",
        options: [],
        multiSelect: false,
      },
      {
        question: "Which font?",
        header: "Font",
        options: [],
        multiSelect: false,
      },
    ],
  };

  it("maps answers to their questions, and keeps unmatched words as a response", () => {
    expect(
      askUserAnswerInput({ toolInput, answers: ["Orange", "Serif"] }),
    ).toMatchObject({
      answers: { "Which theme?": "Orange", "Which font?": "Serif" },
    });
    expect(
      askUserAnswerInput({
        toolInput,
        answers: ["Which theme?\n→ Blue\n\nWhich font?\n→ Mono"],
      }),
    ).toMatchObject({
      answers: { "Which theme?": "Blue", "Which font?": "Mono" },
    });
    const free = askUserAnswerInput({ toolInput, answers: ["Surprise me"] });
    expect(free).toMatchObject({ answers: {}, response: "Surprise me" });
  });

  it("classifies provider failures", () => {
    expect(
      classifyClaudeError({ message: "x", sdkError: "authentication_failed" }),
    ).toBe("auth");
    expect(
      classifyClaudeError({ message: "API Error: 429 rate limited" }),
    ).toBe("rate_limit");
    expect(classifyClaudeError({ message: "Overloaded" })).toBe("unavailable");
    expect(
      classifyClaudeError({
        message: "messages.1: invalid signature in thinking block",
      }),
    ).toBe("model_incompat");
    expect(
      classifyClaudeError({ message: "Tool Bash said 401 Unauthorized" }),
    ).toBeUndefined();
  });
});
