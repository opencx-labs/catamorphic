import {
  SPEECH_SAMPLE_RATE,
  VOICE_PORT_MESSAGE,
  type VoiceAudioDown,
  type VoiceAudioUp,
  type VoicePortMessage,
} from "../../shared/voice.js";
import captureWorklet from "./capture-worklet.ts?worker&url";
import { LEVEL_FRAME_MS, speechLevels } from "./speech-levels.js";

/**
 * The audio page (ADR 0216): a hidden window that is the voice agent's
 * microphone and speakers, and nothing else. Its port goes to the speech
 * worker; this page only moves samples. The microphone keeps Chromium's
 * echo cancellation on, which cancels everything Work plays on the output
 * device, the agent's voice included: the agent hearing itself would
 * otherwise read as the person talking over it.
 */
/**
 * A microphone that has sent nothing but silence this long is not reaching
 * Work: macOS hands an app it has not allowed digital silence, and a muted
 * or unplugged input sounds the same. Any room has more noise than this.
 */
const SILENT_SECONDS = 4;
const SILENT_PEAK = 1e-4;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || !isPortMessage(event.data)) return;
  const port = event.ports[0];
  if (!port) return;
  const speaker = new Speaker(port);
  port.onmessage = (message: MessageEvent<VoiceAudioDown>) =>
    speaker.receive(message.data);
  void listen(port, event.data.microphone).catch((cause: unknown) =>
    post(port, {
      type: "failed",
      message: `The microphone could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  );
});

// Copied, never transferred: a port that ends in a utility process
// (MessagePortMain) delivers null for a message that transfers a buffer.
function post(port: MessagePort, message: VoiceAudioUp) {
  port.postMessage(message);
}

async function listen(
  port: MessagePort,
  microphone: string | null,
): Promise<void> {
  const stream = await openMicrophone(microphone);
  const [track] = stream.getAudioTracks();
  const context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
  await context.audioWorklet.addModule(captureWorklet);
  const tap = new AudioWorkletNode(context, "voice-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  let heardSeconds = 0;
  let silent = true;
  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (silent) {
      for (const sample of event.data)
        if (Math.abs(sample) > SILENT_PEAK) silent = false;
      heardSeconds += event.data.length / context.sampleRate;
      if (silent && heardSeconds >= SILENT_SECONDS) {
        silent = false;
        const label = track?.label.replace(/^Default - /, "") ?? "";
        // A MacBook switches its own microphone off with the lid closed.
        const lid = /built-in/i.test(label)
          ? " A MacBook's own microphone is off while its lid is closed."
          : "";
        post(port, {
          type: "failed",
          message: `No sound is coming from ${label || "the microphone"}.${lid} Pick another microphone from the voice button's menu, or allow Work in System Settings, Privacy & Security, Microphone.`,
        });
        return;
      }
    }
    post(port, {
      type: "frame",
      samples: event.data,
      sampleRate: context.sampleRate,
    });
  };
  context.createMediaStreamSource(stream).connect(tap);
  await context.resume();
}

/** The chosen microphone, or the system's when it is gone or unset. */
async function openMicrophone(microphone: string | null): Promise<MediaStream> {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (microphone)
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...audio, deviceId: { exact: microphone } },
      });
    } catch (cause) {
      if (
        !(cause instanceof DOMException) ||
        cause.name !== "OverconstrainedError"
      )
        throw cause;
    }
  return navigator.mediaDevices.getUserMedia({ audio });
}

function isPortMessage(value: unknown): value is VoicePortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === VOICE_PORT_MESSAGE &&
    "microphone" in value &&
    (value.microphone === null || typeof value.microphone === "string")
  );
}

/**
 * Clips played back to back, reporting when they have all ended: straight
 * to the output device, from a context at the clips' own rate (Kokoro's
 * 24 kHz), which Chromium resamples once for the device. Never through a
 * MediaStream: Chromium re-times MediaStream playback against the output
 * clock by resampling it between 0.9x and 1.1x, so a reply's pitch drifted
 * as it played.
 */
class Speaker {
  private context: AudioContext | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private playhead = 0;
  private lastSeq = 0;

  constructor(private readonly port: MessagePort) {}

  receive(message: VoiceAudioDown): void {
    if (message.type === "play") this.play(message);
    else this.flush(message.seq);
  }

  private play(message: Extract<VoiceAudioDown, { type: "play" }>): void {
    this.context ??= new AudioContext({ sampleRate: message.sampleRate });
    const context = this.context;
    void context.resume();
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
    post(this.port, {
      type: "levels",
      at:
        Date.now() + (at - context.currentTime + context.outputLatency) * 1000,
      frameMs: LEVEL_FRAME_MS,
      levels: speechLevels(message.samples, message.sampleRate),
    });
    this.playhead = at + buffer.duration;
    this.lastSeq = message.seq;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0)
        post(this.port, { type: "drained", seq: this.lastSeq });
    };
  }

  private flush(seq: number): void {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
    }
    this.sources.clear();
    this.playhead = 0;
    this.lastSeq = seq;
  }
}
