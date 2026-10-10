import sherpa from "sherpa-onnx-node";
import {
  SPEECH_SAMPLE_RATE,
  VOICES,
  type VoiceId,
  type VoiceModelPaths,
} from "../../shared/voice.js";
import {
  chime,
  concat,
  type SpeechParts,
  type VoiceActivity,
} from "./engine.js";

/**
 * The speech models (ADR 0216), all on sherpa-onnx and the CPU: Silero
 * voice activity, Parakeet TDT 0.6B recognition, a WeSpeaker voice print
 * on speech DPDFNet removed the noise from, and Kokoro v1.0 speech.
 * Kokoro speaks a text in one call that runs the model once per sentence,
 * and each sentence is handed on as soon as it is made. Its pauses are kept
 * as made (sherpa-onnx would shrink them to a fifth by default), and each
 * sentence loses the silence it starts with, so a sentence break is
 * Kokoro's own pause at the end of a sentence, not that pause plus the
 * next sentence's lead-in.
 * The addon's external buffers are refused by Electron's memory cage, so
 * every call that returns samples copies them (`enableExternalBuffer:
 * false`).
 */
export async function loadSherpaSpeech(
  paths: VoiceModelPaths,
  voice: VoiceId,
): Promise<SpeechParts> {
  const [recognizer, tts] = await Promise.all([
    sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: paths.asr.encoder,
          decoder: paths.asr.decoder,
          joiner: paths.asr.joiner,
        },
        tokens: paths.asr.tokens,
        numThreads: 4,
        provider: "cpu",
        modelType: "nemo_transducer",
      },
    }),
    sherpa.OfflineTts.createAsync({
      model: {
        kokoro: paths.tts,
        numThreads: 4,
        provider: "cpu",
      },
    }),
  ]);
  const generationFor = (id: VoiceId) =>
    new sherpa.GenerationConfig({
      sid: VOICES.find((candidate) => candidate.id === id)?.speaker ?? 0,
      silenceScale: 1,
    });
  let generation = generationFor(voice);
  const denoiser = new sherpa.OnlineSpeechDenoiser({
    model: {
      dpdfnet: { model: paths.denoiser },
      numThreads: 1,
      provider: "cpu",
    },
  });
  const speakers = new sherpa.SpeakerEmbeddingExtractor({
    model: paths.speaker,
    numThreads: 2,
  });
  return {
    activity: sileroActivity(paths.vad),
    denoise: (samples) => {
      // Each stretch is cleaned on its own, from a fresh start.
      denoiser.reset();
      return denoiser.run({
        samples,
        sampleRate: SPEECH_SAMPLE_RATE,
        enableExternalBuffer: false,
      }).samples;
    },
    voiceprint: (samples) => {
      const stream = speakers.createStream();
      stream.acceptWaveform({ samples, sampleRate: SPEECH_SAMPLE_RATE });
      stream.inputFinished();
      const embedding = Array.from(speakers.compute(stream, false));
      const length = Math.hypot(...embedding) || 1;
      return embedding.map((value) => value / length);
    },
    recognize: async (samples) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SPEECH_SAMPLE_RATE });
      return (await recognizer.decodeAsync(stream)).text;
    },
    synthesize: async (text, onSentence) => {
      const sentences: Float32Array[] = [];
      const { sampleRate } = tts;
      await tts.generateAsync({
        text,
        enableExternalBuffer: false,
        generationConfig: generation,
        onProgress: ({ samples }) => {
          const sentence = withoutLeadIn(samples, sampleRate);
          sentences.push(sentence);
          return onSentence?.({ samples: sentence, sampleRate }) ?? true;
        },
      });
      return { samples: concat(sentences), sampleRate };
    },
    cue: () => chime(24_000),
    setVoice: (next) => {
      generation = generationFor(next);
    },
  };
}

/** sherpa-onnx's threshold for silence in generated speech. */
const QUIET = 0.01;
/** Kept before the first sound, so a soft onset stays whole. */
const ONSET_SECONDS = 0.05;

/** A sentence without the silence before its first sound, copied. */
function withoutLeadIn(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  const onset = samples.findIndex((sample) => Math.abs(sample) > QUIET);
  if (onset < 0) return samples.slice();
  return samples.slice(
    Math.max(0, onset - Math.round(sampleRate * ONSET_SECONDS)),
  );
}

function sileroActivity(model: string): VoiceActivity {
  const windowSize = 512;
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model,
        threshold: 0.5,
        // Half a second of silence ends a turn: quick, yet a pause to
        // think mid-sentence rarely splits it.
        minSilenceDuration: 0.5,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize,
      },
      sampleRate: SPEECH_SAMPLE_RATE,
      numThreads: 1,
    },
    30,
  );
  return {
    windowSize,
    accept: (window) => vad.acceptWaveform(window),
    detected: () => vad.isDetected(),
    takeSegments: () => {
      const segments: Float32Array[] = [];
      while (!vad.isEmpty()) {
        segments.push(vad.front(false).samples);
        vad.pop();
      }
      return segments;
    },
  };
}
