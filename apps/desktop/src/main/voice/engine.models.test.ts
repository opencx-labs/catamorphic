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
 * The real models (ADR 0216): every voice says a whole reply, and the
 * recognizer hears all of it; turn-taking holds with no echo cancellation
 * at all, the agent's voice fed straight back into the microphone. Opt-in:
 * set CATAMORPHIC_VOICE_MODELS_DIR to installed models.
 */
const MODELS = process.env.CATAMORPHIC_VOICE_MODELS_DIR;
const REPLY =
  "I started a session to fix the failing tests in the payments service. It is reading the logs now, and it will tell me what it finds.";

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

async function setup() {
  const parts = await loadSherpaSpeech(
    voiceModelPaths(MODELS ?? ""),
    "af_heart",
  );
  const events: VoiceWorkerEvent[] = [];
  const played: Extract<VoiceAudioDown, { type: "play" }>[] = [];
  const engine = new VoiceEngine(
    parts,
    (event) => events.push(event),
    (message) => {
      if (message.type === "play") played.push(message);
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
  const quiet = (seconds: number) =>
    hear(new Float32Array(16_000 * seconds), 16_000);
  const waitFor = async (done: () => boolean) => {
    for (let tick = 0; tick < 500 && !done(); tick++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { parts, engine, events, played, hear, quiet, waitFor };
}

describe.skipIf(!MODELS)("speech on the real models", () => {
  it("says a whole reply in every voice, every word of it", async () => {
    const { parts } = await setup();
    for (const voice of VOICES) {
      parts.setVoice?.(voice.id);
      const { samples, sampleRate } = await parts.synthesize(REPLY);
      // About 8 seconds of speech; a clip cut short would be far less.
      expect(samples.length / sampleRate).toBeGreaterThan(6);
      const heard = words(await parts.recognize(resample(samples, sampleRate)));
      const said = words(REPLY);
      const missing = said.filter((word) => !heard.includes(word));
      expect(missing.length, `${voice.name} lost ${missing}`).toBeLessThan(3);
    }
  }, 120_000);

  it("never answers its own voice coming back through the speakers", async () => {
    const voice = await setup();
    voice.engine.speak("reply", REPLY);
    await voice.waitFor(() => voice.played.length > 0);
    const [clip] = voice.played;
    expect(clip).toBeDefined();
    if (clip) await voice.hear(clip.samples, clip.sampleRate);
    await voice.quiet(1.5);
    await voice.waitFor(() => false);
    const types = voice.events.map((event) => event.type);
    expect(types).not.toContain("barge-in");
    expect(types).not.toContain("utterance");
  }, 120_000);

  it("stops when the person talks over it, and hears what they said", async () => {
    const voice = await setup();
    voice.parts.setVoice?.("am_michael");
    const person = await voice.parts.synthesize(
      "Wait, use the release branch instead.",
    );
    voice.parts.setVoice?.("af_heart");
    voice.engine.speak("reply", REPLY);
    await voice.waitFor(() => voice.played.length > 0);
    expect(voice.engine.audible).toBe(true);
    await voice.quiet(0.3);
    await voice.hear(person.samples, person.sampleRate);
    await voice.quiet(1.5);
    await voice.waitFor(() =>
      voice.events.some((event) => event.type === "utterance"),
    );
    expect(voice.events).toContainEqual({ type: "barge-in" });
    const heard = voice.events.find((event) => event.type === "utterance");
    expect(heard?.type === "utterance" && heard.text.toLowerCase()).toContain(
      "release branch",
    );
  }, 120_000);

  it("learns the person's voice, then ignores someone else's", async () => {
    const voice = await setup();
    const say = async (id: (typeof VOICES)[number]["id"], text: string) => {
      voice.parts.setVoice?.(id);
      return voice.parts.synthesize(text);
    };
    const person = await say(
      "am_michael",
      "I'd like to check on the build first, and then look at the docs session. After that, tell me what the payments team decided about the release date.",
    );
    const someoneElse = await say(
      "af_heart",
      "Breaking news tonight: the city council voted to close the old bridge for repairs next month.",
    );
    const personAgain = await say(
      "am_michael",
      "Can you tell me which sessions are running right now?",
    );
    const count = (type: VoiceWorkerEvent["type"]) =>
      voice.events.filter((event) => event.type === type).length;
    voice.engine.learn();
    await voice.hear(person.samples, person.sampleRate);
    await voice.quiet(1);
    await voice.waitFor(() => count("learned") > 0);
    expect(count("learned")).toBe(1);
    expect(count("utterance")).toBe(0);
    await voice.hear(someoneElse.samples, someoneElse.sampleRate);
    await voice.quiet(1);
    await voice.waitFor(() => count("ignored") > 0);
    expect(count("ignored")).toBeGreaterThan(0);
    expect(count("utterance")).toBe(0);
    await voice.hear(personAgain.samples, personAgain.sampleRate);
    await voice.quiet(1);
    await voice.waitFor(() => count("utterance") > 0);
    const heard = voice.events.find((event) => event.type === "utterance");
    expect(heard?.type === "utterance" && heard.text.toLowerCase()).toContain(
      "running",
    );
  }, 120_000);
});
