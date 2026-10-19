import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudioUp } from "../../shared/voice.js";
import { Speaker } from "./speaker.js";

/**
 * An output whose clock moves only while it runs, as Chromium's does: a
 * suspended context holds every scheduled clip where it is.
 */
class FakeContext {
  static made: FakeContext[] = [];
  state: "running" | "suspended" = "running";
  currentTime = 0;
  outputLatency = 0;
  readonly destination = {};
  readonly started: { at: number; stop: () => void }[] = [];
  constructor() {
    FakeContext.made.push(this);
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {}
  createBuffer(_channels: number, length: number, rate: number) {
    return {
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    const source = {
      buffer: null as unknown,
      onended: null as (() => void) | null,
      connect: () => {},
      start: (at: number) =>
        this.started.push({ at, stop: () => source.onended?.() }),
      stop: vi.fn(),
    };
    return source;
  }
}

function speaker() {
  const sent: VoiceAudioUp[] = [];
  const port = {
    postMessage: (message: VoiceAudioUp) => sent.push(message),
  } as unknown as MessagePort;
  return { speaker: new Speaker(port), sent };
}

const clip = (seq: number) => ({
  type: "play" as const,
  seq,
  samples: new Float32Array(2400),
  sampleRate: 24_000,
});

const levels = (sent: VoiceAudioUp[]) =>
  sent.flatMap((message) =>
    message.type === "levels"
      ? [message.reset ? "reset" : `clip:${message.levels.length > 0}`]
      : [],
  );

afterEach(() => {
  vi.unstubAllGlobals();
  FakeContext.made = [];
});

describe("the audio page's speaker (ADR 0265)", () => {
  it("holds what it plays where it is while paused, and carries on after", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const { speaker: out, sent } = speaker();
    out.receive(clip(1));
    const context = FakeContext.made[0];
    out.receive({ type: "pause" });
    expect(context?.state).toBe("suspended");
    // A clip made while paused waits with the rest.
    out.receive(clip(2));
    expect(context?.state).toBe("suspended");
    out.receive({ type: "resume" });
    await Promise.resolve();
    await Promise.resolve();
    expect(context?.state).toBe("running");
    // The bars forget the paused schedule, then follow both clips anew.
    expect(levels(sent)).toEqual([
      "clip:true",
      "reset",
      "reset",
      "clip:true",
      "clip:true",
    ]);
  });

  it("starts a first clip paused when the person already talks over it", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const { speaker: out, sent } = speaker();
    out.receive({ type: "pause" });
    out.receive(clip(1));
    expect(FakeContext.made[0]?.state).toBe("suspended");
    expect(levels(sent)).toEqual(["reset"]);
  });

  it("drops what it was saying when stopped, paused or not, and plays the next", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const { speaker: out, sent } = speaker();
    out.receive(clip(1));
    out.receive({ type: "pause" });
    out.receive({ type: "flush", seq: 2 });
    out.receive(clip(3));
    expect(FakeContext.made[0]?.state).toBe("running");
    FakeContext.made[0]?.started.at(-1)?.stop();
    expect(sent.at(-1)).toEqual({ type: "drained", seq: 3 });
    expect(levels(sent)).toEqual(["clip:true", "reset", "reset", "clip:true"]);
  });
});
