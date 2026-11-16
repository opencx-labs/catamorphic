// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentWizard } from "./agent-wizard";

const api = vi.hoisted(() => ({
  agentSetupStatus: vi.fn(),
  agentsList: vi.fn(),
  connectionsList: vi.fn(),
  onAgentLoginFinished: vi.fn(),
  onAgentLoginProgress: vi.fn(),
  agentsCreate: vi.fn(),
  agentLogin: vi.fn(),
  agentLoginStatus: vi.fn(),
  agentsRemove: vi.fn(),
}));
vi.mock("../lib/desktop-api", () => ({ desktopApi: api }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const mock of Object.values(api)) mock.mockReset();
  api.agentSetupStatus.mockResolvedValue({ claudeCode: true, codex: false });
  api.agentsList.mockResolvedValue({ agents: [] });
  api.connectionsList.mockResolvedValue([]);
  api.onAgentLoginFinished.mockReturnValue(() => {});
  api.onAgentLoginProgress.mockReturnValue(() => {});
  api.agentsCreate.mockImplementation(async (input: { harness: string }) => ({
    id: `${input.harness}-agent`,
  }));
  api.agentLogin.mockResolvedValue({ started: true });
  api.agentLoginStatus.mockResolvedValue(false);
  api.agentsRemove.mockResolvedValue(true);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

const press = async (selector: string) => {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`No ${selector}`);
  await act(async () => button.click());
};
const pressText = async (text: string) => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button "${text}"`);
  await act(async () => button.click());
};

it("removes the agent of a sign-in left unfinished once another is set up", async () => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <AgentWizard variant="tab" onClose={() => {}} onDone={onDone} />,
    ),
  );
  // A ChatGPT sign-in starts, creating its agent, and is left for Claude.
  await press('[data-testid="agent-wizard-codex"]');
  await pressText("Sign in with ChatGPT");
  expect(api.agentsCreate).toHaveBeenCalledWith(
    expect.objectContaining({ harness: "codex" }),
  );
  await press('[data-testid="agent-wizard-back"]');
  await press('[data-testid="agent-wizard-claude-code"]');
  await pressText("Use existing setup");
  // The unfinished one goes, so it stays neither listed nor the default.
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(api.agentsRemove.mock.calls).toEqual([["codex-agent"]]);
});

it("keeps an agent whose sign-in landed after all", async () => {
  api.agentLoginStatus.mockImplementation(
    async (id: string) => id === "codex-agent",
  );
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <AgentWizard variant="tab" onClose={() => {}} onDone={onDone} />,
    ),
  );
  await press('[data-testid="agent-wizard-codex"]');
  await pressText("Sign in with ChatGPT");
  await press('[data-testid="agent-wizard-back"]');
  await press('[data-testid="agent-wizard-claude-code"]');
  await pressText("Use existing setup");
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(api.agentsRemove).not.toHaveBeenCalled();
});

it("keeps the agent it finished with", async () => {
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <AgentWizard variant="tab" onClose={() => {}} onDone={onDone} />,
    ),
  );
  await press('[data-testid="agent-wizard-claude-code"]');
  await pressText("Use existing setup");
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(api.agentsRemove).not.toHaveBeenCalled();
});

it("marks the choices the profile has a signed-in agent from, as they stood on opening", async () => {
  const agents = [
    { id: "claude", harness: "claude-code", auth: "local" },
    { id: "free", harness: "ai-sdk", provider: "openrouter", auth: "account" },
    { id: "key", harness: "ai-sdk", provider: "openai", auth: "api-key" },
    { id: "other", harness: "acp", acp: { command: ["another-agent"] } },
    // Its sign-in was left unfinished: an agent, but not one that is added.
    { id: "unfinished", harness: "codex", auth: "account" },
  ];
  api.agentsList.mockResolvedValue({ agents });
  api.agentLoginStatus.mockImplementation(
    async (id: string) => id !== "unfinished",
  );
  await act(async () =>
    root.render(
      <AgentWizard variant="tab" onClose={() => {}} onDone={() => {}} />,
    ),
  );
  const added = () =>
    [...container.querySelectorAll("[data-agent-added]")].map(
      (mark) => mark.closest("button")?.dataset.testid,
    );
  const marked = [
    "agent-wizard-claude-code",
    "agent-wizard-api-key",
    "agent-wizard-free",
  ];
  await vi.waitFor(() => expect(added()).toEqual(marked));
  // A sign-in under way is read no sooner than the wizard next opens.
  api.agentLoginStatus.mockResolvedValue(true);
  await press('[data-testid="agent-wizard-codex"]');
  await pressText("Sign in with ChatGPT");
  await press('[data-testid="agent-wizard-back"]');
  expect(added()).toEqual(marked);
});
