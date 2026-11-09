import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  VoiceAudioUp,
  VoiceWorkerCommand,
  VoiceWorkerEvent,
} from "../../shared/voice.js";
import type { SpeechParts } from "./engine.js";
import { voiceModelPaths } from "./models.js";

const speech = vi.hoisted(() => ({
  recognize: vi.fn(),
  load: vi.fn<() => Promise<SpeechParts>>(),
  prepare: vi.fn<() => Promise<void>>(),
  synthesize: vi.fn<SpeechParts["synthesize"]>(),
}));
vi.mock("./sherpa-speech.js", () => ({ loadSherpaSpeech: speech.load }));
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

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  speech.prepare.mockResolvedValue();
  speech.synthesize.mockResolvedValue({
    samples: new Float32Array(),
    sampleRate: 24000,
  });
  speech.load.mockResolvedValue({
    activity: {
      windowSize: 512,
      accept() {},
      detected: () => false,
      takeSegments: () => [],
      reset() {},
    },
    recognize: speech.recognize,
    synthesize: speech.synthesize,
    prepareSynthesis: speech.prepare,
    cue: () => ({ samples: new Float32Array(), sampleRate: 24000 }),
  });
});
afterEach(() => Reflect.deleteProperty(process, "parentPort"));

async function worker() {
  const events: VoiceWorkerEvent[] = [];
  const parent = Object.assign(new EventEmitter(), {
    postMessage: (event: VoiceWorkerEvent) => events.push(event),
  });
  Reflect.set(process, "parentPort", parent);
  await import("./voice-worker.js");
  const command = (data: VoiceWorkerCommand) =>
    parent.emit("message", { data, ports: [] });
  const start = (dictation: boolean) =>
    command({
      type: "start",
      speech: {
        kind: "models",
        paths: voiceModelPaths("/models"),
        voice: "af_heart",
      },
      voiceprint: null,
      handsFree: false,
      dictation,
    });
  return { events, command, start };
}

it("prepares cached dictation parts before a conversation or read-aloud is ready", async () => {
  const voice = await worker();
  voice.start(true);
  await vi.waitFor(() =>
    expect(voice.events).toContainEqual({ type: "ready" }),
  );
  expect(speech.load).toHaveBeenCalledWith({
    paths: voiceModelPaths("/models"),
    voice: "af_heart",
    speaking: false,
  });
  expect(speech.prepare).not.toHaveBeenCalled();
  voice.command({ type: "rest" });
  voice.events.length = 0;
  let prepared!: () => void;
  speech.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        prepared = resolve;
      }),
  );
  voice.start(false);
  voice.command({ type: "speak", id: "read", text: "Read this reply." });
  await vi.waitFor(() => expect(speech.prepare).toHaveBeenCalledOnce());
  expect(voice.events).not.toContainEqual({ type: "ready" });
  expect(speech.synthesize).not.toHaveBeenCalled();
  prepared();
  await vi.waitFor(() => expect(speech.synthesize).toHaveBeenCalledOnce());
  expect(voice.events).toContainEqual({ type: "ready" });
  expect(speech.load).toHaveBeenCalledOnce();
  voice.command({ type: "rest" });
});

it("requests parallel synthesis preparation on a first conversation start", async () => {
  const voice = await worker();
  voice.start(false);
  await vi.waitFor(() =>
    expect(voice.events).toContainEqual({ type: "ready" }),
  );
  expect(speech.load).toHaveBeenCalledWith({
    paths: voiceModelPaths("/models"),
    voice: "af_heart",
    speaking: true,
  });
  expect(speech.prepare).toHaveBeenCalledOnce();
  voice.command({ type: "rest" });
});

it("drops a preparation rejection after rest and a newer dictation start", async () => {
  const voice = await worker();
  let fail!: (cause: Error) => void;
  speech.prepare.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  voice.start(false);
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  voice.command({ type: "rest" });
  voice.start(true);
  await vi.waitFor(() =>
    expect(voice.events).toContainEqual({ type: "ready" }),
  );
  fail(new Error("old preparation"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(voice.events.filter((event) => event.type === "failed")).toEqual([]);
  expect(speech.load).toHaveBeenCalledOnce();
  voice.command({ type: "rest" });
});

it("reports active preparation failures and retries the cached parts on restart", async () => {
  const voice = await worker();
  speech.prepare.mockRejectedValueOnce(new Error("Kokoro unavailable"));
  voice.start(false);
  await vi.waitFor(() =>
    expect(voice.events).toContainEqual({
      type: "failed",
      message: "The speech models could not load: Kokoro unavailable",
    }),
  );
  voice.command({ type: "rest" });
  voice.start(false);
  await vi.waitFor(() =>
    expect(voice.events).toContainEqual({ type: "ready" }),
  );
  expect(speech.load).toHaveBeenCalledOnce();
  expect(speech.prepare).toHaveBeenCalledTimes(2);
  voice.command({ type: "rest" });
});

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
