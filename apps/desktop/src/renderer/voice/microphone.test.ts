import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudioUp } from "../../shared/voice.js";
import { listen, prepareMicrophone } from "./microphone.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function setup(warm = false) {
  const permission = deferred<MediaStream>();
  const module = deferred<void>();
  const resume = deferred<void>();
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), {
    label: "Default microphone",
    stop,
  });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const source = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  const contextClose = vi.fn(async () => {});
  const suspend = vi.fn(async () => {});
  const addModule = vi.fn(() => module.promise);
  const getUserMedia = vi.fn(() => permission.promise);
  class Context {
    sampleRate = 16000;
    audioWorklet = { addModule };
    createMediaStreamSource = source;
    resume = () => resume.promise;
    close = contextClose;
    suspend = suspend;
  }
  let tap: Tap;
  class Tap {
    constructor() {
      tap = this;
    }
    port = {
      onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
      close: vi.fn(),
    };
    disconnect = vi.fn();
  }
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia },
  });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Tap);
  const sent: VoiceAudioUp[] = [];
  const port = {
    postMessage: (value: VoiceAudioUp) => sent.push(value),
  } as unknown as MessagePort;
  const prepared = warm ? prepareMicrophone() : undefined;
  expect(getUserMedia).not.toHaveBeenCalled();
  const close = listen(port, null, prepared);
  return {
    permission,
    module,
    resume,
    stop,
    stream,
    source,
    contextClose,
    sent,
    close,
    prepared,
    suspend,
    getUserMedia,
    addModule,
    track,
    frame: (samples: Float32Array) =>
      tap.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("a microphone that stops while capture is starting", () => {
  it("prepares its graph without an input and opens the device on press without reloading the worklet", async () => {
    const mic = setup(true);
    expect(mic.getUserMedia).toHaveBeenCalledOnce();
    expect(mic.addModule).toHaveBeenCalledOnce();
    mic.module.resolve();
    await flush();
    expect(mic.source).not.toHaveBeenCalled();
    mic.permission.resolve(mic.stream);
    mic.resume.resolve();
    await flush();
    expect(mic.source).toHaveBeenCalledOnce();
    expect(mic.addModule).toHaveBeenCalledOnce();
    mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.contextClose).not.toHaveBeenCalled();
    expect(mic.suspend).toHaveBeenCalledTimes(2);
    mic.prepared?.close();
    expect(mic.contextClose).toHaveBeenCalledOnce();
  });
  it("releases a permission result that arrives after voice stopped", async () => {
    const mic = setup();
    mic.close();
    mic.permission.resolve(mic.stream);
    await flush();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.source).not.toHaveBeenCalled();
    expect(mic.sent).toEqual([]);
  });

  it("closes the live track immediately while its worklet is still loading", async () => {
    const mic = setup();
    mic.permission.resolve(mic.stream);
    await flush();
    mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.contextClose).toHaveBeenCalledOnce();
    mic.module.resolve();
    await flush();
    expect(mic.source).not.toHaveBeenCalled();
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([]);
  });

  it("releases capture without waiting for the audio context to resume", async () => {
    const mic = setup();
    mic.permission.resolve(mic.stream);
    mic.module.resolve();
    await flush();
    expect(mic.source).toHaveBeenCalledOnce();
    mic.close();
    mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.contextClose).toHaveBeenCalledOnce();
    mic.resume.reject(new Error("closed while resuming"));
    await flush();
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([]);
  });

  it("closes a failed capture and reports its error once", async () => {
    const mic = setup();
    mic.permission.resolve(mic.stream);
    await flush();
    mic.module.reject(new Error("worklet unavailable"));
    await flush();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([
      {
        type: "failed",
        message: "The microphone could not start: worklet unavailable",
      },
    ]);
  });

  it("keeps a working microphone until its owner stops it", async () => {
    const mic = setup();
    mic.permission.resolve(mic.stream);
    mic.module.resolve();
    mic.resume.resolve();
    await flush();
    expect(mic.stop).not.toHaveBeenCalled();
    mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
  });

  it("keeps a held input through quiet speech and Bluetooth silence, then captures sound", async () => {
    const mic = setup(true);
    mic.permission.resolve(mic.stream);
    mic.module.resolve();
    mic.resume.resolve();
    await flush();
    for (let second = 0; second < 8; second++)
      mic.frame(new Float32Array(16_000));
    mic.frame(new Float32Array(320).fill(0.00001));
    mic.frame(new Float32Array(320).fill(0.25));
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([]);
    expect(mic.sent.filter((m) => m.type === "capturing")).toHaveLength(1);
    expect(mic.sent.filter((m) => m.type === "frame")).toHaveLength(10);
    expect(mic.stop).not.toHaveBeenCalled();
    mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
  });

  it("reports a disconnected device, but ignores its ended event after release", async () => {
    const mic = setup();
    mic.permission.resolve(mic.stream);
    mic.module.resolve();
    mic.resume.resolve();
    await flush();
    mic.track.dispatchEvent(new Event("ended"));
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([
      {
        type: "failed",
        message:
          "The microphone disconnected. Choose a connected microphone and try again.",
      },
    ]);
    mic.close();
    mic.track.dispatchEvent(new Event("ended"));
    expect(mic.sent.filter((m) => m.type === "failed")).toHaveLength(1);
  });
});
