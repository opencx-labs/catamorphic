// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  VOICE_CAPTURE_MESSAGE,
  VOICE_PORT_MESSAGE,
  VOICE_REST_MESSAGE,
  type VoiceCaptureCommand,
} from "../../shared/voice.js";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(() => vi.fn(async () => {})),
  speakerClose: vi.fn(),
  receive: vi.fn(),
  prepared: { close: vi.fn() },
}));
vi.mock("./microphone.js", () => ({
  listen: mocks.listen,
  prepareMicrophone: () => mocks.prepared,
}));
vi.mock("./speaker.js", () => ({
  Speaker: class {
    close = mocks.speakerClose;
    receive = mocks.receive;
  },
}));
const message = (data: unknown, ports: MessagePort[] = []) =>
  window.dispatchEvent(
    new MessageEvent("message", { source: window, data, ports }),
  );
const control = (command: VoiceCaptureCommand) =>
  message({ type: VOICE_CAPTURE_MESSAGE, command });
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  message({ type: VOICE_REST_MESSAGE });
  vi.clearAllMocks();
});
async function connect() {
  await import("./voice-io.js");
  const channel = new MessageChannel();
  const post = vi
    .spyOn(channel.port1, "postMessage")
    .mockImplementation(() => {});
  message({ type: VOICE_PORT_MESSAGE, microphone: "chosen", listen: true }, [
    channel.port1,
  ]);
  await flush();
  return { channel, post };
}
it("closes and reopens physical capture on the same port without replacing playback", async () => {
  const { channel, post } = await connect();
  const closer = mocks.listen.mock.results[0]?.value;
  control({ type: "hold", held: false, release: 1 });
  await flush();
  expect(closer).toHaveBeenCalledOnce();
  expect(mocks.speakerClose).not.toHaveBeenCalled();
  control({ type: "hold", held: true });
  await flush();
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  expect(mocks.listen).toHaveBeenLastCalledWith(
    channel.port1,
    "chosen",
    mocks.prepared,
  );
  expect(post.mock.calls.map(([value]) => value)).toEqual([
    { type: "control", command: { type: "hold", held: true } },
    { type: "control", command: { type: "hold", held: false, release: 1 } },
    { type: "control", command: { type: "hold", held: true } },
  ]);
  message({ type: VOICE_REST_MESSAGE });
  expect(mocks.listen.mock.results[1]?.value).toHaveBeenCalledOnce();
  control({ type: "hold", held: true });
  await flush();
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  channel.port2.close();
});
it("puts final frames before release and the next press, including retarget controls", async () => {
  let drained!: () => void;
  const closer = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        drained = resolve;
      }),
  );
  mocks.listen.mockReturnValueOnce(closer);
  const { channel, post } = await connect();
  control({ type: "hold", held: false, release: 7 });
  control({ type: "forget" });
  control({ type: "dictation", enabled: true });
  control({ type: "hold", held: true });
  await flush();
  expect(closer).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledTimes(1);
  channel.port1.postMessage({
    type: "frame",
    samples: new Float32Array([0.2]),
    sampleRate: 16000,
  });
  drained();
  await flush();
  expect(post.mock.calls.map(([value]) => value)).toEqual([
    { type: "control", command: { type: "hold", held: true } },
    { type: "frame", samples: new Float32Array([0.2]), sampleRate: 16000 },
    { type: "control", command: { type: "hold", held: false, release: 7 } },
    { type: "control", command: { type: "forget" } },
    { type: "control", command: { type: "dictation", enabled: true } },
    { type: "control", command: { type: "hold", held: true } },
  ]);
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  channel.port2.close();
});
it("does not reopen capture when a pending drain finishes after the voice rests", async () => {
  let drained!: () => void;
  mocks.listen.mockReturnValueOnce(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          drained = resolve;
        }),
    ),
  );
  const { channel, post } = await connect();
  control({ type: "hold", held: false, release: 8 });
  control({ type: "hold", held: true });
  await flush();
  message({ type: VOICE_REST_MESSAGE });
  drained();
  await flush();
  expect(mocks.listen).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledTimes(1);
  channel.port2.close();
});

it("finishes the previous voice's input graph before a new port resumes it", async () => {
  let drained!: () => void;
  mocks.listen.mockReturnValueOnce(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          drained = resolve;
        }),
    ),
  );
  const first = await connect();
  message({ type: VOICE_REST_MESSAGE });
  const second = await connect();
  expect(mocks.listen).toHaveBeenCalledOnce();
  drained();
  await flush();
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  first.channel.port2.close();
  second.channel.port2.close();
});
