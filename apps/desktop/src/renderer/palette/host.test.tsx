// @vitest-environment jsdom

import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BUILTIN_ACTIONS } from "../../shared/actions.js";
import type { OpenMode } from "../../shared/open-mode.js";
import {
  type PaletteHost,
  PaletteHostProvider,
  usePaletteHost,
} from "./host.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function hasEveryAction(
  handlers: Record<string, (mode?: OpenMode) => void>,
): handlers is PaletteHost["actionHandlers"] {
  return BUILTIN_ACTIONS.every(
    (action) => typeof handlers[action.id] === "function",
  );
}

function fixture(): PaletteHost {
  const actionHandlers = Object.fromEntries(
    BUILTIN_ACTIONS.map((action) => [action.id, vi.fn()]),
  );
  if (!hasEveryAction(actionHandlers))
    throw new Error("Missing fixture action");
  return {
    projectId: "project",
    profileId: "profile",
    projects: [],
    profiles: [],
    workspaceConfig: null,
    startingActions: [],
    terminalMacros: [],
    agents: [],
    defaultAgentId: null,
    focusedChat: null,
    focusedSite: null,
    voiceAssistant: null,
    actionAvailability: { "close-tab": false },
    actionHandlers,
    onOpenUrl: vi.fn(),
    onOpenTab: vi.fn(),
    onOpenSession: vi.fn(),
    onSelectProject: vi.fn(),
    onSwitchProfile: vi.fn(),
    onSendToAgent: vi.fn(),
    onRunSkill: vi.fn(),
    onRunTerminalMacro: vi.fn(),
    onPickDefaultAgent: vi.fn(),
    onPickSessionAgent: vi.fn(),
    onPickProjectAgent: vi.fn(),
    onConfigureAgent: vi.fn(),
    onCreateAssistant: vi.fn(),
    onPickEffort: vi.fn(),
    onPickModel: vi.fn(),
    onPickHarnessPermissions: vi.fn(),
    onOpenHistory: vi.fn(),
  };
}

let root: Root;
let node: HTMLDivElement;
let observed: PaletteHost | undefined;
let renders: number;
const Consumer = memo(function Consumer() {
  observed = usePaletteHost();
  renders += 1;
  return null;
});
function currentHost(): PaletteHost {
  if (!observed) throw new Error("The palette consumer has not rendered");
  return observed;
}
const render = (value: PaletteHost) =>
  act(() =>
    root.render(
      <PaletteHostProvider value={value}>
        <Consumer />
      </PaletteHostProvider>,
    ),
  );

beforeEach(() => {
  observed = undefined;
  renders = 0;
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

it("leaves unchanged rows alone while their retained commands run the latest app state", async () => {
  const first = fixture();
  await render(first);
  const retained = currentHost();
  const next = {
    ...first,
    ...fixture(),
    projects: first.projects,
    startingActions: first.startingActions,
  };
  await render(next);
  expect(renders).toBe(1);
  expect(currentHost()).toBe(retained);
  retained.onSelectProject("next-project");
  retained.onSendToAgent("a new question", "tab", "agent");
  retained.actionHandlers["close-tab"]("side");
  expect(first.onSelectProject).not.toHaveBeenCalled();
  expect(next.onSelectProject).toHaveBeenCalledWith("next-project");
  expect(next.onSendToAgent).toHaveBeenCalledWith(
    "a new question",
    "tab",
    "agent",
  );
  expect(first.actionHandlers["close-tab"]).not.toHaveBeenCalled();
  expect(next.actionHandlers["close-tab"]).toHaveBeenCalledWith("side");
});

it("publishes changed command context immediately and keeps callback identities", async () => {
  const first = fixture();
  await render(first);
  const retained = currentHost();
  const next = {
    ...first,
    focusedChat: {
      sessionId: "session",
      harness: "codex",
      agentId: "agent",
      model: "model",
      effort: null,
    },
    focusedSite: { origin: "https://example.com", host: "example.com" },
    actionAvailability: { "close-tab": true },
    defaultAgentId: "agent",
    memberShell: true,
  };
  await render(next);
  expect(renders).toBe(2);
  expect(currentHost()).toMatchObject({
    focusedChat: next.focusedChat,
    focusedSite: next.focusedSite,
    actionAvailability: next.actionAvailability,
    defaultAgentId: "agent",
    memberShell: true,
  });
  expect(currentHost().onSendToAgent).toBe(retained.onSendToAgent);
  await render({
    ...next,
    focusedChat: { ...next.focusedChat },
    focusedSite: { ...next.focusedSite },
    actionAvailability: { ...next.actionAvailability },
  });
  expect(renders).toBe(2);
});

it("preserves optional capabilities and forwards replacements without refreshing rows", async () => {
  const first = fixture();
  await render(first);
  expect(currentHost().onOpenSiteSettings).toBeUndefined();
  expect(currentHost().onClearDefaultOverride).toBeUndefined();
  const next = {
    ...first,
    onOpenSiteSettings: vi.fn(),
    onClearDefaultOverride: vi.fn(),
    onHighlightTarget: vi.fn(),
    onError: vi.fn(),
  };
  await render(next);
  const retained = currentHost();
  const replacement = {
    ...next,
    onOpenSiteSettings: vi.fn(),
    onError: vi.fn(),
  };
  await render(replacement);
  expect(renders).toBe(2);
  retained.onOpenSiteSettings?.("https://example.com");
  retained.onError?.("Could not open this item");
  expect(next.onOpenSiteSettings).not.toHaveBeenCalled();
  expect(replacement.onOpenSiteSettings).toHaveBeenCalledWith(
    "https://example.com",
  );
  expect(replacement.onError).toHaveBeenCalledWith("Could not open this item");
  await render(first);
  expect(currentHost().onOpenSiteSettings).toBeUndefined();
  expect(currentHost().onError).toBeUndefined();
});
