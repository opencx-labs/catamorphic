import {
  SPEECH_SAMPLE_RATE,
  type VoiceAudioDown,
  type VoiceAudioUp,
  type VoiceId,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import { isEcho, meaningfulUtterance } from "./speech-text.js";

/**
 * Audio kept from before detection fires, which lags speech onset: about
 * half a second on soft speech, so a first word is never cut.
 */
const PREROLL_SECONDS = 0.8;
/** The longest utterance kept for recognition. */
const UTTERANCE_MAX_SECONDS = 30;
/** How much of what was said recently an echo is checked against. */
const RECENT_SPEECH_CHARS = 600;
/** Speech a voice print is learned from. */
const LEARN_SECONDS = 6;
/** Shorter speech is too little to check against the voice print. */
const VERIFY_MIN_SECONDS = 0.8;
/**
 * How alike a voice must be to the voice print to be the person's. With
 * WeSpeaker ResNet34 the same speaker scored 0.84 or more on clean
 * speech and other people 0.59 on average (0.73 at the 90th percentile);
 * the margin leaves room for a different microphone and a noisy room.
 */
const SAME_VOICE = 0.65;

/** Voice activity at 16 kHz, fed one fixed-size window at a time. */
export interface VoiceActivity {
  readonly windowSize: number;
  accept(window: Float32Array): void;
  /** True from the start of speech until its trailing silence. */
  detected(): boolean;
  /** Speech segments completed since the last call, oldest first. */
  takeSegments(): Float32Array[];
}

/** Mono audio at its own sample rate. */
export interface SpeechClip {
  samples: Float32Array;
  sampleRate: number;
}

/** The models behind the engine: real ones in the app, scripted in tests. */
export interface SpeechParts {
  activity: VoiceActivity;
  recognize(samples: Float32Array): Promise<string>;
  /**
   * All the speech for a text. Each sentence also goes to `onSentence` as
   * soon as it is made, in order; returning false stops the rest.
   */
  synthesize(
    text: string,
    onSentence?: (sentence: SpeechClip) => boolean,
  ): Promise<SpeechClip>;
  /** A short "heard you" sound. */
  cue(): SpeechClip;
  /** Speak in another voice from the next text on. */
  setVoice?(voice: VoiceId): void;
  /** Noise removed from a stretch of 16 kHz speech. */
  denoise?(samples: Float32Array): Float32Array;
  /** Who is speaking in 16 kHz speech, as a unit-length embedding. */
  voiceprint?(samples: Float32Array): number[];
}

interface Utterance {
  id: string;
  text: string;
}

/**
 * Turn-taking between the person and the agent's voice. Runs in the speech
 * worker: microphone frames arrive from the audio page, speech goes back to
 * it, and the main process hears only what matters to the conversation.
 *
 * A reply is spoken once it is written, a sentence at a time: each plays
 * as soon as it is made, back to back with the one before, so a long
 * reply starts as quickly as a short one. Listening never stops, on the
 * microphone as heard: noise removal delays the onset of soft speech
 * enough to cut first words. When the person's words end they are
 * transcribed; words that are not an echo of the agent stop it if it is
 * speaking, and become the next utterance. Echo cancellation should keep
 * the agent from hearing itself; the echo check keeps it from answering
 * itself when it does.
 *
 * Once voice knows the person's voice (a voice print learned from a few
 * seconds of their speech), anyone else is ignored: the TV, a colleague
 * on a call, the agent's own voice through the speakers.
 */
export class VoiceEngine {
  private readonly window: Float32Array;
  private filled = 0;
  private inSpeech = false;
  private readonly queue: Utterance[] = [];
  private current: Utterance | null = null;
  private synthesizing = false;
  /** Bumped by every flush; synthesis started before it is stale. */
  private generation = 0;
  private sentSeq = 0;
  private drainedSeq = 0;
  /** Utterances whose audio is sent and waits for playback to end. */
  private readonly playing: string[] = [];
  private recent = "";
  private recognizing: Promise<void> = Promise.resolve();
  /** The last windows heard, so an utterance includes its onset. */
  private readonly preroll: Float32Array[] = [];
  /**
   * The whole current utterance from just before its onset. Recognized in
   * place of the detector's own segment, which starts at detection and so
   * can clip the first word.
   */
  private utterance: Float32Array[] = [];
  private voiceprint: number[] | null = null;
  private pushToTalk = false;
  /** The push-to-talk keys are down. */
  private held = false;
  /** Speech heard while learning the voice print; null when not learning. */
  private learning: Float32Array[] | null = null;

  constructor(
    private readonly parts: SpeechParts,
    private readonly emit: (event: VoiceWorkerEvent) => void,
    private readonly audio: (message: VoiceAudioDown) => void,
  ) {
    this.window = new Float32Array(parts.activity.windowSize);
  }

  /** Whether the agent's voice is coming out of the speakers, or about to. */
  get audible(): boolean {
    return (
      this.synthesizing ||
      this.current !== null ||
      this.queue.length > 0 ||
      this.drainedSeq < this.sentSeq
    );
  }

  onAudio(message: VoiceAudioUp): void {
    if (message.type === "frame") {
      this.onFrame(resample(message.samples, message.sampleRate));
    } else if (message.type === "drained") {
      this.drainedSeq = Math.max(this.drainedSeq, message.seq);
      this.settlePlayback();
    } else if (message.type === "levels") {
      // For the speaking animation, on its way to the windows.
      this.emit(message);
    } else {
      this.emit({ type: "failed", message: message.message });
    }
  }

  speak(id: string, text: string): void {
    if (!text.trim()) return;
    this.queue.push({ id, text });
    void this.drainSpeech();
  }

  setVoice(voice: VoiceId): void {
    this.parts.setVoice?.(voice);
  }

  /** Listen to this voice alone; null listens to anyone. */
  setVoiceprint(voiceprint: number[] | null): void {
    this.voiceprint = voiceprint;
  }

  /** Learn the voice print from the next few seconds of speech. */
  learn(): void {
    this.learning = [];
  }

  /**
   * Push to talk: the person says when they talk, by holding a key, so
   * nothing is detected and nothing else is heard. Off, voice listens for
   * speech on its own.
   */
  setPushToTalk(enabled: boolean): void {
    if (this.pushToTalk === enabled) return;
    if (this.held) this.hold(false);
    this.pushToTalk = enabled;
    this.inSpeech = false;
    this.utterance = [];
  }

  /**
   * The push-to-talk keys went down: the agent stops talking, and what the
   * person says is kept from just before. Up: it is heard, at once and
   * whole, with no wait for silence and no check of whose voice it is.
   */
  hold(held: boolean): void {
    if (!this.pushToTalk || held === this.held) return;
    this.held = held;
    if (held) {
      if (this.audible) {
        this.stopSpeaking();
        this.emit({ type: "barge-in" });
      }
      this.inSpeech = true;
      this.utterance = [...this.preroll];
      this.emit({ type: "speech-start" });
      return;
    }
    this.inSpeech = false;
    this.emit({ type: "speech-end" });
    const samples = concat(this.utterance);
    this.utterance = [];
    this.hear(samples, { pressed: true });
  }

  cue(): void {
    const { samples, sampleRate } = this.parts.cue();
    this.send(samples, sampleRate);
  }

  /** Stop talking now: queued speech, synthesis and playback. */
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

  private onFrame(samples: Float32Array): void {
    const activity = this.parts.activity;
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(
        samples.length - offset,
        this.window.length - this.filled,
      );
      this.window.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled < this.window.length) break;
      this.filled = 0;
      this.keep(this.window.slice());
      if (this.pushToTalk) continue;
      activity.accept(this.window);
      this.afterWindow();
    }
  }

  private keep(window: Float32Array): void {
    const windowSeconds = window.length / SPEECH_SAMPLE_RATE;
    this.preroll.push(window);
    if (this.preroll.length * windowSeconds > PREROLL_SECONDS)
      this.preroll.shift();
    if (
      this.inSpeech &&
      this.utterance.length * windowSeconds < UTTERANCE_MAX_SECONDS
    )
      this.utterance.push(window);
  }

  private afterWindow(): void {
    const detected = this.parts.activity.detected();
    if (detected && !this.inSpeech) {
      this.inSpeech = true;
      this.utterance = [...this.preroll];
      this.emit({ type: "speech-start" });
    } else if (!detected && this.inSpeech) {
      this.inSpeech = false;
      this.emit({ type: "speech-end" });
    }
    for (const segment of this.parts.activity.takeSegments()) {
      const samples =
        this.utterance.length > 0 ? concat(this.utterance) : segment;
      this.utterance = [];
      this.hear(samples, { pressed: false });
    }
  }

  /**
   * One recognition at a time, in order: utterances must not reorder. A
   * failure stops voice with its reason; it must never leave the chain
   * rejected, which would drop every later utterance unheard.
   */
  private hear(samples: Float32Array, how: { pressed: boolean }): void {
    this.recognizing = this.recognizing
      .then(() => this.recognizeSegment(samples, how))
      .catch((cause: unknown) =>
        this.emit({
          type: "failed",
          message: `Listening failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
  }

  /**
   * Who spoke is judged with noise removed; what they said is recognized
   * from the microphone as heard, which Parakeet copes with better than
   * with noise removal's artifacts.
   */
  private async recognizeSegment(
    segment: Float32Array,
    { pressed }: { pressed: boolean },
  ): Promise<void> {
    if (this.learning) {
      this.learnFrom(segment);
      return;
    }
    if (!pressed && !this.isPerson(segment)) {
      this.emit({ type: "ignored" });
      return;
    }
    const text = (await this.parts.recognize(segment)).trim();
    const speaking = this.audible;
    if (!meaningfulUtterance(text) || (speaking && isEcho(text, this.recent)))
      return;
    if (speaking) {
      this.stopSpeaking();
      this.emit({ type: "barge-in" });
    }
    this.emit({ type: "utterance", text });
  }

  /** Speech while learning: the agent's own voice is never learned. */
  private learnFrom(segment: Float32Array): void {
    const learning = this.learning;
    if (!learning || this.audible || !this.parts.voiceprint) return;
    learning.push(segment);
    const seconds =
      learning.reduce((sum, part) => sum + part.length, 0) / SPEECH_SAMPLE_RATE;
    if (seconds < LEARN_SECONDS) return;
    this.learning = null;
    this.voiceprint = this.parts.voiceprint(this.cleaned(concat(learning)));
    this.emit({ type: "learned", voiceprint: this.voiceprint });
  }

  /** Whether speech is the person's, by their voice print when known. */
  private isPerson(segment: Float32Array): boolean {
    if (!this.voiceprint || !this.parts.voiceprint) return true;
    if (segment.length < VERIFY_MIN_SECONDS * SPEECH_SAMPLE_RATE) return true;
    return (
      cosine(this.parts.voiceprint(this.cleaned(segment)), this.voiceprint) >=
      SAME_VOICE
    );
  }

  private cleaned(samples: Float32Array): Float32Array {
    return this.parts.denoise ? this.parts.denoise(samples) : samples;
  }

  private async drainSpeech(): Promise<void> {
    if (this.synthesizing) return;
    this.synthesizing = true;
    try {
      while (this.queue.length > 0) {
        const utterance = this.queue.shift();
        if (!utterance) break;
        this.current = utterance;
        const generation = this.generation;
        this.emit({ type: "speaking", id: utterance.id });
        this.remember(utterance.text);
        await this.parts.synthesize(utterance.text, (sentence) => {
          if (generation !== this.generation) return false;
          this.send(sentence.samples, sentence.sampleRate);
          return true;
        });
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

  private remember(text: string): void {
    this.recent = `${this.recent} ${text}`.slice(-RECENT_SPEECH_CHARS);
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    dot += (a[index] ?? 0) * (b[index] ?? 0);
  return dot;
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
 * Linear resampling to the detector's 16 kHz, mono in and out, for audio
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
