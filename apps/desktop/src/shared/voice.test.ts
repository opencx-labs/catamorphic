import { describe, expect, it } from "vitest";
import { sameVoiceTarget, type VoiceTarget, voiceprintOf } from "./voice.js";

describe("sameVoiceTarget", () => {
  it("takes dictation pressed from anywhere as whatever dictation is on", () => {
    expect(
      sameVoiceTarget(
        { kind: "dictation", sessionId: "chat-1" },
        { kind: "dictation" },
      ),
    ).toBe(true);
    expect(sameVoiceTarget({ kind: "dictation" }, { kind: "dictation" })).toBe(
      true,
    );
  });

  it("takes a composer's dictation as that chat's alone", () => {
    expect(
      sameVoiceTarget(
        { kind: "dictation", sessionId: "chat-1" },
        { kind: "dictation", sessionId: "chat-2" },
      ),
    ).toBe(false);
    expect(
      sameVoiceTarget(
        { kind: "dictation" },
        { kind: "dictation", sessionId: "chat-2" },
      ),
    ).toBe(false);
  });

  it("tells chats and the assistant apart", () => {
    const chat: VoiceTarget = { kind: "chat", projectId: "p", sessionId: "s" };
    expect(sameVoiceTarget(chat, chat)).toBe(true);
    expect(
      sameVoiceTarget(chat, { kind: "chat", projectId: "p", sessionId: "t" }),
    ).toBe(false);
    expect(sameVoiceTarget({ kind: "assistant" }, { kind: "assistant" })).toBe(
      true,
    );
    expect(sameVoiceTarget({ kind: "assistant" }, chat)).toBe(false);
    expect(sameVoiceTarget(null, chat)).toBe(false);
  });
});

describe("voiceprintOf", () => {
  it("keeps a print made by the model in use, and forgets any other", () => {
    expect(
      voiceprintOf({ model: "eres2net-voxceleb", vector: [0.6, 0.8] }),
    ).toEqual({ model: "eres2net-voxceleb", vector: [0.6, 0.8] });
    expect(voiceprintOf({ model: "wespeaker", vector: [1] })).toBe(null);
    expect(voiceprintOf([0.6, 0.8])).toBe(null);
    expect(voiceprintOf({ model: "eres2net-voxceleb", vector: ["x"] })).toBe(
      null,
    );
  });
});
