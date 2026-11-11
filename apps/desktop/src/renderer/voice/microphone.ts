import { SPEECH_SAMPLE_RATE, type VoiceAudioUp } from "../../shared/voice.js";
import captureWorklet from "./capture-worklet.ts?worker&url";

/**
 * A microphone that has sent nothing but silence this long is not reaching
 * Work: macOS hands an app it has not allowed digital silence, and a muted
 * or unplugged input sounds the same. Any room has more noise than this.
 */
const SILENT_SECONDS = 4;
const SILENT_PEAK = 1e-4;

/** Load the audio graph without asking for, or opening, an input device. */
export function prepareMicrophone() {
  const context = new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
  const ready = context.audioWorklet.addModule(captureWorklet);
  void ready.catch(() => {});
  void context.suspend().catch(() => {});
  return {
    context,
    ready,
    close: () => {
      void context.close();
    },
  };
}

/**
 * Start capture, with an immediate closer. Permission, worklet loading and
 * AudioContext.resume can all finish after voice is turned off. None may
 * delay releasing a stream, or reopen a microphone for an ended voice.
 */
export function listen(
  port: MessagePort,
  microphone: string | null,
  prepared?: ReturnType<typeof prepareMicrophone>,
): () => void {
  const controller = new AbortController();
  let stream: MediaStream | null = null;
  let context: AudioContext | null = prepared?.context ?? null;
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (prepared) void context?.suspend().catch(() => {});
    else void context?.close();
  };
  const start = async () => {
    // Resume the prepared graph in parallel with the physical input opening.
    if (prepared) void prepared.context.resume().catch(() => {});
    stream = await openMicrophone(microphone, controller.signal);
    if (controller.signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    context ??= new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
    await capture(port, stream, context, controller.signal, prepared?.ready);
  };
  void start().catch((cause: unknown) => {
    if (controller.signal.aborted) return;
    close();
    post(port, {
      type: "failed",
      message: `The microphone could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  });
  return close;
}

// A utility-process port receives null for transferred buffers: copy them.
function post(port: MessagePort, message: VoiceAudioUp) {
  port.postMessage(message);
}

/** Streams the microphone's audio to the port as it comes. */
async function capture(
  port: MessagePort,
  stream: MediaStream,
  context: AudioContext,
  signal: AbortSignal,
  ready?: Promise<void>,
): Promise<void> {
  const [track] = stream.getAudioTracks();
  // Which microphone it is: other apps' audio is lowered only for the
  // system's own (ADR 0268).
  post(port, { type: "microphone", label: track?.label ?? "" });
  await (ready ?? context.audioWorklet.addModule(captureWorklet));
  signal.throwIfAborted();
  const tap = new AudioWorkletNode(context, "voice-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  signal.addEventListener(
    "abort",
    () => {
      tap.port.onmessage = null;
      tap.port.close();
      tap.disconnect();
    },
    { once: true },
  );
  let heardSeconds = 0;
  let silent = true;
  let started = false;
  tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!started) {
      started = true;
      post(port, { type: "capturing" });
    }
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
  const source = context.createMediaStreamSource(stream);
  source.connect(tap);
  signal.addEventListener("abort", () => source.disconnect(), { once: true });
  await context.resume();
}

/**
 * Use the chosen microphone, falling back to the system's when disconnected.
 * Keep noise suppression and gain changes off: recognition copes better with
 * the captured signal than with their artifacts. Push to talk supplies intent.
 */
async function openMicrophone(
  microphone: string | null,
  signal: AbortSignal,
): Promise<MediaStream> {
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
  signal.throwIfAborted();
  return navigator.mediaDevices.getUserMedia({ audio });
}
