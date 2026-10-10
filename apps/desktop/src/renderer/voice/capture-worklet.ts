// The microphone tap of the audio page (ADR 0216). Runs in the
// AudioWorkletGlobalScope, whose globals TypeScript's DOM library lacks.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

/** 20 ms chunks: small enough for prompt detection, few enough messages. */
const CHUNK_SECONDS = 0.02;

class VoiceCapture extends AudioWorkletProcessor {
  private readonly size = Math.round(sampleRate * CHUNK_SECONDS);
  private chunk = new Float32Array(this.size);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.size - this.filled);
      this.chunk.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.size) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCapture);

export {};
