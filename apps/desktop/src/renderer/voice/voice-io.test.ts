// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import {
  VOICE_CAPTURE_MESSAGE,
  VOICE_PORT_MESSAGE,
  VOICE_REST_MESSAGE,
} from "../../shared/voice.js";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(() => vi.fn()),
  speakerClose: vi.fn(),
  receive: vi.fn(),
}));
vi.mock("./microphone.js", () => ({ listen: mocks.listen }));
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

afterEach(() => message({ type: VOICE_REST_MESSAGE }));

it("releases and reopens capture on the same port while playback continues", async () => {
  await import("./voice-io.js");
  const port = { onmessage: vi.fn(), close: vi.fn() };
  // The test port only needs the audio page's port interface.
  const channel = new MessageChannel();
  const audioPort = channel.port1;
  vi.spyOn(audioPort, "close").mockImplementation(port.close);
  message({ type: VOICE_PORT_MESSAGE, microphone: "chosen", listen: true }, [
    audioPort,
  ]);
  const closer = mocks.listen.mock.results[0]?.value;
  message({ type: VOICE_CAPTURE_MESSAGE, listening: false });
  expect(closer).toHaveBeenCalledOnce();
  expect(mocks.speakerClose).not.toHaveBeenCalled();
  expect(port.close).not.toHaveBeenCalled();
  message({ type: VOICE_CAPTURE_MESSAGE, listening: true });
  message({ type: VOICE_CAPTURE_MESSAGE, listening: true });
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  expect(mocks.listen).toHaveBeenLastCalledWith(audioPort, "chosen");
  message({ type: VOICE_REST_MESSAGE });
  expect(mocks.listen.mock.results[1]?.value).toHaveBeenCalledOnce();
  message({ type: VOICE_CAPTURE_MESSAGE, listening: true });
  expect(mocks.listen).toHaveBeenCalledTimes(2);
  channel.port2.close();
});
