import type { OfflineTts } from "sherpa-onnx-node";
import {
  SPEECH_SAMPLE_RATE,
  VOICES,
  type VoiceId,
  type VoiceModelPaths,
} from "../../shared/voice.js";
import { chime, concat, type SpeechParts } from "./engine.js";
import { NativeRecognition } from "./native-recognition.js";

/** Platform STT and Kokoro synthesis; dictation never loads synthesis. */
export async function loadSherpaSpeech({
  paths,
  voice,
  speaking,
}: {
  paths: VoiceModelPaths;
  voice: VoiceId;
  speaking: boolean;
}): Promise<SpeechParts> {
  let library: typeof import("sherpa-onnx-node")["default"] | null = null;
  let synthesis: Promise<OfflineTts> | null = null;
  const synthesizer = () => {
    const config = {
      model: { kokoro: paths.tts, numThreads: 4, provider: "cpu" as const },
    };
    synthesis ??= (
      library
        ? library.OfflineTts.createAsync(config)
        : import("sherpa-onnx-node").then(({ default: sherpa }) => {
            library = sherpa;
            return sherpa.OfflineTts.createAsync(config);
          })
    ).catch((cause: unknown) => {
      synthesis = null;
      throw cause;
    });
    return synthesis;
  };
  const recognition = paths.recognition;
  const native =
    recognition.kind === "native" ? new NativeRecognition(recognition) : null;
  // The native STT path does not even import the local inference runtime.
  if (!native) library = (await import("sherpa-onnx-node")).default;
  const recognitionLoad =
    recognition.kind === "parakeet" && library
      ? library.OfflineRecognizer.createAsync({
          featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: recognition.encoder,
              decoder: recognition.decoder,
              joiner: recognition.joiner,
            },
            tokens: recognition.tokens,
            numThreads: 4,
            provider: "cpu",
            modelType: "nemo_transducer",
          },
        })
      : null;
  const [recognizer] = await Promise.all([
    recognitionLoad,
    speaking && !native ? synthesizer() : null,
  ]);
  return {
    prepareSynthesis: async () => {
      await synthesizer();
    },
    cancelRecognition: () => native?.cancel(),
    dispose: () => native?.dispose(),
    recognize: async (samples) => {
      if (native) {
        await native.prepare();
        return native.recognize(samples);
      }
      if (!recognizer) throw new Error("Speech recognition is unavailable.");
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SPEECH_SAMPLE_RATE });
      const { text, ys_log_probs: probabilities = [] } =
        await recognizer.decodeAsync(stream);
      return {
        text,
        confidence:
          probabilities.reduce((sum, value) => sum + value, 0) /
          Math.max(1, probabilities.length),
      };
    },
    ...(native
      ? {
          startRecognition: (onPartial: (text: string) => void) =>
            native.start(onPartial),
        }
      : {}),
    synthesize: async (text, onSentence) => {
      // A later voice selection belongs to the next text, even when this
      // reply is still waiting for Kokoro to load.
      const selected = voice;
      const tts = await synthesizer();
      if (!library) throw new Error("Reply synthesis is unavailable.");
      const generationConfig = new library.GenerationConfig({
        sid:
          VOICES.find((candidate) => candidate.id === selected)?.speaker ?? 0,
        silenceScale: 1,
      });
      const sentences: Float32Array[] = [];
      const { sampleRate } = tts;
      await tts.generateAsync({
        text,
        enableExternalBuffer: false,
        generationConfig,
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
      voice = next;
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
