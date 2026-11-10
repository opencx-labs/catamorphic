// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../shared/app-prefs.js";
import { VOICE_OFF, type VoiceStatus } from "../../shared/voice.js";
import { VoiceButton } from "./voice-button.js";

const { api } = vi.hoisted(() => ({
  api: {
    voiceStatus: vi.fn(),
    onVoiceStatus: vi.fn(() => () => {}),
    onVoiceLevels: vi.fn(() => () => {}),
    agentsList: vi.fn(async () => ({ agents: [] })),
    onAgentsChanged: vi.fn(() => () => {}),
  },
}));
vi.mock("../lib/desktop-api.js", () => ({ desktopApi: api }));
vi.mock("../lib/use-app-preferences.js", () => ({
  useAppPreferences: () => ({
    prefs: DEFAULT_PREFS,
    loaded: true,
    update: vi.fn(),
  }),
}));
vi.mock("../lib/keybindings", () => ({
  useKeybindings: () => ({}),
  formatBinding: () => "",
}));
vi.mock("../lib/microphones.js", () => ({
  useMicrophones: () => [],
  useWatchedMicrophones: () => {},
}));

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

async function render(status: VoiceStatus, sessionId?: string) {
  api.voiceStatus.mockResolvedValue(status);
  await act(async () =>
    root.render(
      <VoiceButton
        projectId="p"
        {...(sessionId
          ? {
              chat: {
                sessionId,
                agentId: null,
                agentName: "Agent",
                ensureSession: async () => sessionId,
                focusComposer: () => {},
              },
            }
          : {})}
      />,
    ),
  );
  const button = node.querySelector("button");
  if (!button) throw new Error("No microphone");
  return button;
}

it("explains a failed chat microphone from the dock after that chat closes", async () => {
  const button = await render({
    ...VOICE_OFF,
    target: { kind: "chat", projectId: "p", sessionId: "closed" },
    error: "The reply voice download failed. Try again.",
  });
  expect(button.getAttribute("aria-description")).toBe(
    "The reply voice download failed. Try again.",
  );
  expect(button.getAttribute("aria-label")).toBe("Hold to retry voice");
  expect(
    button
      .querySelector('[data-testid="voice-error"]')
      ?.getAttribute("data-shown"),
  ).toBe("true");
});

it("does not put another chat's failure on an unrelated chat microphone", async () => {
  const button = await render(
    {
      ...VOICE_OFF,
      target: { kind: "chat", projectId: "p", sessionId: "closed" },
      error: "The reply voice download failed.",
    },
    "other",
  );
  expect(button.getAttribute("aria-description")).toBe("Hold to talk to Agent");
  expect(
    button
      .querySelector('[data-testid="voice-error"]')
      ?.getAttribute("data-shown"),
  ).toBe("false");
});

it("identifies the reply voice download separately from recognition", async () => {
  const button = await render({
    ...VOICE_OFF,
    phase: "preparing",
    target: { kind: "assistant" },
    download: { receivedBytes: 25, totalBytes: 100, kind: "reply-voice" },
  });
  expect(button.getAttribute("aria-description")).toBe(
    "Downloading reply voice, 25%",
  );
});
