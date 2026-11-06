import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceAudioUp } from "../../shared/voice.js";
import { listen } from "./microphone.js";

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

function setup() {
  const permission = deferred<MediaStream>();
  const module = deferred<void>();
  const resume = deferred<void>();
  const stop = vi.fn();
  const stream = {
    getTracks: () => [{ stop }],
    getAudioTracks: () => [{ label: "Default microphone" }],
  } as unknown as MediaStream;
  const source = vi.fn(() => ({ connect: vi.fn() }));
  const contextClose = vi.fn(async () => {});
  class Context {
    sampleRate = 16000;
    audioWorklet = { addModule: () => module.promise };
    createMediaStreamSource = source;
    resume = () => resume.promise;
    close = contextClose;
  }
  class Tap {
    port = { onmessage: null, close: vi.fn() };
    disconnect = vi.fn();
  }
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(() => permission.promise) },
  });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Tap);
  const sent: VoiceAudioUp[] = [];
  const port = {
    postMessage: (value: VoiceAudioUp) => sent.push(value),
  } as unknown as MessagePort;
  const close = listen(port, null);
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
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("a microphone that stops while capture is starting", () => {
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
});
