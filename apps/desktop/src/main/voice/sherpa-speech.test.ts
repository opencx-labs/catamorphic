import type { OfflineTts } from "sherpa-onnx-node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudioDown, VoiceWorkerEvent } from "../../shared/voice.js";
import { type SpeechClip, VoiceEngine } from "./engine.js";
import { voiceModelPaths } from "./models.js";
import { loadSherpaSpeech } from "./sherpa-speech.js";

const native = vi.hoisted(() => ({
  recognize: vi.fn(),
  prepareNative: vi.fn(),
  recognizeNative: vi.fn(),
  cancelNative: vi.fn(),
  disposeNative: vi.fn(),
  loadRecognition: vi.fn(),
  loadSynthesis: vi.fn<() => Promise<OfflineTts>>(),
  generate: vi.fn<OfflineTts["generateAsync"]>(),
}));

vi.mock("./native-recognition.js", () => ({
  NativeRecognition: class {
    prepare = native.prepareNative;
    recognize = native.recognizeNative;
    cancel = native.cancelNative;
    dispose = native.disposeNative;
  },
}));

vi.mock("sherpa-onnx-node", () => ({
  default: {
    OfflineRecognizer: { createAsync: native.loadRecognition },
    OfflineTts: { createAsync: native.loadSynthesis },
    GenerationConfig: class {
      constructor(readonly options: { sid: number; silenceScale: number }) {}
    },
  },
}));

const tts: OfflineTts = {
  sampleRate: 24_000,
  generateAsync: native.generate,
};
const sentence = new Float32Array([0.2, 0.4]);
const paths = voiceModelPaths("/models");

function pendingSynthesis() {
  let resolve!: (value: OfflineTts) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<OfflineTts>((loaded, failed) => {
    resolve = loaded;
    reject = failed;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.recognize.mockResolvedValue({
    text: "write these words",
    ys_log_probs: [-0.1],
  });
  native.loadRecognition.mockResolvedValue({
    createStream: () => ({ acceptWaveform() {} }),
    decodeAsync: native.recognize,
  });
  native.loadSynthesis.mockResolvedValue(tts);
  native.generate.mockImplementation(async ({ onProgress }) => {
    onProgress?.({ samples: sentence });
    return { samples: sentence, sampleRate: tts.sampleRate };
  });
});

describe("speech model demand loading", () => {
  it("uses Apple recognition on macOS without constructing local STT or requesting speech for read aloud", async () => {
    native.recognizeNative.mockResolvedValue({
      text: "native words",
      confidence: 0,
    });
    const parts = await loadSherpaSpeech({
      paths: {
        ...paths,
        recognition: {
          kind: "native",
          helperPath: "/app/speech-recognition",
          locale: "en-US",
        },
      },
      voice: "af_heart",
      speaking: true,
    });
    await parts.synthesize("Read this reply.");
    expect(native.loadRecognition).not.toHaveBeenCalled();
    expect(native.prepareNative).not.toHaveBeenCalled();
    await expect(parts.recognize(sentence)).resolves.toEqual({
      text: "native words",
      confidence: 0,
    });
    expect(native.prepareNative).toHaveBeenCalledOnce();
    expect(native.recognizeNative).toHaveBeenCalledWith(sentence);
    parts.cancelRecognition?.();
    expect(native.cancelNative).toHaveBeenCalledOnce();
    parts.dispose?.();
    expect(native.disposeNative).toHaveBeenCalledOnce();
  });

  it("prepares conversation and read-aloud synthesis alongside recognition", async () => {
    const loading = pendingSynthesis();
    native.loadSynthesis.mockReturnValue(loading.promise);
    const ready = vi.fn();
    const parts = loadSherpaSpeech({
      paths,
      voice: "af_heart",
      speaking: true,
    });
    void parts.then(ready);
    expect(native.loadRecognition).toHaveBeenCalledOnce();
    expect(native.loadSynthesis).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).not.toHaveBeenCalled();
    loading.resolve(tts);
    const prepared = await parts;
    await prepared.prepareSynthesis?.();
    await prepared.synthesize("Ready to speak.");
    expect(native.loadSynthesis).toHaveBeenCalledOnce();
  });

  it("can dictate and play a cue without loading synthesis", async () => {
    const parts = await loadSherpaSpeech({
      paths,
      voice: "af_heart",
      speaking: false,
    });
    const events: VoiceWorkerEvent[] = [];
    const engine = new VoiceEngine(
      parts,
      (event) => events.push(event),
      () => {},
    );
    engine.setDictation(true);
    engine.hold(true);
    engine.onAudio({
      type: "frame",
      samples: new Float32Array(16_000).fill(0.5),
      sampleRate: 16_000,
    });
    engine.hold(false);
    await engine.recognized();
    expect(events).toContainEqual({
      type: "dictation",
      segment: 1,
      text: "write these words",
      final: true,
    });
    expect(parts.cue().samples.length).toBeGreaterThan(0);
    expect(native.loadRecognition).toHaveBeenCalledOnce();
    expect(native.loadSynthesis).not.toHaveBeenCalled();
    engine.close();
  });

  it("shares the first synthesis load and keeps each text's selected voice", async () => {
    const loading = pendingSynthesis();
    native.loadSynthesis.mockReturnValue(loading.promise);
    const parts = await loadSherpaSpeech({
      paths,
      voice: "af_heart",
      speaking: false,
    });
    const first = parts.synthesize("First reply.");
    parts.setVoice?.("am_michael");
    const second = parts.synthesize("Second reply.");
    expect(native.loadSynthesis).toHaveBeenCalledOnce();
    expect(native.generate).not.toHaveBeenCalled();
    loading.resolve(tts);
    await Promise.all([first, second]);
    expect(
      native.generate.mock.calls.map(([request]) => request.generationConfig),
    ).toEqual([
      { options: { sid: 3, silenceScale: 1 } },
      { options: { sid: 16, silenceScale: 1 } },
    ]);
    await parts.synthesize("Warm reply.");
    expect(native.loadSynthesis).toHaveBeenCalledOnce();
    expect(native.generate).toHaveBeenCalledTimes(3);
    expect(native.loadSynthesis).toHaveBeenCalledWith({
      model: { kokoro: paths.tts, numThreads: 4, provider: "cpu" },
    });
  });

  it("retries a failed synthesis load without reloading recognition", async () => {
    native.loadSynthesis.mockRejectedValueOnce(
      new Error("could not load Kokoro"),
    );
    const parts = await loadSherpaSpeech({
      paths,
      voice: "af_heart",
      speaking: false,
    });
    await expect(parts.synthesize("First reply.")).rejects.toThrow(
      "could not load Kokoro",
    );
    await expect(parts.recognize(sentence)).resolves.toEqual({
      text: "write these words",
      confidence: -0.1,
    });
    await expect(parts.synthesize("Try again.")).resolves.toEqual({
      samples: sentence,
      sampleRate: 24_000,
    });
    expect(native.loadSynthesis).toHaveBeenCalledTimes(2);
    expect(native.loadRecognition).toHaveBeenCalledOnce();
  });

  it("still streams copied sentences and honors cancellation after a cold load", async () => {
    const parts = await loadSherpaSpeech({
      paths,
      voice: "af_heart",
      speaking: false,
    });
    native.generate.mockImplementationOnce(async (request) => {
      expect(request.enableExternalBuffer).toBe(false);
      const samples = new Float32Array(4_800);
      samples[3_600] = 0.5;
      expect(request.onProgress?.({ samples })).toBe(false);
      return { samples, sampleRate: 24_000 };
    });
    const onSentence = vi.fn<(sentence: SpeechClip) => boolean>(() => false);
    const clip = await parts.synthesize("One sentence.", onSentence);
    const streamed = onSentence.mock.calls[0]?.[0];
    expect(streamed).toEqual({ samples: clip.samples, sampleRate: 24_000 });
    expect(clip.samples.length).toBe(2_400);
  });

  it.each(["stop", "retarget", "dictate"])(
    "drops cold speech after %s and reuses synthesis for the next reply",
    async (action) => {
      const loading = pendingSynthesis();
      native.loadSynthesis.mockReturnValue(loading.promise);
      const parts = await loadSherpaSpeech({
        paths,
        voice: "af_heart",
        speaking: false,
      });
      const audio: VoiceAudioDown[] = [];
      const events: VoiceWorkerEvent[] = [];
      const engine = new VoiceEngine(
        parts,
        (event) => events.push(event),
        (message) => audio.push(message),
      );
      engine.speak("old", "Old chat's reply.");
      if (action === "dictate") engine.setDictation(true);
      else engine.stopSpeaking();
      if (action === "retarget") engine.close();
      const next =
        action === "retarget"
          ? new VoiceEngine(
              parts,
              (event) => events.push(event),
              (message) => audio.push(message),
            )
          : engine;
      next.setVoice("am_michael");
      if (action === "dictate") next.setDictation(false);
      next.speak("new", "New reply.");
      loading.resolve(tts);
      await vi.waitFor(() => expect(native.generate).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(audio.filter((message) => message.type === "play")).toHaveLength(
          1,
        ),
      );
      expect(events).toContainEqual({
        type: "spoken",
        id: "old",
        interrupted: true,
      });
      expect(events.filter((event) => event.type === "failed")).toEqual([]);
      expect(native.loadSynthesis).toHaveBeenCalledOnce();
      next.stopSpeaking();
      next.close();
    },
  );

  it.each(["stop", "rest", "dictate"])(
    "ignores a synthesis load rejected after %s and lets the next reply retry",
    async (action) => {
      const loading = pendingSynthesis();
      native.loadSynthesis.mockReturnValueOnce(loading.promise);
      const parts = await loadSherpaSpeech({
        paths,
        voice: "af_heart",
        speaking: false,
      });
      const events: VoiceWorkerEvent[] = [];
      const audio: VoiceAudioDown[] = [];
      const engine = new VoiceEngine(
        parts,
        (event) => events.push(event),
        (message) => audio.push(message),
      );
      engine.speak("old", "Old reply.");
      if (action === "dictate") engine.setDictation(true);
      else engine.stopSpeaking();
      if (action === "rest") engine.close();
      // The same engine may have a new reply queued before the old load
      // fails. A rested worker starts a fresh engine with the same parts.
      if (action === "stop") engine.speak("new", "New reply.");
      loading.reject(new Error("late initialization failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.filter((event) => event.type === "failed")).toEqual([]);
      if (action === "dictate") {
        engine.setDictation(false);
        engine.speak("new", "New reply.");
      }
      const next =
        action === "rest"
          ? new VoiceEngine(
              parts,
              (event) => events.push(event),
              (message) => audio.push(message),
            )
          : engine;
      if (action === "rest") next.speak("new", "New reply.");
      await vi.waitFor(() => expect(native.generate).toHaveBeenCalledOnce());
      expect(native.loadSynthesis).toHaveBeenCalledTimes(2);
      expect(audio.filter((message) => message.type === "play")).toHaveLength(
        1,
      );
      next.stopSpeaking();
      next.close();
    },
  );

  it("reports a current reply's initialization failure and retries after rest", async () => {
    native.loadSynthesis.mockRejectedValueOnce(new Error("Kokoro unavailable"));
    const parts = await loadSherpaSpeech({
      paths,
      voice: "af_heart",
      speaking: false,
    });
    const events: VoiceWorkerEvent[] = [];
    const engine = new VoiceEngine(
      parts,
      (event) => events.push(event),
      () => {},
    );
    engine.speak("old", "First reply.");
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "failed",
        message: "Speech synthesis failed: Kokoro unavailable",
      }),
    );
    engine.stopSpeaking();
    engine.close();
    const audio: VoiceAudioDown[] = [];
    const next = new VoiceEngine(
      parts,
      () => {},
      (message) => audio.push(message),
    );
    next.speak("new", "Try again.");
    await vi.waitFor(() =>
      expect(audio.filter((message) => message.type === "play")).toHaveLength(
        1,
      ),
    );
    expect(native.loadSynthesis).toHaveBeenCalledTimes(2);
    next.stopSpeaking();
    next.close();
  });

  it.each(["dictation", "close", "failure"])(
    "starts synthesis only for the first reply after dictation and handles %s during loading",
    async (ending) => {
      const loading = pendingSynthesis();
      native.loadSynthesis.mockReturnValueOnce(loading.promise);
      const parts = await loadSherpaSpeech({
        paths,
        voice: "af_heart",
        speaking: false,
      });
      const events: VoiceWorkerEvent[] = [];
      const engine = new VoiceEngine(
        parts,
        (event) => events.push(event),
        () => {},
      );
      engine.setDictation(true);
      expect(native.loadSynthesis).not.toHaveBeenCalled();
      engine.setDictation(false);
      expect(native.loadSynthesis).not.toHaveBeenCalled();
      engine.speak("reply", "Read this reply.");
      expect(native.loadSynthesis).toHaveBeenCalledOnce();
      if (ending === "dictation") engine.setDictation(true);
      if (ending === "close") {
        engine.stopSpeaking();
        engine.close();
      }
      loading.reject(new Error("preparation failed"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.filter((event) => event.type === "failed")).toEqual(
        ending === "failure"
          ? [
              {
                type: "failed",
                message: "Speech synthesis failed: preparation failed",
              },
            ]
          : [],
      );
      await parts.prepareSynthesis?.();
      expect(native.loadSynthesis).toHaveBeenCalledTimes(2);
      engine.close();
    },
  );
});
