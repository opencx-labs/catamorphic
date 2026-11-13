// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceTranscript } from "../../shared/voice.js";
import type { ComposerInputHandle } from "../components/composer-input.js";
import { DICTATION_ATTR, DICTATION_PREVIEW_ATTR } from "./field-dictation.js";
import { useVoiceTranscript } from "./voice-transcript.js";

const listener = vi.hoisted(() => ({
  words: (_words: VoiceTranscript) => {},
  stop: vi.fn(),
}));
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    onVoiceTranscript: (words: (value: VoiceTranscript) => void) => {
      listener.words = words;
      return listener.stop;
    },
  },
}));
let root: Root;
let node: HTMLDivElement;
let field: HTMLDivElement;
let composer: { current: ComposerInputHandle };
function Preview({ sessionId = "s" }: { sessionId?: string }) {
  useVoiceTranscript("p", sessionId, composer);
  return null;
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  field = document.createElement("div");
  field.setAttribute("contenteditable", "true");
  field.setAttribute(DICTATION_PREVIEW_ATTR, "");
  field.append("Keep my draft ");
  document.body.append(node, field);
  composer = { current: { element: () => field } as ComposerInputHandle };
  root = createRoot(node);
  act(() => root.render(<Preview />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});
const words = (
  text: string,
  final = false,
  sessionId = "s",
): VoiceTranscript => ({ projectId: "p", sessionId, segment: 1, text, final });
it("revises provisional words and removes only those words when voice sends", () => {
  act(() => listener.words(words("first")));
  act(() => listener.words(words("final words")));
  expect(field.textContent).toBe("Keep my draft final words");
  expect(field.querySelectorAll(`[${DICTATION_ATTR}]`)).toHaveLength(1);
  field.append(" plus typing");
  act(() => listener.words(words("", true)));
  expect(field.textContent).toBe("Keep my draft  plus typing");
  expect(field.querySelector(`[${DICTATION_ATTR}]`)).toBeNull();
});
it("ignores other chats and clears its preview when the composer moves to another session", () => {
  act(() => listener.words(words("wrong chat", false, "other")));
  expect(field.textContent).toBe("Keep my draft ");
  act(() => listener.words(words("old preview")));
  act(() => root.render(<Preview sessionId="new" />));
  expect(field.textContent).toBe("Keep my draft ");
  expect(listener.stop).toHaveBeenCalled();
});
