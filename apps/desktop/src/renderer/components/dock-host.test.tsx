// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDockEntry } from "../../shared/chat.js";
import type { DockData, DockSnapshot } from "../../shared/desktop-workspace.js";
import { DockHost } from "./dock-host.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const state = vi.hoisted(() => ({
  snapshot: null as DockSnapshot | null,
  listeners: new Set<(snapshot: DockSnapshot) => void>(),
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    dockSnapshot: async () => state.snapshot,
    onDockSnapshot: (listener: (snapshot: DockSnapshot) => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    onWorkspaceEvent: () => () => {},
    onCloseSurface: () => () => {},
    dockRegion: async () => {},
    dockActivate: async () => {},
    dockCommand: async () => {},
  },
}));
vi.mock("../lib/chips-work.js", () => ({ useAnswerChipsWork: () => {} }));
vi.mock("../lib/keybindings.js", () => ({
  useKeybindings: () => ({}),
  matchesBinding: () => false,
}));
vi.mock("../lib/use-app-preferences.js", () => ({
  useAppPreference: () => [false, async () => {}, true],
}));
vi.mock("../lib/theme.js", () => ({
  useProjectTheme: () => null,
  applyTheme: () => {},
  themeStyle: () => ({}),
  ThemeScope: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./chat-bubbles.js", () => ({
  ChatBubbles: ({ entries }: { entries: ChatDockEntry[] }) => (
    <div>
      {entries.map((entry) => (
        <button key={entry.localId} data-bubble={entry.localId} type="button">
          {entry.localId}
        </button>
      ))}
    </div>
  ),
  useStripFold: () => ({ collapsed: false, choose: () => {} }),
}));
vi.mock("./chat-dock.js", () => ({
  ChatDock: ({ entry }: { entry: ChatDockEntry }) => (
    <div data-chat={entry.localId} data-mode={entry.mode} />
  ),
}));
vi.mock("./dock-dialogs.js", () => ({ DockDialogs: () => null }));
vi.mock("./downloads-bubble.js", () => ({ DownloadsBubble: () => null }));
vi.mock("./voice-button.js", () => ({
  useVoiceStatus: () => ({ phase: "off" }),
  VoiceButton: () => null,
}));

function chat(projectId: string, localId: string, fork = false): DockData {
  return {
    projectId,
    projectName: projectId,
    title: localId,
    entry: { localId, mode: "min" },
    tabActive: false,
    bubbleClearance: "strip",
    theme: null,
    icon: null,
    fork,
    unread: true,
    attention: true,
    menu: [],
    visible: false,
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  state.snapshot = {
    chats: [chat("opencx", "own"), chat("catamorphic", "foreign")],
    activeProjectId: "opencx",
    detached: false,
    multiProject: false,
    side: "right",
    placement: "center",
    collapsed: false,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  expect(state.listeners.size).toBe(0);
});
async function mount() {
  await act(async () => root.render(<DockHost activeProjectId="opencx" />));
}
async function publish(snapshot: DockSnapshot) {
  state.snapshot = snapshot;
  await act(async () => {
    for (const listener of state.listeners) listener(snapshot);
  });
}

describe("dock project scope", () => {
  it.each([false, true])(
    "keeps foreign attention chats out of a project-only dock (fork: %s)",
    async (fork) => {
      if (!state.snapshot) throw new Error("Missing fixture snapshot");
      state.snapshot.chats[1] = chat("catamorphic", "foreign", fork);
      await mount();

      expect(container.querySelector('[data-bubble="own"]')).not.toBeNull();
      expect(container.querySelector('[data-bubble="foreign"]')).toBeNull();
      expect(
        container.querySelector('[data-chat="foreign"][data-mode="partial"]'),
      ).toBeNull();
    },
  );

  it("keeps an all-projects chat open when opening acknowledges its attention", async () => {
    if (!state.snapshot) throw new Error("Missing fixture snapshot");
    const foreign = chat("catamorphic", "foreign", true);
    foreign.entry.mode = "partial";
    state.snapshot = {
      ...state.snapshot,
      chats: [chat("opencx", "own"), foreign],
      multiProject: true,
      activeChatId: "foreign",
    };
    await mount();
    expect(
      container.querySelector('[data-chat="foreign"][data-mode="partial"]'),
    ).not.toBeNull();

    await publish({
      ...state.snapshot,
      chats: state.snapshot.chats.map((item) => ({
        ...item,
        attention: false,
      })),
    });
    expect(container.querySelector('[data-bubble="foreign"]')).not.toBeNull();
    expect(
      container.querySelector('[data-chat="foreign"][data-mode="partial"]'),
    ).not.toBeNull();
  });

  it("keeps the owning project's chat open after its attention is acknowledged", async () => {
    if (!state.snapshot) throw new Error("Missing fixture snapshot");
    const own = chat("opencx", "own");
    own.entry.mode = "partial";
    state.snapshot = {
      ...state.snapshot,
      chats: [own, chat("catamorphic", "foreign")],
      activeChatId: "own",
    };
    await mount();
    await publish({
      ...state.snapshot,
      chats: state.snapshot.chats.map((item) => ({
        ...item,
        attention: false,
      })),
    });
    expect(
      container.querySelector('[data-chat="own"][data-mode="partial"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-bubble="foreign"]')).toBeNull();
  });
});
