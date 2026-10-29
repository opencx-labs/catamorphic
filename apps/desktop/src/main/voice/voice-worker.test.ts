import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type {
  VoiceAudioUp,
  VoiceWorkerCommand,
  VoiceWorkerEvent,
} from "../../shared/voice.js";
import type { SpeechParts } from "./engine.js";

const speech = vi.hoisted(() => ({ recognize: vi.fn() }));
vi.mock("./fake-speech.js", () => ({
  fakeSpeech: (): SpeechParts => ({
    activity: {
      windowSize: 16000,
      accept() {},
      detected: () => false,
      takeSegments: () => [],
      reset() {},
    },
    recognize: speech.recognize,
    synthesize: async () => ({
      samples: new Float32Array(),
      sampleRate: 24000,
    }),
    cue: () => ({ samples: new Float32Array(), sampleRate: 24000 }),
    voiceprint: () => [1],
  }),
}));

afterEach(() => Reflect.deleteProperty(process, "parentPort"));

it("acknowledges a released hold only after every dictated piece, including its slow tail", async () => {
  const events: VoiceWorkerEvent[] = [];
  const parent = Object.assign(new EventEmitter(), {
    postMessage: (event: VoiceWorkerEvent) => events.push(event),
  });
  Reflect.set(process, "parentPort", parent);
  await import("./voice-worker.js");
  const command = (data: VoiceWorkerCommand, ports: unknown[] = []) =>
    parent.emit("message", { data, ports });
  const audio = Object.assign(new EventEmitter(), {
    start() {},
    close() {},
    postMessage() {},
  });
  const frame = (samples: number) =>
    audio.emit("message", {
      data: {
        type: "frame",
        sampleRate: 16000,
        samples: new Float32Array(samples).fill(0.5),
      } satisfies VoiceAudioUp,
    });
  let first!: (value: { text: string; confidence: number }) => void;
  let tail!: (value: { text: string; confidence: number }) => void;
  speech.recognize
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          tail = resolve;
        }),
    );
  command({ type: "audio" }, [audio]);
  command({
    type: "start",
    speech: { kind: "fake", utterance: "unused" },
    voiceprint: null,
    handsFree: false,
    dictation: true,
  });
  command({ type: "hold", held: true });
  frame(40 * 16000);
  command({ type: "hold", held: false, release: 7 });
  await vi.waitFor(() => expect(first).toBeTypeOf("function"));
  first({ text: "first piece", confidence: 0 });
  await vi.waitFor(() => expect(tail).toBeTypeOf("function"));
  expect(
    events.some(
      (event) =>
        event.type === "dictation" &&
        event.final &&
        event.text === "first piece",
    ),
  ).toBe(true);
  expect(events.some((event) => event.type === "hold-recognized")).toBe(false);
  tail({ text: "last words", confidence: 0 });
  await vi.waitFor(() =>
    expect(events).toContainEqual({ type: "hold-recognized", release: 7 }),
  );
  const final = events.flatMap((event) =>
    event.type === "dictation" && event.final ? [event.text] : [],
  );
  expect(final).toEqual(["first piece", "last words"]);
  expect(events.at(-1)).toEqual({ type: "hold-recognized", release: 7 });
  command({ type: "rest" });
});
