import type { FakeSpeechScript } from "../../shared/voice.js";
import { SPEECH_SAMPLE_RATE } from "../../shared/voice.js";
import { chime, type SpeechParts } from "./engine.js";

const SPEECH_STARTS_AFTER = SPEECH_SAMPLE_RATE / 2;
const SPEECH_ENDS_AFTER = SPEECH_SAMPLE_RATE * 1.5;

/**
 * Scripted speech for end-to-end tests: no models, deterministic. Once
 * half a second of microphone audio has arrived (so the capture path is
 * proven to flow), the "person" talks for a second and is heard saying the
 * script's utterance: a stretch of a second and a half or more is all of
 * it, a shorter one its first words, as dictation hears it while the
 * person is still talking. Synthesis is a quiet tone as long as the words.
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
      reset: () => {
        segments.length = 0;
      },
    },
    recognize: async (heard) => {
      const words = script.utterance.split(/\s+/).filter(Boolean);
      const share = Math.min(1, heard.length / SPEECH_ENDS_AFTER);
      return {
        text: words.slice(0, Math.ceil(words.length * share)).join(" "),
        confidence: 0,
      };
    },
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
