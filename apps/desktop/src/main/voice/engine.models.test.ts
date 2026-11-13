import { describe, expect, it } from "vitest";
import {
  VOICES,
  type VoiceAudioDown,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import { resample, VoiceEngine } from "./engine.js";
import { voiceModelPaths } from "./models.js";
import { loadSherpaSpeech } from "./sherpa-speech.js";

/**
 * Opt-in local Parakeet/Kokoro evaluation: every voice says a whole reply,
 * and explicit held recordings reach recognition only when released.
 * Set CATAMORPHIC_VOICE_MODELS_DIR to installed models.
 */
const MODELS = process.env.CATAMORPHIC_VOICE_MODELS_DIR;
const REPLY =
  "I started a session to fix the failing tests in the payments service. It is reading the logs now, and it will tell me what it finds.";

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

async function setup() {
  const parts = await loadSherpaSpeech({
    paths: voiceModelPaths(MODELS ?? ""),
    voice: "af_heart",
    speaking: true,
  });
  const events: VoiceWorkerEvent[] = [];
  const playback: ((
    clip: Extract<VoiceAudioDown, { type: "play" }>,
  ) => void)[] = [];
  const nextClip = () =>
    new Promise<Extract<VoiceAudioDown, { type: "play" }>>((resolve) =>
      playback.push(resolve),
    );
  const engine = new VoiceEngine(
    parts,
    (event) => events.push(event),
    (message) => {
      if (message.type === "play") playback.shift()?.(message);
    },
  );
  /** Feed audio as 20 ms microphone frames. */
  const hear = async (samples: Float32Array, sampleRate: number) => {
    const frame = Math.round(sampleRate * 0.02);
    for (let offset = 0; offset < samples.length; offset += frame) {
      engine.onAudio({
        type: "frame",
        samples: samples.slice(offset, offset + frame),
        sampleRate,
      });
      // Let recognition, which runs off-thread, make progress.
      if (offset % (frame * 10) === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { parts, engine, events, nextClip, hear };
}

describe.skipIf(!MODELS)("speech on the real models", () => {
  it("says a whole reply in every voice, every word of it", async () => {
    const { parts } = await setup();
    for (const voice of VOICES) {
      parts.setVoice?.(voice.id);
      const { samples, sampleRate } = await parts.synthesize(REPLY);
      // About 8 seconds of speech; a clip cut short would be far less.
      expect(samples.length / sampleRate).toBeGreaterThan(6);
      const heard = words(
        (await parts.recognize(resample(samples, sampleRate))).text,
      );
      const said = words(REPLY);
      const missing = said.filter((word) => !heard.includes(word));
      expect(missing.length, `${voice.name} lost ${missing}`).toBeLessThan(3);
    }
  }, 120_000);

  it("ignores audio outside a hold, including its own speech", async () => {
    const voice = await setup();
    const clip = await voice.parts.synthesize(REPLY);
    await voice.hear(clip.samples, clip.sampleRate);
    await voice.engine.recognized();
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual(
      [],
    );
  }, 120_000);

  it("interrupts playback on press and recognizes the held request after release", async () => {
    const voice = await setup();
    const person = await voice.parts.synthesize(
      "Wait, use the release branch instead.",
    );
    const playing = voice.nextClip();
    voice.engine.speak("reply", REPLY);
    await playing;
    expect(voice.engine.audible).toBe(true);
    voice.engine.hold(true);
    expect(voice.events).toContainEqual({ type: "barge-in" });
    await voice.hear(person.samples, person.sampleRate);
    await voice.engine.recognized();
    expect(voice.events.filter((event) => event.type === "utterance")).toEqual(
      [],
    );
    voice.engine.hold(false);
    await voice.engine.recognized();
    const heard = voice.events.find((event) => event.type === "utterance");
    expect(heard?.type === "utterance" && heard.text.toLowerCase()).toContain(
      "release branch",
    );
  }, 120_000);
});
