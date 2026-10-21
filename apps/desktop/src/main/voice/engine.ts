import {
  SPEECH_SAMPLE_RATE,
  type VoiceAudioDown,
  type VoiceAudioUp,
  type VoiceId,
  type VoiceWorkerEvent,
} from "../../shared/voice.js";
import {
  isAcknowledgement,
  isEcho,
  meaningfulUtterance,
} from "./speech-text.js";

/**
 * Audio kept from before detection fires, which lags speech onset: about
 * half a second on soft speech, so a first word is never cut.
 */
const PREROLL_SECONDS = 0.8;
/** The longest utterance kept for recognition. */
const UTTERANCE_MAX_SECONDS = 30;
/** How often dictation shows the words of speech still going on. */
const PARTIAL_SECONDS = 0.5;
/** How much of what was said recently an echo is checked against. */
const RECENT_SPEECH_CHARS = 600;
/** Speech a voice print is learned from, on purpose. */
const LEARN_SECONDS = 6;
/** Shorter speech is too little to tell whose voice it is. */
const VOICE_MIN_SECONDS = 1;
/**
 * What the person's voice is learned from at most: later stretches still
 * refine it, as much as the last half minute of their speech.
 */
const VOICE_MEMORY_SECONDS = 30;
/**
 * A voice this alike to the person's is theirs beyond doubt, at any level,
 * and teaches voice more of it. Less alike, down to `sameVoice`, it must
 * also be about as loud as they speak, and teaches nothing: a voice across
 * the room that scores near the edge never becomes theirs.
 */
const CLEARLY_SAME_VOICE = 0.5;
/** Voice is sure who the person is after this much of their speech. */
const KNOWN_SECONDS = 2;

/**
 * How voice tells the person from everything else the microphone hears
 * (ADR 0216, 0236): the measured choices, which the speech benchmark
 * varies.
 */
export interface Hearing {
  /**
   * Speech too short to tell whose voice it is, and this many dB quieter
   * than the person's own, is someone farther from the microphone; null
   * hears every level.
   */
  nearDb: number | null;
  /**
   * Windows this many dB under the person's level are silence to
   * detection, so a voice farther away neither starts speech nor draws out
   * the person's turn when it carries on after them.
   */
  gateDb: number;
  /** How long detection keeps hearing after a window near enough. */
  gateHoldSeconds: number;
  /**
   * The least average log probability per token of words recognized:
   * what the recognizer makes of noise ("Yeah.", "Okay, so.") scores far
   * below anything said.
   */
  sureOfWords: number;
  /**
   * The same for dictation, which writes what it hears for the person to
   * fix: a name or an identifier the recognizer half knows is still worth
   * writing, where a message to an agent is not.
   */
  sureOfDictation: number;
  /**
   * How alike a stretch's voice must be to the person's (cosine of
   * ERes2Net embeddings) to be theirs.
   */
  sameVoice: number;
  /**
   * A new voice this many dB louder than the person's is someone nearer
   * the microphone, and becomes the person: the voice heard first was not
   * theirs, or they moved. Never when they taught voice their voice.
   */
  nearerDb: number;
  /**
   * While the agent speaks, speech must come within this many dB of the
   * person's level to stop it; null holds it to `nearDb` alone.
   */
  bargeInDb: number | null;
  /**
   * Speech under way this long while the agent speaks, past the
   * detector's own onset, pauses it (ADR 0265)...
   */
  pauseSeconds: number;
  /**
   * ...when it comes within this many dB of the person's level so far;
   * null holds it to `bargeInDb`...
   */
  pauseDb: number | null;
  /**
   * ...and, once voice knows the person's voice, is at least this alike to
   * it so far, asked as it could pause and again at a second; null pauses
   * for any voice.
   */
  pauseAlike: number | null;
}

/**
 * Measured on the speech benchmark (ADR 0236): a far talker 12 dB under
 * the person no longer reaches the chat or draws out their turns, and a
 * quiet or soft-spoken person is heard as before. Talking over the agent
 * pauses it 0.64 s after the person starts, 39 times in 40; a talker 6 dB
 * under them pauses it twice in four and a half minutes, against 19
 * without asking whose voice it is. Words are dropped under -0.25, from
 * -0.35, at no cost to the person; -0.2 cost them words (ADR 0265).
 */
export const HEARING: Hearing = {
  nearDb: 8,
  gateDb: 10,
  gateHoldSeconds: 0.25,
  sureOfWords: -0.25,
  sureOfDictation: -0.35,
  sameVoice: 0.3,
  nearerDb: 4,
  bargeInDb: 4,
  pauseSeconds: 0.3,
  pauseDb: null,
  pauseAlike: 0.2,
};

/** Voice activity at 16 kHz, fed one fixed-size window at a time. */
export interface VoiceActivity {
  readonly windowSize: number;
  accept(window: Float32Array): void;
  /** True from the start of speech until its trailing silence. */
  detected(): boolean;
  /** Speech segments completed since the last call, oldest first. */
  takeSegments(): Float32Array[];
  /** Forget speech in progress and any segment not yet taken. */
  reset(): void;
}

/** Mono audio at its own sample rate. */
export interface SpeechClip {
  samples: Float32Array;
  sampleRate: number;
}

/** Words recognized, and how sure the recognizer was of them. */
export interface Recognized {
  text: string;
  /** Average log probability per token; 0 when nothing says. */
  confidence: number;
}

/** The models behind the engine: real ones in the app, scripted in tests. */
export interface SpeechParts {
  activity: VoiceActivity;
  recognize(samples: Float32Array): Promise<Recognized>;
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
  /** Who is speaking in 16 kHz speech, as a unit-length embedding. */
  voiceprint?(samples: Float32Array): number[];
}

interface Utterance {
  id: string;
  text: string;
}

/** The person at the microphone, as voice knows them. */
interface Person {
  /** Their voice, a unit embedding; null until a stretch long enough. */
  voice: number[] | null;
  /** Seconds of their speech the voice was learned from. */
  seconds: number;
  /** How loud they speak, in dBFS; null until heard. */
  level: number | null;
  /** They taught voice their voice on purpose ("Learn my voice"). */
  taught: boolean;
}

/** A stretch of speech as voice judges it. */
interface Stretch {
  seconds: number;
  level: number;
  voice: number[] | null;
}

/**
 * Turn-taking between the person and the agent's voice. Runs in the speech
 * worker: microphone frames arrive from the audio page, speech goes back to
 * it, and the main process hears only what matters to the conversation.
 *
 * A reply is spoken once it is written, a sentence at a time: each plays
 * as soon as it is made, back to back with the one before, so a long
 * reply starts as quickly as a short one. Listening never stops, on the
 * microphone as heard. When the person's words end they are transcribed;
 * words that are not an echo of the agent stop it if it is speaking, and
 * become the next utterance. Echo cancellation should keep the agent from
 * hearing itself; the echo check keeps it from answering itself when it
 * does. The person talking over the agent pauses it as they start (ADR
 * 0265): their words stop it for good, and anything else (its own voice
 * coming back, noise, someone else) lets it carry on where it paused.
 * What it has to say once they are already talking waits for them to
 * finish, then is said (ADR 0267).
 *
 * Only the person is heard (ADR 0236): the nearest voice that keeps
 * talking. Voice learns their voice and how loud they speak from what they
 * say, or from a few seconds they teach it, and anyone else is ignored:
 * the TV, a colleague on a call, the agent's own voice through the
 * speakers.
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
  /** Who the person is, once voice has heard them; null until then. */
  private person: Person | null = null;
  /**
   * Voice listens for speech on its own; off, it hears only while held
   * (a voice started by holding its keys or its microphone).
   */
  private handsFree = true;
  /** The keys or the microphone are held. */
  private held = false;
  /** They went down while the person was already speaking. */
  private heldMidSpeech = false;
  /**
   * Words of a hold too long for one recognition, heard a piece at a time:
   * said with its last piece, as one message, when the keys come up.
   */
  private heldWords: string[] = [];
  /**
   * Dictation: what the person says is written into a composer, nothing
   * is sent or spoken. Their words show while they talk.
   */
  private dictation = false;
  /** Counts stretches of speech, so dictation can tell them apart. */
  private segment = 0;
  /** Windows heard since dictation last showed the words so far. */
  private sincePartial = 0;
  /** A partial recognition in flight; recognition waits for it. */
  private partial: Promise<void> | null = null;
  /** Off for good once voice is ending: nothing more is heard. */
  private listening = true;
  /**
   * Voice is ending: no more audio is heard, and what was is still
   * recognized (dictation's last words).
   */
  private ending = false;
  /** Let go by the worker: it says nothing more. */
  private closed = false;
  /** Bumped when voice moves on: what was said before goes unanswered. */
  private epoch = 0;
  /** Speech heard while learning the voice print; null when not learning. */
  private learning: Float32Array[] | null = null;
  /** Windows detection still hears after the last one near enough. */
  private nearHold = 0;
  /**
   * The power of each window of speech under way, and how loud it is so
   * far: before the person has said anything, the measure of what is
   * near.
   */
  private speechPowers: number[] = [];
  private speechSoFar: number | null = null;
  /**
   * The stretch of speech that paused the agent's voice, while it is
   * paused (ADR 0265); null while it plays as it was.
   */
  private pausedFor: number | null = null;
  /** The last stretch that paused the agent: one pause per stretch. */
  private overheard = 0;
  /** The last stretch that began with the agent quiet. */
  private quietAt = 0;
  /**
   * The last stretch the agent waited for: it had something to say only
   * once the person was talking, so it held it until they finished.
   */
  private waitedFor = 0;
  /** Whether the paused stretch's voice was checked as it went on. */
  private pauseChecked = false;
  /** How often a stretch's voice was asked about before it could pause. */
  private voiceAsks = { segment: 0, times: 0 };
  private readonly silence: Float32Array;

  constructor(
    private readonly parts: SpeechParts,
    private readonly events: (event: VoiceWorkerEvent) => void,
    private readonly audio: (message: VoiceAudioDown) => void,
    private readonly hearing: Hearing = HEARING,
  ) {
    this.window = new Float32Array(parts.activity.windowSize);
    this.silence = new Float32Array(parts.activity.windowSize);
    // The detector outlives voices: nothing heard by the last one carries on.
    parts.activity.reset();
  }

  private emit(event: VoiceWorkerEvent): void {
    if (!this.closed) this.events(event);
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

  /** Settles once everything heard so far has been recognized. */
  recognized(): Promise<void> {
    return this.recognizing;
  }

  onAudio(message: VoiceAudioUp): void {
    if (message.type === "frame") {
      this.onFrame(resample(message.samples, message.sampleRate));
    } else if (message.type === "drained") {
      this.drainedSeq = Math.max(this.drainedSeq, message.seq);
      this.settlePlayback();
    } else if (message.type === "levels" || message.type === "microphone") {
      // For the speaking animation and lowering other apps' audio, on
      // their way to the main process.
      this.emit(message);
    } else {
      this.emit({ type: "failed", message: message.message });
    }
  }

  speak(id: string, text: string): void {
    if (!text.trim()) return;
    this.queue.push({ id, text });
    void this.drainSpeech();
    this.waitForThePerson();
  }

  setVoice(voice: VoiceId): void {
    this.parts.setVoice?.(voice);
  }

  /**
   * The person's voice, taught on purpose: it is theirs whoever else is
   * nearer. Null forgets it, and voice learns them again as they talk.
   */
  setVoiceprint(voiceprint: number[] | null): void {
    if (voiceprint)
      this.person = {
        voice: voiceprint,
        seconds: LEARN_SECONDS,
        level: this.person?.level ?? null,
        taught: true,
      };
    else if (this.person?.taught) this.person = null;
  }

  /** Learn the voice print from the next few seconds of speech. */
  learn(): void {
    this.resumeSpeech();
    this.learning = [];
  }

  /**
   * Hear nothing more, for the rest of this voice: no speech is detected,
   * holding the keys hears nothing, and nothing still being recognized
   * interrupts the speech already asked for.
   */
  stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    if (this.inSpeech) this.emit({ type: "speech-end" });
    this.inSpeech = false;
    this.held = false;
    this.utterance = [];
    this.heldWords = [];
    this.learning = null;
    // What it was saying is still said.
    this.resumeSpeech();
    this.audio({ type: "close-microphone" });
  }

  /**
   * Voice is ending (ADR 0236): dictation hears what the person is still
   * saying as if they had paused there, and nothing after it. Settles once
   * everything heard is recognized; then the microphone closes.
   */
  async finish(): Promise<void> {
    if (this.listening && !this.ending) {
      this.ending = true;
      // A press that turned voice off caught only what came before it,
      // unless they were still speaking.
      const speaking = this.inSpeech && (!this.held || this.heldMidSpeech);
      if (speaking && this.dictation && !this.learning) {
        const samples = concat(this.utterance);
        const speech = this.speechSeconds();
        this.inSpeech = false;
        this.held = false;
        this.utterance = [];
        this.emit({ type: "speech-end" });
        this.hear(samples, { pressed: false, speech });
      }
    }
    await this.recognizing;
    this.stopListening();
  }

  /**
   * Voice moved on to another chat, or to dictation: what was said for the
   * one before, still under way or being recognized, is dropped.
   */
  forget(): void {
    this.epoch += 1;
    if (this.inSpeech) this.emit({ type: "speech-end" });
    this.inSpeech = false;
    this.preroll.length = 0;
    this.utterance = [];
    this.heldWords = [];
    this.speechPowers = [];
    this.speechSoFar = null;
    this.parts.activity.reset();
    this.resumeSpeech();
  }

  /** The worker let this voice go: nothing it still recognizes is said. */
  close(): void {
    this.stopListening();
    this.closed = true;
  }

  /**
   * Another audio page took over (a microphone move): whatever the old one
   * had still to play went with it, so it counts as played, and a voice
   * that stopped listening closes the new page's microphone too.
   */
  audioReplaced(): void {
    this.drainedSeq = this.sentSeq;
    // The new page plays what it is sent, paused or not.
    this.pausedFor = null;
    this.settlePlayback();
    if (!this.listening) this.audio({ type: "close-microphone" });
  }

  /**
   * Hands-free, voice listens for speech on its own; otherwise the person
   * says when they talk, by holding a key or the microphone, and nothing
   * else is heard.
   */
  setHandsFree(enabled: boolean): void {
    if (this.handsFree === enabled) return;
    this.handsFree = enabled;
    if (this.held) return;
    if (this.inSpeech) this.emit({ type: "speech-end" });
    this.inSpeech = false;
    this.utterance = [];
    this.parts.activity.reset();
    this.resumeSpeech();
  }

  /**
   * Dictation writes what the person says, a stretch of speech at a time,
   * showing the words while they talk; conversation hands each utterance
   * to the agent. Either way, the agent's voice stops.
   */
  setDictation(enabled: boolean): void {
    if (this.dictation === enabled) return;
    this.dictation = enabled;
    // A conversation's hold, still in pieces, is not dictated.
    this.heldWords = [];
    this.stopSpeaking();
  }

  /**
   * The keys or the microphone went down: the agent stops talking, and
   * what the person says is kept from just before, or from the start of
   * speech already under way. Up: it is heard, at once and whole, with no
   * wait for silence and no check of whose voice it is; detection rests
   * while they are held. A tap is not talk: `discard` drops what the press
   * caught, and speech still going on is heard from the preroll, as any.
   */
  hold(held: boolean, { discard = false }: { discard?: boolean } = {}): void {
    if (!this.listening || held === this.held) return;
    this.held = held;
    if (held) {
      this.heldMidSpeech = this.inSpeech;
      if (this.audible) {
        this.stopSpeaking();
        this.emit({ type: "barge-in" });
      } else this.resumeSpeech();
      if (!this.inSpeech) this.beginSpeech();
      this.parts.activity.reset();
      return;
    }
    this.inSpeech = false;
    this.emit({ type: "speech-end" });
    const samples = concat(this.utterance);
    const speech = this.speechSeconds();
    this.utterance = [];
    this.speechPowers = [];
    this.speechSoFar = null;
    this.parts.activity.reset();
    if (discard) {
      if (this.dictation)
        this.emit({
          type: "dictation",
          segment: this.segment,
          text: "",
          final: true,
        });
      // Pieces of it already heard go with it, once recognized.
      this.recognizing = this.recognizing.then(() => {
        this.heldWords = [];
      });
      return;
    }
    // What the hold heard is heard: speech after it starts afresh.
    this.preroll.length = 0;
    this.hear(samples, { pressed: true, speech });
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
    this.pausedFor = null;
    this.generation += 1;
    this.sentSeq += 1;
    this.drainedSeq = this.sentSeq;
    this.audio({ type: "flush", seq: this.sentSeq });
    for (const id of new Set(stopped))
      this.emit({ type: "spoken", id, interrupted: true });
  }

  private onFrame(samples: Float32Array): void {
    if (this.ending) return;
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
      const level = power(this.window);
      this.keep(this.window.slice(), level);
      if (this.listening && this.dictation && this.inSpeech && !this.learning)
        this.showSoFar();
      if (!this.handsFree || this.held || !this.listening) continue;
      // Speech far quieter than the person's is someone farther away: to
      // detection it is silence, so it starts nothing and never draws out
      // the person's turn when it carries on after them.
      activity.accept(this.near(level) ? this.window : this.silence);
      this.afterWindow();
      this.overhear();
    }
  }

  /**
   * The person talking over the agent pauses its voice as they start (ADR
   * 0265), rather than once they finish: speech under way for a moment,
   * about as loud as they speak, while the agent is heard. What the
   * stretch turns out to be decides the rest: the person's words stop the
   * agent for good, and anything else lets it carry on where it paused.
   * Long enough to tell whose voice it is, someone else's lets it carry on
   * at once.
   */
  private overhear(): void {
    if (!this.inSpeech || this.dictation || this.learning) return;
    const seconds = this.speechSeconds();
    if (this.pausedFor === this.segment) {
      if (this.pauseChecked || seconds < VOICE_MIN_SECONDS) return;
      this.pauseChecked = true;
      try {
        const stretch = this.stretchOf(concat(this.utterance), seconds);
        const speaking = this.waitedFor !== this.segment;
        if (this.whose(stretch, { speaking }) === "someone else")
          this.resumeSpeech();
      } catch {
        // Judged whole once it ends, which reports a failure.
      }
      return;
    }
    if (
      this.overheard === this.segment ||
      this.pausedFor !== null ||
      !this.audible ||
      seconds < this.hearing.pauseSeconds
    )
      return;
    const person = this.person;
    const { pauseDb, bargeInDb, nearDb } = this.hearing;
    const margin = pauseDb ?? bargeInDb ?? nearDb;
    if (
      person &&
      person.level !== null &&
      margin !== null &&
      percentile(this.speechPowers, 0.9) < person.level - margin
    )
      return;
    if (!this.likeThePerson(seconds)) return;
    this.overheard = this.segment;
    this.pausedFor = this.segment;
    // Paused once it was long enough to tell whose: told already.
    this.pauseChecked = seconds >= VOICE_MIN_SECONDS;
    this.audio({ type: "pause" });
  }

  /**
   * Something to say only once the person was already talking waits for
   * them to finish, from its first word: the agent never starts talking
   * over them. The stretch began with the agent quiet, so it is not its
   * own voice coming back and needs no moment to tell; someone else's
   * voice, once a second tells, lets it speak (`overhear`). When the
   * stretch ends, what was held is said, the person's words or not.
   */
  private waitForThePerson(): void {
    if (
      !this.inSpeech ||
      this.dictation ||
      this.learning ||
      this.quietAt !== this.segment ||
      this.overheard === this.segment ||
      this.pausedFor !== null ||
      !this.audible
    )
      return;
    this.overheard = this.segment;
    this.waitedFor = this.segment;
    this.pausedFor = this.segment;
    this.pauseChecked = false;
    this.audio({ type: "pause" });
  }

  /**
   * Whether the speech under way may be the person's, by its voice so far
   * when voice knows theirs: asked as it could pause, and once more when
   * it is long enough to tell. Another voice pauses nothing.
   */
  private likeThePerson(seconds: number): boolean {
    const { pauseAlike } = this.hearing;
    const voice = this.person?.voice;
    if (!voice || pauseAlike === null || !this.parts.voiceprint) return true;
    const times =
      this.voiceAsks.segment === this.segment ? this.voiceAsks.times : 0;
    if (times >= 2 || (times === 1 && seconds < VOICE_MIN_SECONDS))
      return false;
    this.voiceAsks = { segment: this.segment, times: times + 1 };
    try {
      const samples = concat(this.utterance);
      // Long enough to tell, the stretch is judged as it will be once it
      // ends, so a pause is never undone a moment later.
      if (seconds >= VOICE_MIN_SECONDS)
        return (
          this.whose(this.stretchOf(samples, seconds), { speaking: true }) ===
          "person"
        );
      return cosine(this.parts.voiceprint(samples), voice) >= pauseAlike;
    } catch {
      return false;
    }
  }

  /** The agent's voice carries on where the person's speech paused it. */
  private resumeSpeech(): void {
    if (this.pausedFor === null) return;
    this.pausedFor = null;
    this.audio({ type: "resume" });
  }

  /**
   * Whether a window is loud enough to be the person, with a short hold.
   * Until they have said something, speech under way is the measure: a
   * voice across the room that ran on when they stopped ends their first
   * turn as silence would.
   */
  private near(level: number): boolean {
    const { nearDb, gateDb, gateHoldSeconds } = this.hearing;
    const reference = this.person?.level ?? this.speechSoFar;
    if (nearDb === null || reference === null) return true;
    if (level >= reference - gateDb)
      this.nearHold = Math.ceil(
        (gateHoldSeconds * SPEECH_SAMPLE_RATE) / this.window.length,
      );
    if (this.nearHold === 0) return false;
    this.nearHold -= 1;
    return true;
  }

  private beginSpeech(): void {
    this.inSpeech = true;
    this.segment += 1;
    if (!this.audible) this.quietAt = this.segment;
    this.sincePartial = 0;
    this.speechPowers = [];
    this.speechSoFar = null;
    this.utterance = [...this.preroll];
    this.emit({ type: "speech-start", segment: this.segment });
  }

  /**
   * Dictation shows the words of speech still going on, every half second
   * or so: the whole stretch so far, recognized again. One at a time, and
   * never in the way of a finished stretch.
   */
  private showSoFar(): void {
    this.sincePartial += this.window.length / SPEECH_SAMPLE_RATE;
    if (this.sincePartial < PARTIAL_SECONDS || this.partial) return;
    this.sincePartial = 0;
    const segment = this.segment;
    const epoch = this.epoch;
    const samples = concat(this.utterance);
    this.partial = this.recognizing
      .then(async () => {
        if (segment !== this.segment || !this.inSpeech) return;
        const { text, confidence } = await this.parts.recognize(samples);
        if (
          segment === this.segment &&
          epoch === this.epoch &&
          this.inSpeech &&
          this.listening &&
          this.dictation &&
          text.trim() &&
          confidence >= this.hearing.sureOfDictation
        )
          this.emit({
            type: "dictation",
            segment,
            text: text.trim(),
            final: false,
          });
      })
      .catch(() => {})
      .finally(() => {
        this.partial = null;
      });
  }

  private keep(window: Float32Array, level: number): void {
    const windowSeconds = window.length / SPEECH_SAMPLE_RATE;
    this.preroll.push(window);
    if (this.preroll.length * windowSeconds > PREROLL_SECONDS)
      this.preroll.shift();
    if (!this.inSpeech) return;
    this.speechPowers.push(level);
    // A second of speech is enough to know how loud it is; kept current.
    if (
      this.speechPowers.length * windowSeconds >= 1 &&
      this.speechPowers.length % 8 === 0
    )
      this.speechSoFar = percentile(this.speechPowers, 0.9);
    if (this.utterance.length * windowSeconds < UTTERANCE_MAX_SECONDS) {
      this.utterance.push(window);
      return;
    }
    // Keys held this long: what was said so far is heard, and the rest
    // carries on as the next stretch, the same message.
    if (!this.held) return;
    const samples = concat(this.utterance);
    this.hear(samples, {
      pressed: true,
      piece: true,
      speech: samples.length / SPEECH_SAMPLE_RATE,
    });
    this.speechPowers = [];
    // Dictation writes each piece as a stretch of its own; a conversation's
    // hold stays one stretch, whose wait the agent's speech keeps to.
    if (this.dictation) this.segment += 1;
    this.sincePartial = 0;
    this.utterance = [window];
  }

  private afterWindow(): void {
    const detected = this.parts.activity.detected();
    if (detected && !this.inSpeech) {
      this.beginSpeech();
    } else if (!detected && this.inSpeech) {
      this.inSpeech = false;
      // Speech over, its loudness no longer measures anything.
      this.speechSoFar = null;
      this.emit({ type: "speech-end" });
    }
    for (const segment of this.parts.activity.takeSegments()) {
      const samples =
        this.utterance.length > 0 ? concat(this.utterance) : segment;
      this.utterance = [];
      // How long they spoke is the detector's: not the onset kept before
      // it, nor the pause that ended it.
      this.hear(samples, {
        pressed: false,
        speech: segment.length / SPEECH_SAMPLE_RATE,
      });
    }
  }

  /**
   * One recognition at a time, in order: utterances must not reorder. A
   * failure stops voice with its reason; it must never leave the chain
   * rejected, which would drop every later utterance unheard.
   */
  private hear(
    samples: Float32Array,
    how: { pressed: boolean; piece?: boolean; speech: number },
  ): void {
    const segment = this.segment;
    const epoch = this.epoch;
    const partial = this.partial;
    this.recognizing = this.recognizing
      .then(() => partial)
      .then(() => this.recognizeSegment(samples, { ...how, segment, epoch }))
      .catch((cause: unknown) => {
        // Dictation's words so far go: they were never finished.
        if (this.dictation)
          this.emit({ type: "dictation", segment, text: "", final: true });
        this.emit({
          type: "failed",
          message: `Listening failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      });
  }

  /**
   * Who spoke is judged with noise removed; what they said is recognized
   * from the microphone as heard, which Parakeet copes with better than
   * with noise removal's artifacts.
   */
  private async recognizeSegment(
    samples: Float32Array,
    {
      pressed,
      piece = false,
      speech,
      segment,
      epoch,
    }: {
      pressed: boolean;
      /** A piece of a hold still going on: its words wait for the rest. */
      piece?: boolean;
      speech: number;
      segment: number;
      epoch: number;
    },
  ): Promise<void> {
    if (!this.listening || epoch !== this.epoch) return;
    const dictated = (text: string) =>
      this.emit({ type: "dictation", segment, text, final: true });
    if (this.learning) {
      this.learnFrom(samples);
      if (this.dictation) dictated("");
      else if (pressed && !piece) {
        // Learning hears no words: a hold that ended says so, and what it
        // held goes with it.
        this.heldWords = [];
        this.emit({ type: "ignored" });
      }
      return;
    }
    const heard = this.stretchOf(samples, speech);
    // Waited for, the agent was never talking over this stretch: it holds
    // what it has to say until the stretch is heard, then says it.
    const waited = this.waitedFor === segment;
    const speaking = !waited && this.audible;
    // Not the person's words: what this stretch paused carries on.
    const carryOn = () => {
      if (this.pausedFor === segment) this.resumeSpeech();
    };
    const whose = pressed ? "person" : this.whose(heard, { speaking });
    if (whose === "someone else") {
      if (this.dictation) dictated("");
      carryOn();
      this.emit({ type: "ignored" });
      return;
    }
    const recognized = await this.parts.recognize(samples);
    if (!this.listening || epoch !== this.epoch) return;
    const text = recognized.text.trim();
    // Words made of noise are no words: the keys held say someone spoke.
    const words =
      meaningfulUtterance(text) &&
      (pressed ||
        recognized.confidence >=
          (this.dictation
            ? this.hearing.sureOfDictation
            : this.hearing.sureOfWords));
    if (this.dictation) {
      if (words) this.heardFrom(heard, { pressed });
      dictated(words ? text : "");
      // A quiet piece of a hold still going on is no hold let go.
      if (pressed && !piece && !words) this.emit({ type: "unheard" });
      return;
    }
    // A hold too long for one recognition is one message: its pieces wait
    // for the last, said as the keys come up, pauses and all.
    if (piece) {
      if (words) {
        this.heardFrom(heard, { pressed });
        this.heldWords.push(text);
      }
      return;
    }
    const said = [
      ...(pressed ? this.heldWords.splice(0) : []),
      ...(words ? [text] : []),
    ].join(" ");
    // The agent may have started talking while this was recognized.
    const talking = !waited && (speaking || this.audible);
    // "Yeah" while it talks says go on: it neither stops nor answers it.
    // The keys held say the person means it.
    const goOn = talking && !pressed && isAcknowledgement(text);
    if (!said || goOn || (talking && isEcho(said, this.recent))) {
      carryOn();
      if (pressed) this.emit({ type: "unheard" });
      return;
    }
    if (words) this.heardFrom(heard, { pressed });
    if (talking) {
      this.stopSpeaking();
      this.emit({ type: "barge-in" });
    } else carryOn();
    this.emit({ type: "utterance", text: said, segment });
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
    const samples = concat(learning);
    const voice = this.parts.voiceprint(samples);
    this.person = {
      voice,
      seconds: LEARN_SECONDS,
      level: speechLevel(samples),
      taught: true,
    };
    this.emit({ type: "learned", voiceprint: voice });
  }

  /**
   * How loud a stretch is, and whose voice, when the person spoke long
   * enough to tell.
   */
  private stretchOf(samples: Float32Array, speech: number): Stretch {
    return {
      seconds: speech,
      level: speechLevel(samples),
      voice:
        this.parts.voiceprint && speech >= VOICE_MIN_SECONDS
          ? this.parts.voiceprint(samples)
          : null,
    };
  }

  /** How long the speech under way has gone on, its onset kept aside. */
  private speechSeconds(): number {
    return (this.speechPowers.length * this.window.length) / SPEECH_SAMPLE_RATE;
  }

  /**
   * Whether a stretch is the person's (ADR 0236). The first voice heard is
   * theirs until a nearer one, clearly louder, takes over; after that, a
   * stretch is theirs when it is clearly their voice, or a voice like
   * theirs about as loud as they speak, or, too short to tell, about as
   * loud. While the agent talks, only their full voice stops it.
   */
  private whose(
    heard: Stretch,
    { speaking }: { speaking: boolean },
  ): "person" | "someone else" {
    const { nearDb, sameVoice, bargeInDb } = this.hearing;
    const person = this.person;
    if (!person) return "person";
    const margin = speaking && bargeInDb !== null ? bargeInDb : nearDb;
    const near =
      margin === null ||
      person.level === null ||
      heard.level >= person.level - margin;
    if (heard.voice && person.voice) {
      const alike = cosine(heard.voice, person.voice);
      if (alike >= CLEARLY_SAME_VOICE || (alike >= sameVoice && near))
        return "person";
      return this.nearer(heard) ? "person" : "someone else";
    }
    return near ? "person" : "someone else";
  }

  /**
   * A new voice clearly louder than the person's, once voice is sure who
   * they are: someone nearer the microphone, who becomes the person.
   * Never when they taught voice their voice.
   */
  private nearer(heard: Stretch): boolean {
    const person = this.person;
    return (
      !!person &&
      !person.taught &&
      !!heard.voice &&
      person.seconds >= KNOWN_SECONDS &&
      person.level !== null &&
      heard.level >= person.level + this.hearing.nearerDb
    );
  }

  /**
   * What the person said teaches voice who they are, from speech that is
   * surely theirs: their first stretch long enough to tell, a stretch
   * clearly their voice, or one said with the keys held. Held and not
   * their voice, or a nearer voice, voice learns them afresh. Speech
   * accepted on the edge teaches nothing.
   */
  private heardFrom(heard: Stretch, { pressed }: { pressed: boolean }): void {
    const person = this.person;
    if (!heard.voice) {
      // Too short to tell whose: only a held key says how loud they are.
      if (pressed && person && person.level === null)
        person.level = heard.level;
      return;
    }
    const alike = person?.voice ? cosine(heard.voice, person.voice) : null;
    const clearly = alike !== null && alike >= CLEARLY_SAME_VOICE;
    // Only another voice takes over by being nearer: one merely like
    // theirs, a little louder, is still them on the edge.
    const afresh =
      !person?.voice ||
      (!clearly &&
        (pressed ||
          (alike !== null &&
            alike < this.hearing.sameVoice &&
            this.nearer(heard))));
    if (afresh) {
      // A taught voice stays theirs; only how loud they are is learned.
      if (person?.taught && person.voice) {
        person.level = heard.level;
        return;
      }
      this.person = {
        voice: heard.voice,
        seconds: heard.seconds,
        level: heard.level,
        taught: false,
      };
      return;
    }
    if (!person?.voice || !clearly) return;
    person.level =
      person.level === null
        ? heard.level
        : person.level + 0.3 * (heard.level - person.level);
    // A running mean of their voice, the latest half minute weighing most.
    const weight = Math.min(person.seconds, VOICE_MEMORY_SECONDS);
    person.voice = unit(
      person.voice.map(
        (value, index) =>
          value * weight + (heard.voice?.[index] ?? 0) * heard.seconds,
      ),
    );
    person.seconds = weight + heard.seconds;
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
    // Its last words ended as the person began: nothing is left to hold,
    // and what it says next must play.
    if (!this.audible) this.resumeSpeech();
  }

  private remember(text: string): void {
    this.recent = `${this.recent} ${text}`.slice(-RECENT_SPEECH_CHARS);
  }
}

/** A window's power, in dBFS. */
function power(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
}

/**
 * How loud speech is, in dBFS: the power its loudest windows reach (the
 * 90th percentile of 32 ms windows). Pauses and quieter voices under it
 * do not pull it down, so speech that ran on into someone farther away
 * still measures the person.
 */
export function speechLevel(samples: Float32Array): number {
  const size = 512;
  const powers: number[] = [];
  for (let start = 0; start + size <= samples.length; start += size)
    powers.push(power(samples.subarray(start, start + size)));
  return powers.length === 0 ? power(samples) : percentile(powers, 0.9);
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * share)] ?? -120;
}

function unit(vector: number[]): number[] {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
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
