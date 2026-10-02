import type {
  AttemptHost,
  AttemptStart,
  HarnessEvent,
} from "@catamorphic/agent-protocol/runner";
import { NO_CAPABILITIES } from "@catamorphic/agent-protocol/runner";
import { expect, it, vi } from "vitest";

const starts = vi.hoisted(() => [] as AttemptStart[]);
vi.mock("@catamorphic/claude-code", () => ({
  CLAUDE_CODE_CAPABILITIES: { steer: true },
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
} from "./agent-registry.js";

function registryWith(
  config: Record<string, unknown>,
  extra: Partial<Record<keyof DesktopAgentRegistryDeps, unknown>> = {},
): DesktopAgentRegistry {
  const deps = {
    profiles: {
      list: () => ({ profiles: [{ id: "profile" }] }),
      profileForProject: () => ({ id: "profile" }),
    },
    profileConfig: {
      forProfile: () => ({
        agents: { list: () => [config], get: () => config },
        connections: { list: () => [] },
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
    blocked.harness.adapter.start(
      {} as AttemptStart,
      {} as AttemptHost,
    ),
  ).toThrow("Approve it first.");
});
