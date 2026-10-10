import type { FakeSpeechScript } from "../../shared/voice.js";
import { SPEECH_SAMPLE_RATE } from "../../shared/voice.js";
import { chime, type SpeechParts } from "./engine.js";

const SPEECH_STARTS_AFTER = SPEECH_SAMPLE_RATE / 2;
const SPEECH_ENDS_AFTER = SPEECH_SAMPLE_RATE * 1.5;

/**
 * Scripted speech for end-to-end tests: no models, deterministic. Once
 * half a second of microphone audio has arrived (so the capture path is
 * proven to flow), the "person" talks for a second and is heard saying the
 * script's utterance. Synthesis is a quiet tone as long as the words.
 */
export function fakeSpeech(script: FakeSpeechScript): SpeechParts {
  let samples = 0;
  let heard = false;
  const segments: Float32Array[] = [];
  return {
    activity: {
      windowSize: 512,
      accept: (window) => {
        samples += window.length;
        if (!heard && samples >= SPEECH_ENDS_AFTER) {
          heard = true;
          segments.push(
            new Float32Array(SPEECH_ENDS_AFTER - SPEECH_STARTS_AFTER),
          );
        }
      },
      detected: () =>
        !heard && samples >= SPEECH_STARTS_AFTER && samples < SPEECH_ENDS_AFTER,
      takeSegments: () => segments.splice(0),
    },
    recognize: async () => script.utterance,
    synthesize: async (text, onSentence) => {
      const sampleRate = 24_000;
      const words = text.split(/\s+/).filter(Boolean).length;
      const length = Math.round(sampleRate * Math.min(2, 0.06 * words));
      const samples = new Float32Array(length);
      for (let i = 0; i < length; i++)
        samples[i] = 0.02 * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
      onSentence?.({ samples, sampleRate });
      return { samples, sampleRate };
    },
    cue: () => chime(24_000),
    // One voice for everyone: a learned voice print always matches.
    voiceprint: () => [1],
  };
}
