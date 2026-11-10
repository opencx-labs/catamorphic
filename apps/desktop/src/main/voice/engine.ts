import {
  SPEECH_SAMPLE_RATE,
  type VoiceAudioDown,
  type VoiceAudioUp,
  type VoiceId,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import { meaningfulUtterance } from "./speech-text.js";

/** Bound recognition memory without splitting a held message into turns. */
const CHUNK_SAMPLES = 30 * SPEECH_SAMPLE_RATE;

export interface SpeechClip {
  samples: Float32Array;
  sampleRate: number;
}

export interface Recognized {
  text: string;
  confidence: number;
}

/** Platform recognition and local reply synthesis, real or scripted in tests. */
export interface SpeechParts {
  recognize(samples: Float32Array): Promise<Recognized>;
  prepareSynthesis?(): Promise<void>;
  synthesize(
    text: string,
    onSentence?: (sentence: SpeechClip) => boolean,
  ): Promise<SpeechClip>;
  cue(): SpeechClip;
  setVoice?(voice: VoiceId): void;
  cancelRecognition?(): void;
  dispose?(): void;
}

interface Utterance {
  id: string;
  text: string;
}

interface Hold {
  segment: number;
  epoch: number;
  dictation: boolean;
  chunks: Float32Array[];
  samples: number;
  words: string[];
  dictated: boolean;
}

/**
 * Push to talk: capture only while held, recognize on release, and keep
 * each hold one message. Pauses never end a turn. Replies wait behind a
 * hold; pressing again interrupts playback immediately.
 */
export class VoiceEngine {
  private holding: Hold | null = null;
  private segment = 0;
  private epoch = 0;
  private dictation = false;
  private listening = true;
  private closed = false;
  private recognizing: Promise<void> = Promise.resolve();
  private readonly queue: Utterance[] = [];
  private current: Utterance | null = null;
  private synthesizing = false;
  private generation = 0;
  private sentSeq = 0;
  private drainedSeq = 0;
  private readonly playing: string[] = [];

  constructor(
    private readonly parts: SpeechParts,
    private readonly events: (event: VoiceWorkerEvent) => void,
    private readonly audio: (message: VoiceAudioDown) => void,
  ) {}

  private emit(event: VoiceWorkerEvent): void {
    if (!this.closed) this.events(event);
  }

  get audible(): boolean {
    return (
      this.synthesizing ||
      this.current !== null ||
      this.queue.length > 0 ||
      this.drainedSeq < this.sentSeq
    );
  }

  recognized(): Promise<void> {
    return this.recognizing;
  }

  onAudio(message: VoiceAudioUp): void {
    if (message.type === "frame") {
      const hold = this.holding;
      if (!hold || !this.listening) return;
      const samples = resample(message.samples, message.sampleRate);
      let offset = 0;
      while (offset < samples.length) {
        const take = Math.min(
          samples.length - offset,
          CHUNK_SAMPLES - hold.samples,
        );
        hold.chunks.push(samples.slice(offset, offset + take));
        hold.samples += take;
        offset += take;
        if (hold.samples === CHUNK_SAMPLES) this.hear(hold, { final: false });
      }
    } else if (message.type === "drained") {
      this.drainedSeq = Math.max(this.drainedSeq, message.seq);
      this.settlePlayback();
    } else if (message.type === "levels" || message.type === "microphone") {
      this.emit(message);
    } else this.emit({ type: "failed", message: message.message });
  }

  speak(id: string, text: string): void {
    if (!text.trim()) return;
    this.queue.push({ id, text });
    void this.drainSpeech();
  }

  setVoice(voice: VoiceId): void {
    this.parts.setVoice?.(voice);
  }

  setDictation(enabled: boolean): void {
    if (this.dictation === enabled) return;
    this.forget();
    this.dictation = enabled;
    this.stopSpeaking();
    if (!enabled && this.parts.prepareSynthesis) {
      const generation = this.generation;
      void this.parts.prepareSynthesis().catch((cause: unknown) => {
        if (generation !== this.generation || this.dictation) return;
        this.emit({
          type: "failed",
          message: `Speech synthesis failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      });
    }
  }

  hold(held: boolean, { release }: { release?: number } = {}): void {
    if (!this.listening || held === (this.holding !== null)) return;
    if (held) {
      if (this.audible) {
        this.stopSpeaking();
        this.emit({ type: "barge-in" });
      }
      this.holding = {
        segment: ++this.segment,
        epoch: this.epoch,
        dictation: this.dictation,
        chunks: [],
        samples: 0,
        words: [],
        dictated: false,
      };
      this.emit({ type: "speech-start", segment: this.segment });
      return;
    }
    const hold = this.holding;
    if (!hold) return;
    this.holding = null;
    this.emit({ type: "speech-end" });
    this.hear(hold, { final: true, release });
    void this.drainSpeech();
  }

  stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    this.forget();
    this.audio({ type: "close-microphone" });
    void this.drainSpeech();
  }

  forget(): void {
    this.epoch += 1;
    // Abandoned native preparation/inference must not block the next target.
    this.parts.cancelRecognition?.();
    if (this.holding) this.emit({ type: "speech-end" });
    this.holding = null;
  }

  close(): void {
    this.closed = true;
    this.stopListening();
  }

  audioReplaced(): void {
    this.drainedSeq = this.sentSeq;
    this.settlePlayback();
    if (!this.listening) this.audio({ type: "close-microphone" });
  }

  cue(): void {
    const { samples, sampleRate } = this.parts.cue();
    this.send(samples, sampleRate);
  }

  stopSpeaking(): void {
    const stopped = [
      ...this.playing.splice(0),
      ...(this.current ? [this.current.id] : []),
      ...this.queue.splice(0).map((utterance) => utterance.id),
    ];
    this.current = null;
    this.generation += 1;
    this.sentSeq += 1;
    this.drainedSeq = this.sentSeq;
    this.audio({ type: "flush", seq: this.sentSeq });
    for (const id of new Set(stopped))
      this.emit({ type: "spoken", id, interrupted: true });
  }

  private hear(
    hold: Hold,
    { final, release }: { final: boolean; release?: number },
  ): void {
    const samples = concat(hold.chunks);
    const segment = hold.segment;
    if (hold.dictation && !final) hold.segment = ++this.segment;
    hold.chunks = [];
    hold.samples = 0;
    const live = () =>
      this.listening && !this.closed && hold.epoch === this.epoch;
    this.recognizing = this.recognizing
      .then(async () => {
        if (!live()) return;
        const { text } =
          samples.length > 0
            ? await this.parts.recognize(samples)
            : { text: "" };
        if (!live()) return;
        const words = meaningfulUtterance(text.trim()) ? text.trim() : "";
        if (hold.dictation) {
          this.emit({ type: "dictation", segment, text: words, final: true });
          hold.dictated ||= words.length > 0;
        } else if (words) hold.words.push(words);
        if (!final) return;
        const said = hold.words.join(" ");
        if (said) this.emit({ type: "utterance", text: said, segment });
        else if (!hold.dictated)
          this.emit({
            type: "unheard",
            ...(release !== undefined ? { release } : {}),
          });
      })
      .catch((cause: unknown) => {
        if (!live()) return;
        this.emit({
          type: "failed",
          message: `Listening failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      });
  }

  private async drainSpeech(): Promise<void> {
    if (this.synthesizing || this.holding || this.closed) return;
    this.synthesizing = true;
    try {
      while (this.queue.length > 0 && !this.holding && !this.closed) {
        const utterance = this.queue.shift();
        if (!utterance) break;
        this.current = utterance;
        const generation = this.generation;
        this.emit({ type: "speaking", id: utterance.id });
        try {
          await this.parts.synthesize(utterance.text, (sentence) => {
            if (generation !== this.generation) return false;
            this.send(sentence.samples, sentence.sampleRate);
            return true;
          });
        } catch (cause) {
          // A load or inference that outlived its reply must not stop a
          // new one. Let the newer queue retry a failed model load.
          if (generation !== this.generation) continue;
          throw cause;
        }
        if (generation !== this.generation) continue;
        this.playing.push(utterance.id);
        this.current = null;
      }
    } catch (cause) {
      this.emit({
        type: "failed",
        message: `Speech synthesis failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    } finally {
      this.synthesizing = false;
      this.settlePlayback();
    }
  }

  private send(samples: Float32Array, sampleRate: number): void {
    this.sentSeq += 1;
    this.audio({ type: "play", seq: this.sentSeq, samples, sampleRate });
  }

  private settlePlayback(): void {
    if (this.synthesizing || this.drainedSeq < this.sentSeq) return;
    for (const id of this.playing.splice(0))
      this.emit({ type: "spoken", id, interrupted: false });
  }
}

export function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Linear resampling to recognition's 16 kHz, mono in and out, for audio
 * that does not arrive at it already.
 */
export function resample(samples: Float32Array, rate: number): Float32Array {
  if (rate === SPEECH_SAMPLE_RATE) return samples;
  const ratio = rate / SPEECH_SAMPLE_RATE;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[index] =
      (samples[left] ?? 0) * (1 - weight) + (samples[right] ?? 0) * weight;
  }
  return out;
}

/** Two soft rising notes, 160 ms in all. */
export function chime(sampleRate: number): SpeechClip {
  const note = Math.round(sampleRate * 0.08);
  const samples = new Float32Array(note * 2);
  for (const [index, frequency] of [660, 880].entries()) {
    for (let i = 0; i < note; i++) {
      const envelope = Math.sin((Math.PI * i) / note);
      samples[index * note + i] =
        0.12 * envelope * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    }
  }
  return { samples, sampleRate };
}
