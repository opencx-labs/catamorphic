/**
 * Local speech accuracy and latency for complete push-to-talk recordings.
 * LibriSpeech phrases are mixed with DEMAND room noise, then recognized as
 * one held recording each. No automatic listening or speaker enrollment.
 *
 *   bun apps/desktop/scripts/voice-benchmark/index.ts fetch
 *   CATAMORPHIC_VOICE_MODELS_DIR=/path/to/models bun apps/desktop/scripts/voice-benchmark/index.ts [--only office,café,soft,synthesis]
 *
 * `fetch` downloads LibriSpeech dev-clean-2 and DEMAND rooms. Running an
 * evaluation reads those local files and installed Parakeet/Kokoro models.
 */
import { performance } from "node:perf_hooks";
import { resample, type SpeechParts } from "../../src/main/voice/engine.js";
import { voiceModelPaths } from "../../src/main/voice/models.js";
import { loadSherpaSpeech } from "../../src/main/voice/sherpa-speech.js";
import { VOICES } from "../../src/shared/voice.js";
import { fetchData, type Room, room, samples, utterances } from "./data.js";
import {
  activeLevel,
  convolve,
  editDistance,
  gain,
  room as impulse,
  mix,
  RATE,
  rms,
  words,
} from "./signal.js";

interface Scenario {
  name: string;
  room: Room;
  snr: number;
  level: number;
}

async function recordings(parts: SpeechParts, scenario: Scenario) {
  const corpus = utterances();
  const speakers = [...new Set(corpus.map((u) => u.speaker))]
    .sort()
    .slice(0, 8);
  const background = room(scenario.room);
  let errors = 0;
  let total = 0;
  let count = 0;
  let missed = 0;
  let seconds = 0;
  let elapsed = 0;
  for (const [index, speaker] of speakers.entries()) {
    const phrases = corpus
      .filter((u) => u.speaker === speaker && u.seconds >= 2 && u.seconds <= 9)
      .slice(0, 5);
    const response = impulse(0.3, 12, 100 + index);
    for (const phrase of phrases) {
      const speech = convolve(samples(phrase.file), response);
      const held = gain(speech, scenario.level - activeLevel(speech));
      const start =
        Math.round(index * 37 * RATE) %
        Math.max(1, background.length - held.length);
      const noise = background.slice(start, start + held.length);
      mix(held, gain(noise, scenario.level - scenario.snr - rms(noise)));
      const began = performance.now();
      const recognized = await parts.recognize(held);
      elapsed += (performance.now() - began) / 1000;
      seconds += held.length / RATE;
      const reference = words(phrase.text);
      const heard = words(recognized.text);
      errors += editDistance(reference, heard);
      total += reference.length;
      count += 1;
      if (!heard.length) missed += 1;
    }
  }
  if (!count)
    throw new Error("No phrases found in the local benchmark corpus.");
  return {
    recordings: count,
    "word errors": `${((100 * errors) / Math.max(1, total)).toFixed(1)}%`,
    missed,
    "recognition seconds/recording": +(elapsed / count).toFixed(3),
    "recognition seconds/audio second": +(elapsed / seconds).toFixed(3),
  };
}

async function synthesis(parts: SpeechParts) {
  const text =
    "The tests pass on the main branch. I can check your changes next and tell you what I find.";
  const table: Record<string, Record<string, string | number>> = {};
  for (const voice of VOICES) {
    parts.setVoice?.(voice.id);
    const began = performance.now();
    const reply = await parts.synthesize(text);
    const seconds = reply.samples.length / reply.sampleRate;
    const elapsed = (performance.now() - began) / 1000;
    const heard = await parts.recognize(
      resample(reply.samples, reply.sampleRate),
    );
    const reference = words(text);
    table[voice.name] = {
      "audio seconds": +seconds.toFixed(2),
      "synthesis seconds/audio second": +(
        elapsed / Math.max(0.001, seconds)
      ).toFixed(3),
      "round-trip word errors": `${((100 * editDistance(reference, words(heard.text))) / reference.length).toFixed(1)}%`,
    };
  }
  return table;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "fetch") {
    fetchData();
    return;
  }
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? args[onlyAt + 1]?.split(",") : undefined;
  const want = (name: string) =>
    !only || only.some((prefix) => name.startsWith(prefix));
  const models = process.env.CATAMORPHIC_VOICE_MODELS_DIR;
  if (!models)
    throw new Error(
      "Set CATAMORPHIC_VOICE_MODELS_DIR to installed local speech models.",
    );
  // This opt-in benchmark measures Parakeet explicitly on every platform.
  const parts = await loadSherpaSpeech({
    paths: voiceModelPaths(models),
    voice: "af_heart",
    speaking: true,
  });
  const scenarios: Scenario[] = [
    { name: "office", room: "OOFFICE", snr: 30, level: -26 },
    { name: "soft microphone", room: "OOFFICE", snr: 20, level: -44 },
    { name: "café", room: "PCAFETER", snr: 10, level: -26 },
  ];
  const table: Record<string, Record<string, string | number>> = {};
  for (const scenario of scenarios) {
    if (want(scenario.name))
      table[scenario.name] = await recordings(parts, scenario);
  }
  if (Object.keys(table).length) console.table(table);
  if (want("synthesis")) console.table(await synthesis(parts));
}

await main();
process.exit(0);
