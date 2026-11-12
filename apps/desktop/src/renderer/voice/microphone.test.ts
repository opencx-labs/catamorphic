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

function setup(
  warm = false,
  automaticFlush = true,
  microphone: string | null = null,
) {
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
  const getUserMedia = vi.fn(
    (_constraints: MediaStreamConstraints) => permission.promise,
  );
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
      onmessage: null as
        | ((event: MessageEvent<Float32Array | "flushed">) => void)
        | null,
      postMessage: vi.fn(() => {
        if (automaticFlush)
          queueMicrotask(() =>
            this.port.onmessage?.({
              data: "flushed",
            } as MessageEvent<"flushed">),
          );
      }),
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
  const close = listen(port, microphone, prepared);
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
    get tap() {
      return tap;
    },
    frame: (samples: Float32Array) =>
      tap.port.onmessage?.({ data: samples } as MessageEvent<Float32Array>),
    flushed: () =>
      tap.port.onmessage?.({ data: "flushed" } as MessageEvent<"flushed">),
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
    await mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.contextClose).not.toHaveBeenCalled();
    expect(mic.suspend).toHaveBeenCalledTimes(2);
    mic.prepared?.close();
    expect(mic.contextClose).toHaveBeenCalledOnce();
  });
  it("initializes its processor while the device is still opening", async () => {
    const mic = setup(true);
    mic.module.resolve();
    await flush();
    expect(mic.tap).toBeDefined();
    expect(mic.source).not.toHaveBeenCalled();
    mic.permission.resolve(mic.stream);
    mic.resume.resolve();
    await flush();
    expect(mic.source).toHaveBeenCalledOnce();
    await mic.close();
    expect(mic.tap.port.close).toHaveBeenCalledOnce();
  });

  it("releases an unused processor immediately when device opening is canceled", async () => {
    const mic = setup(true);
    mic.module.resolve();
    await flush();
    expect(mic.tap).toBeDefined();
    await mic.close();
    expect(mic.tap.port.close).toHaveBeenCalledOnce();
    expect(mic.tap.disconnect).toHaveBeenCalledOnce();
    mic.permission.resolve(mic.stream);
    await flush();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(mic.source).not.toHaveBeenCalled();
    expect(mic.sent).toEqual([]);
  });

  it("disposes the initialized processor if opening the device fails", async () => {
    const mic = setup(true);
    mic.module.resolve();
    await flush();
    expect(mic.tap).toBeDefined();
    mic.permission.reject(new Error("device unavailable"));
    await flush();
    expect(mic.tap.port.close).toHaveBeenCalledOnce();
    expect(mic.tap.disconnect).toHaveBeenCalledOnce();
    expect(mic.source).not.toHaveBeenCalled();
    expect(mic.sent.filter((event) => event.type === "failed")).toMatchObject([
      { message: expect.stringContaining("device unavailable") },
    ]);
  });

  it("does not create a late processor after device opening failed", async () => {
    const mic = setup(true);
    mic.permission.reject(new Error("device unavailable"));
    await flush();
    mic.module.resolve();
    await flush();
    expect(mic.tap).toBeUndefined();
    expect(mic.source).not.toHaveBeenCalled();
    expect(mic.sent.filter((event) => event.type === "failed")).toHaveLength(1);
  });

  it("releases a permission result that arrives after voice stopped", async () => {
    const mic = setup();
    await mic.close();
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
    await mic.close();
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
    await mic.close();
    await mic.close();
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
    await mic.close();
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
    await mic.close();
    expect(mic.stop).toHaveBeenCalledOnce();
  });

  it("bounds recovery to one replacement and ignores ended events after release", async () => {
    const mic = setup();
    mic.permission.resolve(mic.stream);
    mic.module.resolve();
    mic.resume.resolve();
    await flush();
    mic.track.dispatchEvent(new Event("ended"));
    await flush();
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([]);
    expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
    mic.track.dispatchEvent(new Event("ended"));
    expect(mic.sent.filter((m) => m.type === "failed")).toEqual([
      {
        type: "failed",
        message:
          "The microphone disconnected. Choose a connected microphone and try again.",
      },
    ]);
    await mic.close();
    mic.track.dispatchEvent(new Event("ended"));
    expect(mic.sent.filter((m) => m.type === "failed")).toHaveLength(1);
  });
});

it("drains a disconnected input and resumes the same hold on the system microphone", async () => {
  const mic = setup(true);
  mic.permission.resolve(mic.stream);
  mic.module.resolve();
  mic.resume.resolve();
  await flush();
  mic.frame(new Float32Array([0.1]));
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), {
    label: "Built-in microphone",
    stop,
  });
  const fallback = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  mic.getUserMedia.mockResolvedValueOnce(fallback);
  mic.track.dispatchEvent(new Event("ended"));
  await flush();
  expect(mic.stop).toHaveBeenCalledOnce();
  expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
  expect(mic.source).toHaveBeenCalledTimes(2);
  expect(mic.suspend).toHaveBeenCalledOnce();
  mic.frame(new Float32Array([0.2]));
  expect(mic.sent.filter((event) => event.type === "frame")).toMatchObject([
    { samples: new Float32Array([0.1]) },
    { samples: new Float32Array([0.2]) },
  ]);
  expect(mic.sent).toContainEqual({ type: "capture-opening" });
  expect(mic.sent).toContainEqual({
    type: "microphone",
    label: "Built-in microphone",
  });
  expect(mic.sent.filter((event) => event.type === "failed")).toEqual([]);
  await mic.close();
  expect(stop).toHaveBeenCalledOnce();
});

it("does not mark a replacement ready because the disconnected input flushed its first partial frame", async () => {
  const mic = setup(true, false);
  mic.permission.resolve(mic.stream);
  mic.module.resolve();
  mic.resume.resolve();
  await flush();
  mic.track.dispatchEvent(new Event("ended"));
  mic.frame(new Float32Array([0.1]));
  expect(mic.sent.filter((event) => event.type === "capturing")).toEqual([]);
  expect(mic.sent).toContainEqual({ type: "capture-opening" });
  mic.flushed();
  await flush();
  mic.frame(new Float32Array([0.2]));
  expect(mic.sent.filter((event) => event.type === "capturing")).toHaveLength(
    1,
  );
  const closed = mic.close();
  mic.flushed();
  await closed;
});

it("does not wait for a slow replacement request when the person releases", async () => {
  const mic = setup(true);
  mic.permission.resolve(mic.stream);
  mic.module.resolve();
  mic.resume.resolve();
  await flush();
  const replacement = deferred<MediaStream>();
  mic.getUserMedia.mockReturnValueOnce(replacement.promise);
  mic.track.dispatchEvent(new Event("ended"));
  await flush();
  expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
  await mic.close();
  const stop = vi.fn();
  replacement.resolve({
    getTracks: () => [{ stop }],
  } as unknown as MediaStream);
  await flush();
  expect(stop).toHaveBeenCalledOnce();
  expect(mic.source).toHaveBeenCalledOnce();
});

it("recovers an input that already ended before its permission result arrived", async () => {
  const mic = setup(true);
  Reflect.set(mic.track, "readyState", "ended");
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), {
    label: "Built-in",
    readyState: "live",
    stop,
  });
  mic.getUserMedia.mockResolvedValueOnce({
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream);
  mic.permission.resolve(mic.stream);
  mic.module.resolve();
  mic.resume.resolve();
  await vi.waitFor(() => expect(mic.source).toHaveBeenCalledOnce());
  expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
  expect(mic.sent).toContainEqual({ type: "capture-opening" });
  expect(mic.sent.filter((event) => event.type === "failed")).toEqual([]);
  await mic.close();
  expect(stop).toHaveBeenCalledOnce();
});

it("does not retry a microphone permission denial", async () => {
  const mic = setup(true, true, "chosen");
  mic.permission.reject(
    new DOMException("permission denied", "NotAllowedError"),
  );
  await flush();
  expect(mic.getUserMedia).toHaveBeenCalledOnce();
  expect(mic.sent.filter((event) => event.type === "failed")).toMatchObject([
    { message: expect.stringContaining("permission denied") },
  ]);
});

it.each(["OverconstrainedError", "NotFoundError"])(
  "falls back when the selected input is missing (%s)",
  async (name) => {
    const mic = setup(true, true, "headphones");
    mic.getUserMedia.mockResolvedValueOnce(mic.stream);
    mic.permission.reject(new DOMException("input is gone", name));
    mic.module.resolve();
    mic.resume.resolve();
    await flush();
    expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
    expect(mic.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: { deviceId: { exact: "headphones" } },
    });
    expect(mic.getUserMedia.mock.calls[1]?.[0]).not.toHaveProperty(
      "audio.deviceId",
    );
    expect(mic.sent.filter((event) => event.type === "failed")).toEqual([]);
    await mic.close();
  },
);

it("stops the physical track on release, but drains queued frames before completing", async () => {
  const mic = setup(true, false);
  mic.permission.resolve(mic.stream);
  mic.module.resolve();
  mic.resume.resolve();
  await flush();
  const finished = vi.fn();
  const closed = mic.close().then(finished);
  expect(mic.stop).toHaveBeenCalledOnce();
  await flush();
  expect(finished).not.toHaveBeenCalled();
  mic.frame(new Float32Array([0.2, 0.4]));
  mic.flushed();
  await closed;
  expect(mic.sent.filter((event) => event.type === "frame")).toMatchObject([
    { samples: new Float32Array([0.2, 0.4]) },
  ]);
  expect(finished).toHaveBeenCalledOnce();
  expect(mic.suspend).toHaveBeenCalledTimes(2);
});

it("reports a stalled worklet drain instead of silently finalizing incomplete audio", async () => {
  vi.useFakeTimers();
  try {
    const mic = setup(true, false);
    mic.permission.resolve(mic.stream);
    mic.module.resolve();
    mic.resume.resolve();
    await flush();
    const closed = mic.close();
    const failed = expect(closed).rejects.toThrow(
      "could not finish its captured audio",
    );
    expect(mic.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1500);
    await failed;
    expect(mic.suspend).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
