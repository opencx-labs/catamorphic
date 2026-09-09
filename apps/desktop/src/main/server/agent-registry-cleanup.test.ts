import { expect, it, vi } from "vitest";

const build = vi.hoisted(() => vi.fn());
vi.mock("./coding-agent.js", () => ({ buildAiSdkAgent: build }));
vi.mock("electron", () => ({ safeStorage: {} }));

import {
  DesktopAgentRegistry,
  type DesktopAgentRegistryDeps,
} from "./agent-registry.js";

it("does not initialize a lazy agent after its profile has been released", async () => {
  const config = {
    id: "agent",
    name: "Agent",
    harness: "ai-sdk",
    provider: "openai",
    model: "mock-model",
    effort: "medium",
    auth: "api-key",
    apiKey: "mock-only",
  };
  const deps = {
    profiles: { list: () => ({ profiles: [{ id: "profile" }] }) },
    profileConfig: {
      forProfile: () => ({
        agents: { list: () => [config], get: () => config },
        connections: { list: () => [] },
      }),
    },
    sandboxProvider: {},
    agentHomesDir: "/unused",
    harnessComponentsDir: "/unused",
  } as unknown as DesktopAgentRegistryDeps;
  const registry = new DesktopAgentRegistry(deps);
  const registered = registry.get("agent");
  expect(registered).toBeDefined();
  registry.releaseProfile("profile");
  const session = await registered?.provider.startSession({
    userId: "user",
    sessionId: "session",
    projectId: "project",
    sandboxId: "sandbox",
    workingDirectory: "/workspace",
  });
  expect(session?.providerSessionId).toBe("unavailable-session");
  expect(build).not.toHaveBeenCalled();
  await registry.dispose();
  expect(Reflect.get(registry, "closeables").size).toBe(0);
});

it("does not expose settings-specific tools to agents", async () => {
  const config = {
    id: "agent",
    name: "Read only",
    harness: "ai-sdk",
    provider: "openai",
    model: "mock-model",
    mode: "read-only",
  };
  const deps = {
    profiles: { list: () => ({ profiles: [{ id: "profile" }] }) },
    profileConfig: {
      forProfile: () => ({
        agents: { list: () => [config], get: () => config },
        connections: { list: () => [] },
      }),
    },
    workspaceBridge: {},
    sandboxProvider: {},
    agentHomesDir: "/unused",
    harnessComponentsDir: "/unused",
  } as unknown as DesktopAgentRegistryDeps;
  const registry = new DesktopAgentRegistry(deps);
  const tools = registry
    .workspaceToolsForAgent("agent")
    ?.map((tool) => tool.name);
  expect(tools).not.toContain("get_desktop_settings");
  expect(tools).not.toContain("update_desktop_setting");
  await registry.dispose();
});
