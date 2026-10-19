import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttemptHost,
  AttemptStart,
  HarnessEvent,
} from "@catamorphic/agent-protocol/runner";
import { NO_CAPABILITIES } from "@catamorphic/agent-protocol/runner";
import {
  definitionHash,
  steeredTurnId,
  validateAgentDefinition,
} from "@catamorphic/core";
import { PROJECT_AGENTS_DIR } from "@catamorphic/workflow/project-layout";
import { afterEach, describe, expect, it, vi } from "vitest";

const starts = vi.hoisted(() => [] as AttemptStart[]);
vi.mock("@catamorphic/claude-code", () => ({
  CLAUDE_CODE_CAPABILITIES: { steer: true, toolSearch: true },
  createClaudeCodeAdapter: () => ({
    id: "claude-code",
    capabilities: () => ({ steer: true }),
    start: (attempt: AttemptStart, host: AttemptHost) => {
      starts.push(attempt);
      host.emit({
        type: "turn.completed",
        status: "failed",
        error: { message: "Failed to authenticate: OAuth token expired" },
      });
      return {
        steer: async () => false,
        interrupt: () => {},
        finished: Promise.resolve(),
      };
    },
  }),
}));
vi.mock("electron", () => ({ safeStorage: {} }));

import {
  DesktopAgentRegistry,
  type DesktopAgentRegistryDeps,
  SIGN_IN_RETRY_MS,
  signInOf,
} from "./agent-registry.js";

function registryWith(
  config: Record<string, unknown>,
  extra: Partial<Record<keyof DesktopAgentRegistryDeps, unknown>> = {},
  connections: unknown[] = [],
): DesktopAgentRegistry {
  const deps = {
    profiles: {
      list: () => ({ profiles: [{ id: "profile" }] }),
      profileForProject: () => ({ id: "profile" }),
    },
    profileConfig: {
      forProfile: () => ({
        agents: { list: () => [config], get: () => config },
        connections: { list: () => connections },
      }),
      forProject: () => ({
        agentBindings: { get: () => undefined },
      }),
    },
    agentHomesDir: "/tmp/catamorphic-agent-registry-test",
    harnessComponentsDir: "/unused",
    ...extra,
  } as unknown as DesktopAgentRegistryDeps;
  const registry = new DesktopAgentRegistry(deps);
  // The CLI components are downloaded on demand; a test only needs a path.
  Reflect.set(registry, "ensureNativeComponents", async () => ({
    component: { executablePath: "/bin/claude" },
    environment: { PATH: "/toolchain" },
  }));
  return registry;
}

const claudeAgent = {
  id: "claude",
  name: "Claude",
  harness: "claude-code",
  model: "",
  effort: "high",
  auth: "account",
  apiKey: null,
  memory: true,
  harnessPermissions: { permissionMode: "plan" },
};

function hostOf(registry: DesktopAgentRegistry, id: string) {
  const agent = registry.get(id);
  if (agent?.harness.placement !== "host") throw new Error("not a host agent");
  return { agent, harness: agent.harness };
}

it("registers Claude Code as a native host harness with the agent's settings", () => {
  const { agent, harness } = hostOf(registryWith(claudeAgent), "claude");
  expect(agent.topology).toBe("native");
  expect(harness.adapter.id).toBe("claude-code");
  expect(agent.options).toEqual({
    memory: true,
    disableNativeMonitors: true,
    hostOwnsTodos: true,
    hostOwnsSubagents: true,
  });
  expect(agent.defaults).toEqual({
    effort: "high",
    harnessPermissions: { permissionMode: "plan" },
  });
  expect(harness.env?.CLAUDE_CONFIG_DIR).toContain("claude");
});

it("registers an ACP agent as its own command over ACP, one harness per agent, never the scripted fake (ADR 0241)", () => {
  const hermes = {
    id: "hermes-id",
    name: "Hermes",
    harness: "acp",
    acp: { command: ["hermes", "acp"] },
    model: "",
    effort: "medium",
    auth: "local",
    apiKey: null,
  };
  const { agent, harness } = hostOf(
    registryWith(hermes, { e2eFake: true }),
    "hermes-id",
  );
  expect(harness.adapter.id).toBe("acp:hermes-id");
  expect(agent.options).toEqual({ command: ["hermes", "acp"] });
  expect(agent.defaults).toEqual({});
  // Where Hermes' installer puts it, should PATH not say.
  expect(harness.env?.PATH?.split(path.delimiter)).toContain(
    path.join(os.homedir(), ".local", "bin"),
  );
});

const projectRoots: string[] = [];
afterEach(() => {
  for (const root of projectRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/** A project folder holding one committed agent definition, `runner`. */
function projectWith(definition: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-project-"));
  projectRoots.push(root);
  const agents = path.join(root, PROJECT_AGENTS_DIR);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, "runner.json"),
    JSON.stringify(definition),
  );
  return root;
}

const runnerDefinition = {
  version: 1,
  name: "Runner",
  kind: "acp",
  acp: { command: ["sh", "-c", "echo hi"] },
} as const;

it("waits for its member's approval before running a project's ACP agent, whatever its credentials say (ADR 0241)", () => {
  const root = projectWith({
    ...runnerDefinition,
    credentials: { source: "secret", secret: "token" },
  });
  const agent = registryWith(claudeAgent, {
    projectRootPath: () => root,
  }).get("project:project:runner");
  expect(agent?.unavailable).toContain("needs your approval");
});

/** A registry where the member approved `definition`, as committed. */
function approvedRegistry(definition: Record<string, unknown>) {
  const root = projectWith(definition);
  const validated = validateAgentDefinition(definition);
  if ("error" in validated) throw new Error(validated.error);
  return registryWith(claudeAgent, {
    e2eFake: true,
    projectRootPath: () => root,
    profileConfig: {
      forProfile: () => ({
        agents: { list: () => [claudeAgent], get: () => claudeAgent },
        connections: { list: () => [] },
      }),
      forProject: () => ({
        agentBindings: {
          get: () => ({
            consentHash: definitionHash(validated.definition),
            auth: { mode: "local" },
          }),
        },
      }),
    },
  });
}

it("runs an approved project ACP agent as its own command, on a harness of its own (ADR 0241)", () => {
  const { agent, harness } = hostOf(
    approvedRegistry(runnerDefinition),
    "project:project:runner",
  );
  expect(agent.unavailable).toBeUndefined();
  expect(harness.adapter.id).toBe("acp:project:project:runner");
  expect(agent.options).toEqual({ command: ["sh", "-c", "echo hi"] });
  expect(agent.defaults).toEqual({});
});

it("says how to fix an approved project ACP agent that names no command (ADR 0241)", () => {
  const agent = approvedRegistry({
    version: 1,
    name: "Runner",
    kind: "acp",
  }).get("project:project:runner");
  expect(agent?.unavailable).toContain("is an ACP agent without a command");
});

const probeConnection = {
  id: "probe-id",
  name: "probe",
  transport: "http",
  url: "https://probe.example/mcp",
  enabled: true,
  source: { kind: "custom" },
};

const connectorMcp = {
  url: (input: { projectId: string; sessionId: string; server: string }) =>
    `http://127.0.0.1:1/${input.projectId}/${input.sessionId}/${input.server}`,
  token: (sessionId: string) => `token-${sessionId}`,
};

it("mounts each connector as its own MCP server for a harness that searches its tools", () => {
  const registry = registryWith(claudeAgent, { connectorMcp }, [
    probeConnection,
  ]);
  const { harness } = hostOf(registry, "claude");
  // Served by the host under the key its policies use; the chat's bearer,
  // never the connector's credentials.
  expect(
    harness.mcpServers?.({ projectId: "p", sessionId: "s", turnId: "t" }),
  ).toEqual({
    probe: {
      transport: "http",
      url: "http://127.0.0.1:1/p/s/probe",
      headers: { Authorization: "Bearer token-s" },
      defaultToolsApprovalMode: "approve",
      timeouts: { startupSeconds: 60, callSeconds: 3600 },
    },
  });
  // The endpoint decides its calls, so no permission mode can skip an ask.
  expect(harness.toolPolicies?.()).not.toHaveProperty("probe");
  // The capability catalog leaves mounted connectors out.
  expect(registry.capabilitySurface("claude")?.connectorsMounted).toBe(true);
  // A turn outside a chat has no chat to serve.
  expect(harness.mcpServers?.({ projectId: "p", turnId: "t" })).toEqual({});
});

it("leaves connectors in the catalog when the host cannot serve them", () => {
  const registry = registryWith(claudeAgent, {}, [probeConnection]);
  const { harness } = hostOf(registry, "claude");
  expect(
    harness.mcpServers?.({ projectId: "p", sessionId: "s", turnId: "t" }),
  ).toEqual({});
  expect(harness.toolPolicies?.()).toHaveProperty("probe");
  expect(registry.capabilitySurface("claude")?.connectorsMounted).toBe(false);
});

it("starts the downloaded executable with its toolchain and friendly errors", async () => {
  const { harness } = hostOf(registryWith(claudeAgent), "claude");
  const events: HarnessEvent[] = [];
  const control = harness.adapter.start(
    {
      options: { memory: true },
      env: { CLAUDE_CONFIG_DIR: "/home" },
    } as unknown as AttemptStart,
    {
      emit: (event: HarnessEvent) => events.push(event),
    } as unknown as AttemptHost,
  );
  await control.finished;
  expect(starts.at(-1)?.options).toEqual({
    memory: true,
    command: "/bin/claude",
  });
  expect(starts.at(-1)?.env).toEqual({
    PATH: "/toolchain",
    CLAUDE_CONFIG_DIR: "/home",
  });
  const completed = events.find((event) => event.type === "turn.completed");
  expect(completed?.type === "turn.completed" && completed.error?.kind).toBe(
    "auth",
  );
  expect(
    completed?.type === "turn.completed" && completed.error?.message,
  ).toContain('Claude Code rejected the credentials of the "Claude" agent');
});

it("does not expose settings-specific tools to agents", () => {
  const { harness } = hostOf(
    registryWith(
      {
        id: "agent",
        name: "Read only",
        harness: "ai-sdk",
        provider: "openai",
        model: "mock-model",
        effort: "medium",
        auth: "api-key",
        apiKey: "mock-only",
        sandboxing: "contained",
      },
      { workspaceBridge: {} },
    ),
    "agent",
  );
  const tools = (harness.hostTools ?? []).map((tool) => tool.name);
  expect(tools).not.toContain("get_desktop_settings");
  expect(tools).not.toContain("update_desktop_setting");
});

it("leaves the built-in agent unregistered until it has a key", () => {
  const registry = registryWith({
    id: "agent",
    name: "No key",
    harness: "ai-sdk",
    provider: "anthropic",
    model: "claude-test",
    effort: "medium",
    auth: "api-key",
    apiKey: null,
  });
  expect(registry.get("agent")).toBeUndefined();
});

it("fails an unapproved project agent's turns with the fix", () => {
  const registry = registryWith(claudeAgent, {
    projectRootPath: () => "/nonexistent-project",
  });
  // No definition file: the project agent does not exist.
  expect(registry.get("project:p1:helper")).toBeUndefined();
  const blocked = Reflect.get(registry, "failFast").call(
    registry,
    "project:p1:helper",
    "Approve it first.",
  );
  expect(blocked.harness.adapter.capabilities()).toEqual(NO_CAPABILITIES);
  expect(() =>
    blocked.harness.adapter.start({} as AttemptStart, {} as AttemptHost),
  ).toThrow("Approve it first.");
});

describe("a sign-in that can still refresh (ADR 0228)", () => {
  const localClaude = { ...claudeAgent, auth: "local" };
  const auth = {
    message: "Claude Code rejected the credentials",
    kind: "auth" as const,
    retrySafe: true,
  };
  const turn = { projectId: "p", sessionId: "s", turnId: "t" };

  it("retries an auth failure once, after a pause, while the sign-in can refresh", async () => {
    const asked: unknown[] = [];
    const { agent } = hostOf(
      registryWith(localClaude, {
        signInRefreshable: async (signIn: unknown) => {
          asked.push(signIn);
          return true;
        },
      }),
      "claude",
    );
    expect(await agent.retryFailure?.({ error: auth, ...turn })).toEqual({
      afterMs: SIGN_IN_RETRY_MS,
      activity: "Reconnecting to Claude…",
    });
    expect(asked).toEqual([
      { harness: "claude-code", auth: "local", id: "claude" },
    ]);
  });

  it("lets the turn fail when the sign-in cannot refresh, or the failure is not about it", async () => {
    const refreshable = vi.fn(async () => false);
    const { agent } = hostOf(
      registryWith(localClaude, { signInRefreshable: refreshable }),
      "claude",
    );
    expect(
      await agent.retryFailure?.({ error: auth, ...turn }),
    ).toBeUndefined();
    refreshable.mockResolvedValue(true);
    expect(
      await agent.retryFailure?.({
        error: { message: "Overloaded", kind: "unavailable", retrySafe: true },
        ...turn,
      }),
    ).toBeUndefined();
    expect(
      await agent.retryFailure?.({
        error: { message: "Something else", retrySafe: true },
        ...turn,
      }),
    ).toBeUndefined();
  });

  it("asks nothing of agents on keys", () => {
    const { agent } = hostOf(
      registryWith(
        { ...claudeAgent, auth: "api-key", apiKey: "key" },
        { signInRefreshable: async () => true },
      ),
      "claude",
    );
    expect(agent.retryFailure).toBeUndefined();
    expect(signInOf({ id: "claude", harness: "ai-sdk", auth: "account" })).toBe(
      undefined,
    );
  });

  it("gives the retry's Claude Code a debug log only this user can read", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sign-in-logs-"));
    try {
      const registry = registryWith(localClaude, {
        signInRefreshable: async () => true,
        logsDir,
      });
      const { agent, harness } = hostOf(registry, "claude");
      await agent.retryFailure?.({ error: auth, ...turn });
      const start = (reason: string) =>
        harness.adapter.start(
          {
            turnId: "t",
            reason,
            options: {},
            env: {},
          } as unknown as AttemptStart,
          { emit: () => {} } as unknown as AttemptHost,
        ).finished;
      await start("retry");
      const debugFile = starts.at(-1)?.options.debugFile;
      expect(typeof debugFile).toBe("string");
      expect(String(debugFile).startsWith(path.join(logsDir, "sign-in"))).toBe(
        true,
      );
      expect(fs.statSync(String(debugFile)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(logsDir, "sign-in")).mode & 0o777).toBe(
        0o700,
      );
      // Only that retry: the next attempt runs without one.
      await start("retry");
      expect(starts.at(-1)?.options.debugFile).toBeUndefined();
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});

describe("the assistant sees where the person is (ADR 0265)", () => {
  const assistantOf = () => {
    const asked: string[] = [];
    const registry = registryWith(claudeAgent, {
      workspaceBridge: {
        overview: async (projectId: string) => {
          asked.push(projectId);
          return {
            tabs: [
              {
                key: `browser:${projectId}`,
                kind: "browser",
                active: true,
                title: `${projectId} pull request`,
              },
            ],
          };
        },
        glanceBrowser: async () => ({}),
        backgroundCommands: () => [],
      },
      projectName: async (projectId: string) => projectId,
      projectRootPath: (projectId: string) => `/work/${projectId}`,
    });
    const { harness } = hostOf(registry, "work-assistant:claude");
    const context = async (turnId = "turn") =>
      (
        (await harness.context?.({
          projectId: "opencx",
          sessionId: "assistant",
          turnId,
        })) ?? []
      )
        .map((fragment) => fragment.text)
        .join("\n");
    return { registry, asked, context };
  };

  it("names the project in front of the person's window, and shows that window", async () => {
    const { registry, asked, context } = assistantOf();
    registry.setPersonPlace(() => "catamorphic");
    const text = await context();
    expect(text).toContain("Project: catamorphic\nFolder: /work/catamorphic");
    expect(text).toContain("This chat is kept in another project");
    expect(text).toContain("catamorphic pull request");
    expect(text).not.toContain("opencx pull request");
    expect(asked).toEqual(["catamorphic"]);
  });

  it("by voice, sees where they were and what was on screen as they started speaking", async () => {
    const { registry, asked, context } = assistantOf();
    registry.setPersonPlace(() => "website");
    registry.setVoice({
      talking: () => true,
      sight: () => ({
        at: Date.now() - 3_000,
        said: "why is this PR not merged",
        heardAt: Date.now(),
        projectId: "catamorphic",
        app: Promise.resolve(null),
        screen: Promise.resolve(
          'The person is looking at: web page "Pull request #267"',
        ),
        picture: Promise.resolve(null),
      }),
      stopListening: () => false,
    });
    const text = await context();
    expect(text).toContain("As the person started saying their latest message");
    expect(text).toContain("Project: catamorphic");
    expect(text).toContain("Pull request #267");
    expect(text).not.toContain("website");
    expect(asked).toEqual([]);
  });

  it("sees what they saw in the turn a message talked over the end of a turn runs as", async () => {
    const { registry, context } = assistantOf();
    registry.setPersonPlace(() => "website");
    const turnId = steeredTurnId("ending-turn", "spoken-item");
    registry.setVoice({
      talking: () => true,
      sight: () => ({
        at: Date.now() - 40_000,
        said: "and the other one",
        heardAt: Date.now() - 38_000,
        turnIds: ["ending-turn", turnId],
        projectId: "catamorphic",
        app: Promise.resolve(null),
        screen: Promise.resolve("Pull request #267"),
        picture: Promise.resolve(null),
      }),
      stopListening: () => false,
    });
    expect(await context(turnId)).toContain("Pull request #267");
  });

  it("sees the screen as it is for a turn the spoken message did not start", async () => {
    const { registry, asked, context } = assistantOf();
    registry.setPersonPlace(() => "website");
    registry.setVoice({
      talking: () => true,
      sight: () => ({
        at: Date.now() - 60_000,
        said: "why is this PR not merged",
        heardAt: Date.now() - 58_000,
        // That message went to an earlier turn.
        turnIds: ["spoken-turn"],
        projectId: "catamorphic",
        app: Promise.resolve(null),
        screen: Promise.resolve("Pull request #267"),
        picture: Promise.resolve(null),
      }),
      stopListening: () => false,
    });
    const text = await context();
    expect(text).toContain("Project: website");
    expect(text).not.toContain("Pull request #267");
    expect(asked).toEqual(["website"]);
  });

  it("lists no chats of its chat's project as the person's, and can load what they saw", async () => {
    const peers = vi.fn(async () => [
      {
        id: "peer",
        title: "OpenCX deploy",
        agentId: null,
        running: true,
        task: null,
        activity: null,
        checkout: { kind: "primary" as const, branch: null },
      },
    ]);
    const registry = registryWith(claudeAgent, {
      workspaceBridge: {
        overview: async () => ({ tabs: [] }),
        backgroundCommands: () => [],
      },
      sessionPeers: peers,
    });
    const { harness } = hostOf(registry, "work-assistant:claude");
    const text = (
      (await harness.context?.({
        projectId: "opencx",
        sessionId: "assistant",
        turnId: "turn",
      })) ?? []
    )
      .map((fragment) => fragment.text)
      .join("\n");
    expect(text).not.toContain("OpenCX deploy");
    expect((harness.hostTools ?? []).map((tool) => tool.name)).toContain(
      "screen_when_spoken",
    );
    // Its base agent still sees its own project's chats.
    const base = hostOf(registry, "claude").harness;
    const own = (
      (await base.context?.({
        projectId: "opencx",
        sessionId: "chat",
        turnId: "turn",
      })) ?? []
    )
      .map((fragment) => fragment.text)
      .join("\n");
    expect(own).toContain("OpenCX deploy");
  });

  it("is the only agent whose screen follows the person", async () => {
    const registry = registryWith(claudeAgent, {
      workspaceBridge: {
        overview: async (projectId: string) => ({
          tabs: [
            {
              key: "browser:x",
              kind: "browser",
              active: true,
              title: projectId,
            },
          ],
        }),
        glanceBrowser: async () => ({}),
        backgroundCommands: () => [],
      },
    });
    registry.setPersonPlace(() => "catamorphic");
    const { harness } = hostOf(registry, "claude");
    const text = (
      (await harness.context?.({
        projectId: "opencx",
        sessionId: "chat",
        turnId: "turn",
      })) ?? []
    )
      .map((fragment) => fragment.text)
      .join("\n");
    expect(text).toContain('"opencx"');
    expect(text).not.toContain("Project:");
  });
});
