import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudioUp } from "../../shared/voice.js";
import { Speaker } from "./speaker.js";

/** An output clock with observable playback completion and cancellation. */
class FakeContext {
  static made: FakeContext[] = [];
  currentTime = 0;
  outputLatency = 0;
  readonly destination = {};
  readonly started: {
    at: number;
    stop: () => void;
    cancel: () => void;
  }[] = [];
  constructor() {
    FakeContext.made.push(this);
  }
  async resume() {}
  close = vi.fn(async () => {});
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
        this.started.push({
          at,
          stop: () => source.onended?.(),
          cancel: source.stop,
        }),
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeContext.made = [];
});

describe("the audio page's speaker", () => {
  it("streams clips back to back, schedules their levels and reports the last one drained", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { speaker: out, sent } = speaker();
    out.receive(clip(1));
    const context = FakeContext.made[0];
    out.receive(clip(2));
    expect(FakeContext.made).toHaveLength(1);
    expect(context?.started.map(({ at }) => at)).toEqual([0.03, 0.13]);
    expect(levels(sent)).toEqual(["clip:true", "clip:true"]);
    expect(sent).toMatchObject([
      { type: "levels", at: 1030, frameMs: 20 },
      { type: "levels", at: 1130, frameMs: 20 },
    ]);
    context?.started[0]?.stop();
    expect(sent.some((message) => message.type === "drained")).toBe(false);
    context?.started[1]?.stop();
    expect(sent.at(-1)).toEqual({ type: "drained", seq: 2 });
  });

  it("drops what it was saying when stopped, clears its levels and plays the next", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const { speaker: out, sent } = speaker();
    out.receive(clip(1));
    const context = FakeContext.made[0];
    out.receive({ type: "flush", seq: 2 });
    expect(context?.started[0]?.cancel).toHaveBeenCalledOnce();
    context?.started[0]?.stop();
    expect(sent.some((message) => message.type === "drained")).toBe(false);
    out.receive(clip(3));
    expect(context?.started.at(-1)?.at).toBe(0.03);
    context?.started.at(-1)?.stop();
    expect(sent.at(-1)).toEqual({ type: "drained", seq: 3 });
    expect(levels(sent)).toEqual(["clip:true", "reset", "clip:true"]);
  });

  it("closes its output and cancels every scheduled clip", () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const { speaker: out, sent } = speaker();
    out.receive(clip(1));
    out.receive(clip(2));
    const context = FakeContext.made[0];
    out.close();
    for (const source of context?.started ?? []) {
      expect(source.cancel).toHaveBeenCalledOnce();
      source.stop();
    }
    expect(context?.close).toHaveBeenCalledOnce();
    expect(sent.some((message) => message.type === "drained")).toBe(false);
    expect(levels(sent)).toEqual(["clip:true", "clip:true", "reset"]);
  });
});
