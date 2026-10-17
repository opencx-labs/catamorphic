import { describe, expect, it } from "vitest";
import type { VoiceWindowChoice } from "../../shared/voice.js";
import { voicePressFor, voiceWindowEntries } from "./voice-menu.js";

const choice = (
  over: Partial<VoiceWindowChoice> & Pick<VoiceWindowChoice, "id" | "title">,
): VoiceWindowChoice => ({
  assistant: "Work",
  current: false,
  ...over,
});

describe("voiceWindowEntries", () => {
  it("offers nothing with only one window to talk for", () => {
    expect(voiceWindowEntries([choice({ id: 1, title: "Docs" })])).toEqual([]);
  });

  it("lists the windows under a heading, the current one checked", () => {
    const entries = voiceWindowEntries([
      choice({ id: 1, title: "Docs", current: true, profile: "Personal" }),
      choice({ id: 2, title: "Site", assistant: "Claude", profile: "Work" }),
    ]);
    expect(entries).toEqual([
      {
        label: "Talk to the assistant of",
        action: "windows",
        disabledReason: "Pick a window below",
      },
      {
        label: "Docs",
        action: "window:1",
        checked: true,
        detail: "Work · Personal",
      },
      {
        label: "Site",
        action: "window:2",
        checked: false,
        detail: "Claude · Work",
      },
    ]);
  });

  it("names a window whose profile has no assistant yet, and keeps it out", () => {
    const [, , none] = voiceWindowEntries([
      choice({ id: 1, title: "Docs", current: true }),
      choice({ id: 2, title: "New", assistant: null }),
    ]);
    expect(none).toEqual({
      label: "New",
      action: "window:2",
      checked: false,
      disabledReason: "That window's profile has no assistant yet",
    });
  });
});

describe("voicePressFor", () => {
  it("presses the voice a microphone shows, so a tap turns it off", () => {
    expect(voicePressFor({ kind: "dictation" }, "p")).toEqual({
      action: "dictate",
    });
    expect(voicePressFor({ kind: "dictation", sessionId: "s" }, "p")).toEqual({
      action: "dictate",
      sessionId: "s",
    });
    expect(
      voicePressFor({ kind: "chat", projectId: "p", sessionId: "s" }, "q"),
    ).toEqual({ action: "talk-to-chat", projectId: "p", sessionId: "s" });
    expect(voicePressFor({ kind: "assistant" }, "p")).toEqual({
      action: "talk-to-work",
      projectId: "p",
    });
    expect(voicePressFor({ kind: "assistant" }, undefined)).toEqual({
      action: "talk-to-work",
    });
  });
});
