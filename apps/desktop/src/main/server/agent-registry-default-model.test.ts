import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
}));
vi.mock("@catamorphic/claude-code", () => ({
  resolveClaudeCodeModel: harness.claude,
}));
vi.mock("@catamorphic/codex", () => ({ resolveCodexModel: harness.codex }));
vi.mock("electron", () => ({ safeStorage: {} }));

import type { AgentConfig } from "../agents-store.js";
import {
  DesktopAgentRegistry,
  type DesktopAgentRegistryDeps,
} from "./agent-registry.js";

const homes = mkdtempSync(path.join(tmpdir(), "agent-homes-"));
afterEach(() => vi.clearAllMocks());
afterAll(() => rmSync(homes, { recursive: true, force: true }));

function registryWith(configs: Partial<AgentConfig>[]) {
  const deps = {
    profiles: {
      list: () => ({ profiles: [{ id: "profile" }] }),
      profileForProject: () => ({ id: "profile" }),
    },
    profileConfig: {
      forProfile: () => ({
        agents: {
          list: () => configs,
          get: (id: string) => configs.find((config) => config.id === id),
        },
        connections: { list: () => [] },
      }),
    },
    sandboxProvider: {},
    agentHomesDir: homes,
    harnessComponentsDir: "/unused",
  } as unknown as DesktopAgentRegistryDeps;
  const registry = new DesktopAgentRegistry(deps);
  // The CLI components are downloaded on demand; the probe only needs a path.
  Reflect.set(registry, "ensureNativeComponents", async () => ({
    component: { executablePath: "/bin/harness" },
    environment: { PATH: "/toolchain" },
  }));
  return registry;
}

it("asks Claude Code with the session's credentials and caches per agent and folder", async () => {
  harness.claude.mockResolvedValue({ id: "claude-sonnet-5", name: "Sonnet" });
  const registry = registryWith([
    { id: "claude", harness: "claude-code", auth: "account", model: "" },
  ]);
  const ask = (workingDirectory: string) =>
    registry.defaultModel({
      projectId: "project",
      agentId: "claude",
      workingDirectory,
    });
  await expect(ask("/project")).resolves.toEqual({
    model: { id: "claude-sonnet-5", name: "Sonnet" },
  });
  await ask("/project");
  expect(harness.claude).toHaveBeenCalledTimes(1);
  expect(harness.claude).toHaveBeenCalledWith({
    workingDirectory: "/project",
    pathToClaudeCodeExecutable: "/bin/harness",
    env: {
      PATH: "/toolchain",
      CLAUDE_CONFIG_DIR: path.join(homes, "claude"),
    },
  });
  // Another folder can carry its own project settings.
  await ask("/worktree");
  expect(harness.claude).toHaveBeenCalledTimes(2);
  await registry.dispose();
});

it("does not keep a failed answer", async () => {
  harness.codex
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ id: "gpt-5.5", name: "GPT-5.5" });
  const registry = registryWith([
    { id: "codex", harness: "codex", auth: "local", model: "" },
  ]);
  const ask = () =>
    registry.defaultModel({
      projectId: "project",
      agentId: "codex",
      workingDirectory: "/project",
    });
  await expect(ask()).resolves.toMatchObject({ model: null });
  await expect(ask()).resolves.toEqual({
    model: { id: "gpt-5.5", name: "GPT-5.5" },
  });
  expect(harness.codex).toHaveBeenLastCalledWith({
    executable: "/bin/harness",
    workingDirectory: "/project",
    env: { PATH: "/toolchain" },
  });
  await registry.dispose();
});

it("names the built-in agent's resolved model without spawning anything", async () => {
  const registry = registryWith([
    { id: "router", harness: "ai-sdk", provider: "openrouter", model: "" },
  ]);
  Reflect.set(registry, "openrouterDefault", "vendor/free-model:free");
  await expect(
    registry.defaultModel({
      projectId: "project",
      agentId: "router",
      workingDirectory: "/project",
    }),
  ).resolves.toEqual({ model: { id: "vendor/free-model:free" } });
  expect(harness.claude).not.toHaveBeenCalled();
  expect(harness.codex).not.toHaveBeenCalled();
  await registry.dispose();
});
