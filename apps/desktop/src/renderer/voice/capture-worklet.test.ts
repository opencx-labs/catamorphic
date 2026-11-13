import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("flushes the incomplete final chunk before acknowledging release", async () => {
  let Processor!: new () => {
    process(inputs: Float32Array[][]): boolean;
    port: {
      postMessage: ReturnType<typeof vi.fn>;
      onmessage: (event: MessageEvent<string>) => void;
    };
  };
  class Base {
    port = { postMessage: vi.fn(), onmessage: () => {} };
  }
  vi.stubGlobal("AudioWorkletProcessor", Base);
  vi.stubGlobal("sampleRate", 16000);
  vi.stubGlobal(
    "registerProcessor",
    (_name: string, processor: typeof Processor) => {
      Processor = processor;
    },
  );
  await import("./capture-worklet.js");
  const tap = new Processor();
  const first = Float32Array.from({ length: 320 }, (_, i) => i / 320);
  const tail = new Float32Array([0.25, 0.5, 0.75]);
  tap.process([[first]]);
  tap.process([[tail]]);
  expect(tap.port.postMessage).toHaveBeenCalledTimes(1);
  tap.port.onmessage({ data: "flush" } as MessageEvent<string>);
  expect(tap.port.postMessage.mock.calls.map(([value]) => value)).toEqual([
    first,
    tail,
    "flushed",
  ]);
  tap.port.onmessage({ data: "flush" } as MessageEvent<string>);
  expect(tap.port.postMessage.mock.calls.at(-1)).toEqual(["flushed"]);
  const sent = tap.port.postMessage.mock.calls.length;
  expect(tap.process([[first]])).toBe(false);
  expect(tap.port.postMessage).toHaveBeenCalledTimes(sent);
});
