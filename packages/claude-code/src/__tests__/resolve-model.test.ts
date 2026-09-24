import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  supportedModels: vi.fn(),
  close: vi.fn(),
  return: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));

import { resolveClaudeCodeModel } from "../list-models.js";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const CATALOG = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5 with 1M context",
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5 with 1M context",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5",
  },
];

const setup = (withSettings = true) =>
  mocks.query.mockReturnValue({
    ...(withSettings ? { getSettings: mocks.getSettings } : {}),
    supportedModels: mocks.supportedModels,
    close: mocks.close,
    return: mocks.return,
  });

it("reads the applied model with session settings and names it from a concrete catalog row", async () => {
  setup();
  mocks.getSettings.mockResolvedValue({
    applied: { model: "claude-sonnet-5" },
  });
  mocks.supportedModels.mockResolvedValue(CATALOG);
  await expect(
    resolveClaudeCodeModel({
      workingDirectory: "/checkout",
      env: { CLAUDE_CONFIG_DIR: "/account" },
    }),
  ).resolves.toEqual({ id: "claude-sonnet-5", name: "Sonnet" });
  expect(mocks.query.mock.calls[0]?.[0].options).toMatchObject({
    cwd: "/checkout",
    settingSources: ["user", "project", "local"],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    tools: [],
    persistSession: false,
    env: { CLAUDE_CONFIG_DIR: "/account" },
  });
  expect(mocks.return).toHaveBeenCalled();
});

it("never names a model after the account-default row", async () => {
  setup();
  mocks.getSettings.mockResolvedValue({
    applied: { model: "claude-opus-5[1m]" },
  });
  mocks.supportedModels.mockResolvedValue(CATALOG);
  await expect(
    resolveClaudeCodeModel({ workingDirectory: "/checkout" }),
  ).resolves.toEqual({ id: "claude-opus-5[1m]", name: "Opus (1M context)" });
});

it("keeps an id the catalog does not list, without a name", async () => {
  setup();
  mocks.getSettings.mockResolvedValue({ applied: { model: "custom-model" } });
  mocks.supportedModels.mockResolvedValue(CATALOG);
  await expect(
    resolveClaudeCodeModel({ workingDirectory: "/checkout" }),
  ).resolves.toEqual({ id: "custom-model" });
});

it("answers null when the CLI cannot report its settings", async () => {
  setup(false);
  await expect(
    resolveClaudeCodeModel({ workingDirectory: "/checkout" }),
  ).resolves.toBeNull();
  mocks.getSettings.mockResolvedValue({ applied: {} });
  setup();
  await expect(
    resolveClaudeCodeModel({ workingDirectory: "/checkout" }),
  ).resolves.toBeNull();
  expect(mocks.supportedModels).not.toHaveBeenCalled();
  expect(mocks.return).toHaveBeenCalledTimes(2);
});

it("bounds a hung control request and still closes the subprocess", async () => {
  vi.useFakeTimers();
  setup();
  mocks.getSettings.mockReturnValue(new Promise(() => {}));
  const result = expect(
    resolveClaudeCodeModel({ workingDirectory: "/checkout", timeoutMs: 20 }),
  ).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20);
  await result;
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.return).toHaveBeenCalled();
});
