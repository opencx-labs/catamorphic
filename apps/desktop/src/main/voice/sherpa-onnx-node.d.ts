// The parts of sherpa-onnx-node (a JavaScript N-API package without type
// declarations) the speech worker uses. Mirrors the package's types.js.
declare module "sherpa-onnx-node" {
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
    decodeAsync(stream: OfflineStream): Promise<{
      text: string;
      /** Each token's log probability, from the transducer's decoder. */
      ys_log_probs?: number[];
    }>;
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

  const sherpa: {
    OfflineRecognizer: typeof OfflineRecognizer;
    OfflineTts: typeof OfflineTts;
    GenerationConfig: typeof GenerationConfig;
  };
  export default sherpa;
}

