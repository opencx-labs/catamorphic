import type { VoiceAudioDown, VoiceAudioUp } from "../../shared/voice.js";
import { LEVEL_FRAME_MS, speechLevels } from "./speech-levels.js";

// Copied, never transferred: a port that ends in a utility process
// (MessagePortMain) delivers null for a message that transfers a buffer.
function post(port: MessagePort, message: VoiceAudioUp) {
  port.postMessage(message);
}

/**
 * Clips played back to back, reporting when they have all ended: straight
 * to the output device, from a context at the clips' own rate (Kokoro's
 * 24 kHz), which Chromium resamples once for the device. Never through a
 * MediaStream: Chromium re-times MediaStream playback against the output
 * clock by resampling it between 0.9x and 1.1x, so a reply's pitch drifted
 * as it played. Paused while the person talks over the agent (ADR 0265),
 * the context's clock stops, so everything scheduled carries on from
 * where it was.
 */
export class Speaker {
  private context: AudioContext | null = null;
  /** Each clip scheduled, with when it starts and how it sounds. */
  private readonly sources = new Map<
    AudioBufferSourceNode,
    { at: number; levels: number[] }
  >();
  private playhead = 0;
  private lastSeq = 0;
  private paused = false;

  constructor(private readonly port: MessagePort) {}

  receive(
    message: Exclude<VoiceAudioDown, { type: "close-microphone" }>,
  ): void {
    switch (message.type) {
      case "play":
        this.play(message);
        return;
      case "flush":
        this.flush(message.seq);
        return;
      case "pause":
        this.pause();
        return;
      case "resume":
        this.resume();
        return;
    }
  }

  private play(message: Extract<VoiceAudioDown, { type: "play" }>): void {
    this.context ??= new AudioContext({ sampleRate: message.sampleRate });
    const context = this.context;
    // A context made while paused starts running: it waits as the rest do.
    if (this.paused) void context.suspend();
    else void context.resume();
    const buffer = context.createBuffer(
      1,
      message.samples.length,
      message.sampleRate,
    );
    buffer.getChannelData(0).set(message.samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(context.currentTime + 0.03, this.playhead);
    source.start(at);
    const levels = speechLevels(message.samples, message.sampleRate);
    if (!this.paused) this.showLevels(context, at, levels);
    this.playhead = at + buffer.duration;
    this.lastSeq = message.seq;
    this.sources.set(source, { at, levels });
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0)
        post(this.port, { type: "drained", seq: this.lastSeq });
    };
  }

  /** How a clip sounds, against the time it is heard. */
  private showLevels(context: AudioContext, at: number, levels: number[]) {
    post(this.port, {
      type: "levels",
      at:
        Date.now() + (at - context.currentTime + context.outputLatency) * 1000,
      frameMs: LEVEL_FRAME_MS,
      levels,
    });
  }

  /** What was shown is not heard as scheduled: the bars forget it. */
  private forgetLevels(): void {
    post(this.port, {
      type: "levels",
      at: Date.now(),
      frameMs: LEVEL_FRAME_MS,
      levels: [],
      reset: true,
    });
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.forgetLevels();
    void this.context?.suspend();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const context = this.context;
    if (!context) return;
    void context.resume().then(() => {
      // Paused again meanwhile: shown once it carries on.
      if (this.paused || this.context !== context) return;
      // The pause moved every clip later: the animation follows them anew.
      this.forgetLevels();
      for (const { at, levels } of this.sources.values())
        this.showLevels(context, at, levels);
    });
  }

  /** Voice is over: nothing more plays, and the output goes. */
  close(): void {
    this.flush(this.lastSeq);
    void this.context?.close();
    this.context = null;
  }

  private flush(seq: number): void {
    for (const source of this.sources.keys()) {
      source.onended = null;
      source.stop();
    }
    if (this.sources.size > 0 || this.paused) this.forgetLevels();
    this.sources.clear();
    this.playhead = 0;
    this.lastSeq = seq;
    this.paused = false;
  }
}
