import { SPEECH_SAMPLE_RATE, type VoiceAudioUp } from "../../shared/voice.js";
import captureWorklet from "./capture-worklet.ts?worker&url";

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
): () => Promise<void> {
  const controller = new AbortController();
  let input: AbortController | null = null;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = prepared?.context ?? null;
  let finish: (() => Promise<void>) | null = null;
  let closing: Promise<void> | null = null;
  let flushing = Promise.resolve();
  let recovered = false;
  const close = () => {
    if (closing) return closing;
    controller.abort();
    for (const track of stream?.getTracks() ?? []) track.stop();
    const end = finish;
    finish = null;
    closing = Promise.all([flushing, end?.()])
      .then(() => {})
      .finally(() => {
        if (prepared) void context?.suspend().catch(() => {});
        else void context?.close();
      });
    return closing;
  };
  const fail = (message: string) => {
    if (controller.signal.aborted) return;
    void close().catch(() => {});
    post(port, { type: "failed", message });
  };
  const disconnected = () => {
    if (controller.signal.aborted) return;
    if (recovered) {
      fail(
        "The microphone disconnected. Choose a connected microphone and try again.",
      );
      return;
    }
    recovered = true;
    post(port, { type: "capture-opening" });
    input?.abort();
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    const end = finish;
    finish = null;
    flushing = end?.() ?? Promise.resolve();
    void flushing
      .then(() => {
        if (!controller.signal.aborted) return start(null);
      })
      .catch((cause: unknown) =>
        fail(cause instanceof Error ? cause.message : String(cause)),
      );
  };
  const start = async (chosen: string | null) => {
    const device = new AbortController();
    input = device;
    const signal = AbortSignal.any([controller.signal, device.signal]);
    try {
      // Resume the prepared graph in parallel with the physical input opening.
      if (prepared) void prepared.context.resume().catch(() => {});
      context ??= new AudioContext({ sampleRate: SPEECH_SAMPLE_RATE });
      const opening = openMicrophone(chosen, signal).then((opened) => {
        if (signal.aborted) {
          for (const track of opened.getTracks()) track.stop();
          signal.throwIfAborted();
        }
        stream = opened;
        return opened;
      });
      await capture(
        port,
        opening,
        context,
        signal,
        disconnected,
        (closer) => {
          finish = closer;
        },
        prepared?.ready,
      );
    } catch (cause: unknown) {
      if (!signal.aborted)
        fail(
          `The microphone could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
  };
  void start(microphone);
  return close;
}

// A utility-process port receives null for transferred buffers: copy them.
function post(port: MessagePort, message: VoiceAudioUp) {
  port.postMessage(message);
}

/** Streams the microphone's audio to the port as it comes. */
async function capture(
  port: MessagePort,
  opening: Promise<MediaStream>,
  context: AudioContext,
  signal: AbortSignal,
  disconnected: () => void,
  own: (closer: () => Promise<void>) => void,
  ready?: Promise<void>,
): Promise<void> {
  let pendingTap: AudioWorkletNode | null = null;
  // Module loading may finish after device opening has already failed.
  let canceled = false;
  const discard = () => {
    canceled = true;
    pendingTap?.port.close();
    pendingTap?.disconnect();
    pendingTap = null;
  };
  signal.addEventListener("abort", discard, { once: true });
  try {
    // Initialize the processor while the OS opens input, not after it opens.
    const [stream, tap] = await Promise.all([
      opening,
      (ready ?? context.audioWorklet.addModule(captureWorklet)).then(() => {
        signal.throwIfAborted();
        if (canceled) throw new DOMException("Capture stopped.", "AbortError");
        pendingTap = new AudioWorkletNode(context, "voice-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        });
        return pendingTap;
      }),
    ]);
    signal.throwIfAborted();
    const [track] = stream.getAudioTracks();
    track?.addEventListener(
      "ended",
      () => {
        if (!signal.aborted) disconnected();
      },
      { signal },
    );
    if (track?.readyState === "ended") {
      disconnected();
      return;
    }
    // Which microphone it is: other apps' audio is lowered only for the
    // system's own (ADR 0268).
    post(port, { type: "microphone", label: track?.label ?? "" });
    let flushed: (() => void) | null = null;
    let started = false;
    tap.port.onmessage = (event: MessageEvent<Float32Array | "flushed">) => {
      if (event.data === "flushed") {
        flushed?.();
        return;
      }
      if (!started && !signal.aborted) {
        started = true;
        post(port, { type: "capturing" });
      }
      post(port, {
        type: "frame",
        samples: event.data,
        sampleRate: context.sampleRate,
      });
    };
    const source = context.createMediaStreamSource(stream);
    source.connect(tap);
    // Resuming never gates ownership of the closer, including a slow device.
    own(
      () =>
        new Promise<void>((resolve, reject) => {
          source.disconnect();
          const cleanup = () => {
            clearTimeout(timeout);
            tap.port.onmessage = null;
            tap.port.close();
            tap.disconnect();
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error(
                "The microphone could not finish its captured audio. Try again.",
              ),
            );
          }, 1500);
          flushed = () => {
            cleanup();
            resolve();
          };
          tap.port.postMessage("flush");
        }),
    );
    // The live closer now owns the node and must flush before disposing it.
    pendingTap = null;
    signal.removeEventListener("abort", discard);
    await context.resume();
  } finally {
    signal.removeEventListener("abort", discard);
    discard();
  }
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
        (cause.name !== "OverconstrainedError" &&
          cause.name !== "NotFoundError")
      )
        throw cause;
    }
  signal.throwIfAborted();
  return navigator.mediaDevices.getUserMedia({ audio });
}
