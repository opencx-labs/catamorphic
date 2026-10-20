import {
  SPEECH_SAMPLE_RATE,
  VOICE_PORT_MESSAGE,
  VOICE_REST_MESSAGE,
  type VoiceAudioDown,
  type VoiceAudioUp,
  type VoicePortMessage,
} from "../../shared/voice.js";
import captureWorklet from "./capture-worklet.ts?worker&url";
import { Speaker } from "./speaker.js";

/**
 * The audio page (ADR 0216): a hidden window that is the voice agent's
 * microphone and speakers, and nothing else. Its port goes to the speech
 * worker; this page only moves samples. The microphone keeps Chromium's
 * echo cancellation on, which cancels everything Work plays on the output
 * device, the agent's voice included: the agent hearing itself would
 * otherwise read as the person talking over it.
 *
 * Each voice brings its own port. Between voices the page rests, loaded,
 * with its microphone closed (ADR 0236): the next voice only opens the
 * microphone, so the person's first words are heard.
 */
/**
 * A microphone that has sent nothing but silence this long is not reaching
 * Work: macOS hands an app it has not allowed digital silence, and a muted
 * or unplugged input sounds the same. Any room has more noise than this.
 */
const SILENT_SECONDS = 4;
const SILENT_PEAK = 1e-4;

/** The voice this page serves now; null while it rests. */
let current: { close(): void } | null = null;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  if (isRestMessage(event.data)) {
    current?.close();
    current = null;
    return;
  }
  if (!isPortMessage(event.data)) return;
  const port = event.ports[0];
  if (!port) return;
  current?.close();
  const speaker = new Speaker(port);
  // A reply read aloud only plays: the microphone stays closed.
  const microphone = event.data.listen
    ? listen(port, event.data.microphone).catch((cause: unknown) => {
        post(port, {
          type: "failed",
          message: `The microphone could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        return undefined;
      })
    : Promise.resolve(undefined);
  port.onmessage = (message: MessageEvent<VoiceAudioDown>) => {
    if (message.data.type === "close-microphone")
      void microphone.then((close) => close?.());
    else speaker.receive(message.data);
  };
  current = {
    close: () => {
      port.onmessage = null;
      // The bars hear that what it scheduled will not play.
      speaker.close();
      port.close();
      void microphone.then((close) => close?.());
    },
  };
});

// Copied, never transferred: a port that ends in a utility process
// (MessagePortMain) delivers null for a message that transfers a buffer.
function post(port: MessagePort, message: VoiceAudioUp) {
  port.postMessage(message);
}

/** Opens the microphone and streams it; resolves to what closes it. */
async function listen(
  port: MessagePort,
  microphone: string | null,
): Promise<() => void> {
  const stream = await openMicrophone(microphone);
  let context: AudioContext | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const capture of stream.getTracks()) capture.stop();
    void context?.close();
  };
  try {
    context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
    await capture(port, stream, context);
  } catch (cause) {
    // A microphone voice cannot hear never stays open.
    close();
    throw cause;
  }
  return close;
}

/** Streams the microphone's audio to the port as it comes. */
async function capture(
  port: MessagePort,
  stream: MediaStream,
  context: AudioContext,
): Promise<void> {
  const [track] = stream.getAudioTracks();
  // Which microphone it is: other apps' audio is lowered only for the
  // system's own (ADR 0268).
  post(port, { type: "microphone", label: track?.label ?? "" });
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

/**
 * The chosen microphone, or the system's when it is gone or unset. Its
 * gain stays as the system sets it: automatic gain lifts a voice across
 * the room to the person's own level when they pause, and how loud speech
 * arrives is how voice tells the person from someone farther away. Noise
 * stays in too: speech recognition copes with a room's noise better than
 * with noise suppression's artifacts, which cost about twice the words
 * (ADR 0236), and voice tells speech from noise on its own.
 */
async function openMicrophone(microphone: string | null): Promise<MediaStream> {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
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

function isRestMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === VOICE_REST_MESSAGE
  );
}

function isPortMessage(value: unknown): value is VoicePortMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === VOICE_PORT_MESSAGE &&
    "microphone" in value &&
    (value.microphone === null || typeof value.microphone === "string") &&
    "listen" in value &&
    typeof value.listen === "boolean"
  );
}
