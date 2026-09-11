import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  supportedCommands: vi.fn(),
  close: vi.fn(),
  return: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));

import { listClaudeSlashCommands } from "../list-commands.js";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const setup = () =>
  mocks.query.mockReturnValue({
    supportedCommands: mocks.supportedCommands,
    close: mocks.close,
    return: mocks.return,
  });
it("uses session settings and plugins, closes discovery without a model prompt", async () => {
  setup();
  mocks.supportedCommands.mockResolvedValue([
    { name: "plugin:check", description: "Check", argumentHint: "<file>" },
  ]);
  const commands = await listClaudeSlashCommands({
    workingDirectory: "/checkout",
    plugins: [{ type: "local", path: "/plugin" }],
    env: { CLAUDE_CONFIG_DIR: "/account" },
  });
  expect(commands[0]?.name).toBe("plugin:check");
  expect(mocks.query.mock.calls[0]?.[0].options).toMatchObject({
    cwd: "/checkout",
    settingSources: ["user", "project", "local"],
    plugins: [{ type: "local", path: "/plugin" }],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    tools: [],
    persistSession: false,
    env: { CLAUDE_CONFIG_DIR: "/account" },
  });
  expect(mocks.return).toHaveBeenCalled();
});
it("bounds a hung supportedCommands call even when the SDK ignores abort", async () => {
  vi.useFakeTimers();
  setup();
  mocks.supportedCommands.mockReturnValue(new Promise(() => {}));
  const result = expect(
    listClaudeSlashCommands({ workingDirectory: "/checkout", timeoutMs: 20 }),
  ).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20);
  await result;
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.return).toHaveBeenCalled();
});
it("propagates discovery failures and still closes the subprocess", async () => {
  setup();
  mocks.supportedCommands.mockRejectedValue(new Error("broken"));
  await expect(
    listClaudeSlashCommands({ workingDirectory: "/checkout" }),
  ).rejects.toThrow("broken");
  expect(mocks.return).toHaveBeenCalled();
});

it("does not finish discovery while subprocess cleanup is pending", async () => {
  setup();
  mocks.supportedCommands.mockResolvedValue([]);
  let releaseCleanup = () => {};
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  mocks.return.mockReturnValueOnce(cleanup);
  const finished = vi.fn();
  const discovery = listClaudeSlashCommands({ workingDirectory: "/checkout" });
  void discovery.then(finished);
  await vi.waitFor(() => expect(mocks.return).toHaveBeenCalled());
  expect(finished).not.toHaveBeenCalled();
  releaseCleanup();
  await discovery;
  expect(finished).toHaveBeenCalledOnce();
});
