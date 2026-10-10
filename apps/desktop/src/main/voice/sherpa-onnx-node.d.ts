// The parts of sherpa-onnx-node (a JavaScript N-API package without type
// declarations) the speech worker uses. Mirrors the package's types.js.
declare module "sherpa-onnx-node" {
  export interface VadConfig {
    sileroVad: {
      model: string;
      threshold: number;
      minSilenceDuration: number;
      minSpeechDuration: number;
      maxSpeechDuration: number;
      windowSize: number;
    };
    sampleRate: number;
    numThreads: number;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(enableExternalBuffer?: boolean): { samples: Float32Array };
    pop(): void;
  }

  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: "cpu";
      modelType: "nemo_transducer";
    };
  }

  export class OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    static createAsync(
      config: OfflineRecognizerConfig,
    ): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
  }

  export interface OfflineTtsConfig {
    model: {
      kokoro: {
        model: string;
        voices: string;
        tokens: string;
        lexicon: string;
        dataDir: string;
      };
      numThreads: number;
      provider: "cpu";
    };
  }

  export class GenerationConfig {
    constructor(options: { sid: number; silenceScale: number });
  }

  export class OfflineTts {
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly sampleRate: number;
    generateAsync(request: {
      text: string;
      enableExternalBuffer: false;
      generationConfig: GenerationConfig;
      onProgress?: (info: { samples: Float32Array }) => boolean;
    }): Promise<{ samples: Float32Array; sampleRate: number }>;
  }

  /** Streaming noise removal. */
  export class OnlineSpeechDenoiser {
    constructor(config: {
      model: {
        dpdfnet: { model: string };
        numThreads: number;
        provider: "cpu";
      };
    });
    run(request: {
      samples: Float32Array;
      sampleRate: number;
      enableExternalBuffer: false;
    }): { samples: Float32Array };
    reset(): void;
  }

  export interface SpeakerEmbeddingStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: { model: string; numThreads: number });
    createStream(): SpeakerEmbeddingStream;
    compute(
      stream: SpeakerEmbeddingStream,
      enableExternalBuffer?: boolean,
    ): Float32Array;
  }

  const sherpa: {
    Vad: typeof Vad;
    OnlineSpeechDenoiser: typeof OnlineSpeechDenoiser;
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
    OfflineRecognizer: typeof OfflineRecognizer;
    OfflineTts: typeof OfflineTts;
    GenerationConfig: typeof GenerationConfig;
  };
  export default sherpa;
}

