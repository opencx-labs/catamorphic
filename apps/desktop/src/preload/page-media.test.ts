import { afterEach, describe, expect, it, vi } from "vitest";
import { installPageMedia } from "./page-media.js";

type Kind = "microphone" | "camera" | "screenShare";
function setup() {
  class Track extends EventTarget {
    readyState = "live";
    enabled = true;
    constructor(readonly kind: string) {
      super();
    }
    stop() {
      this.readyState = "ended";
    }
    clone() {
      const clone = new Track(this.kind);
      clone.readyState = this.readyState;
      clone.enabled = this.enabled;
      return clone;
    }
    ended() {
      this.readyState = "ended";
      this.dispatchEvent(new Event("ended"));
    }
  }
  class Stream {
    constructor(private tracks: Track[]) {}
    getTracks() {
      return this.tracks;
    }
    clone() {
      return new Stream(this.tracks.map((t) => t.clone()));
    }
  }
  let revoke!: (kind: Kind) => void;
  const devices = {
    getUserMedia: vi.fn(async () => new Stream([new Track("audio")])),
    getDisplayMedia: vi.fn(
      async () => new Stream([new Track("video"), new Track("audio")]),
    ),
  };
  const host = new EventTarget();
  Object.assign(host, {
    __workPageMedia: {
      onRevoke: (cb: typeof revoke) => {
        revoke = cb;
      },
    },
  });
  vi.stubGlobal("window", host);
  const legacy = {
    mediaDevices: devices,
    getUserMedia: vi.fn(
      (_constraints: unknown, success: (stream: Stream) => void) =>
        success(new Stream([new Track("audio")])),
    ),
    webkitGetUserMedia: vi.fn(
      (_constraints: unknown, success: (stream: Stream) => void) =>
        success(new Stream([new Track("audio")])),
    ),
  };
  vi.stubGlobal("navigator", legacy);
  vi.stubGlobal("MediaStreamTrack", Track);
  vi.stubGlobal("MediaStream", Stream);
  const userMedia = devices.getUserMedia;
  const nativeLegacy = { ...legacy };
  installPageMedia();
  return {
    Track,
    userMedia,
    Stream,
    devices,
    legacy,
    nativeLegacy,
    revoke: (kind: Kind) => revoke(kind),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("page capture revocation", () => {
  it("revokes a clone after its original track was stopped", async () => {
    const { devices, revoke } = setup();
    const stream = await devices.getUserMedia();
    const track = stream.getTracks()[0]!;
    const clone = track.clone();
    track.stop();
    expect(track.readyState).toBe("ended");
    expect(clone.readyState).toBe("live");
    revoke("microphone");
    expect(clone.readyState).toBe("ended");
  });
  it("does not pin a microphone by adding track lifecycle listeners", async () => {
    const { devices, Track } = setup();
    const added = vi.spyOn(Track.prototype, "addEventListener");
    const stream = await devices.getUserMedia();
    stream.clone();
    stream.getTracks()[0]!.clone();
    expect(added).not.toHaveBeenCalled();
  });
  it("revokes callback capture through both Chromium entry points", () => {
    const { legacy, revoke } = setup();
    for (const name of ["getUserMedia", "webkitGetUserMedia"] as const) {
      let track!: { readyState: string };
      legacy[name]({}, (stream) => {
        track = stream.getTracks()[0]!;
      });
      expect(track.readyState).toBe("live");
      revoke("microphone");
      expect(track.readyState).toBe("ended");
    }
  });
  it("preserves capture kind when another realm clones a track", async () => {
    const child = setup();
    const original = await child.devices.getUserMedia();
    const parent = setup();
    const clone = new parent.Stream(original.getTracks()).clone();
    child.revoke("microphone");
    expect(original.getTracks()[0]?.readyState).toBe("ended");
    expect(clone.getTracks()[0]?.readyState).toBe("live");
    parent.revoke("microphone");
    expect(clone.getTracks()[0]?.readyState).toBe("ended");
  });
  it("revokes a muted live track and tolerates naturally ended capture", async () => {
    const { devices, revoke } = setup();
    const stream = await devices.getUserMedia();
    const track = stream.getTracks()[0]!;
    const clone = track.clone();
    track.enabled = false;
    clone.ended();
    expect(track.readyState).toBe("live");
    revoke("microphone");
    expect(track.readyState).toBe("ended");
    expect(clone.readyState).toBe("ended");
  });
  it("revokes only the selected device, including mixed stream clones", async () => {
    const { Track, Stream, devices, userMedia, revoke } = setup();
    userMedia.mockResolvedValueOnce(
      new Stream([new Track("audio"), new Track("video")]),
    );
    const input = await devices.getUserMedia(),
      share = await devices.getDisplayMedia();
    const clone = new Stream([
      ...input.getTracks(),
      ...share.getTracks(),
    ]).clone();
    revoke("microphone");
    expect(input.getTracks().map((t) => t.readyState)).toEqual([
      "ended",
      "live",
    ]);
    expect(clone.getTracks().map((t) => t.readyState)).toEqual([
      "ended",
      "live",
      "live",
      "live",
    ]);
    revoke("camera");
    expect(clone.getTracks().map((t) => t.readyState)).toEqual([
      "ended",
      "ended",
      "live",
      "live",
    ]);
    expect(share.getTracks().every((t) => t.readyState === "live")).toBe(true);
    revoke("screenShare");
    expect(clone.getTracks().every((t) => t.readyState === "ended")).toBe(true);
    expect(share.getTracks().every((t) => t.readyState === "ended")).toBe(true);
  });
  it("stops permission results arriving after revocation", async () => {
    const { Track, Stream, devices, userMedia, revoke } = setup();
    let grant!: (stream: InstanceType<typeof Stream>) => void;
    userMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const opening = devices.getUserMedia();
    revoke("microphone");
    grant(new Stream([new Track("audio")]));
    const stream = await opening;
    expect(stream.getTracks()[0]?.readyState).toBe("ended");
    const later = await devices.getUserMedia();
    expect(later.getTracks()[0]?.readyState).toBe("live");
    later.getTracks()[0]!.stop();
  });
  it("stops late callback results from both legacy APIs", () => {
    const { Track, Stream, legacy, nativeLegacy, revoke } = setup();
    for (const name of ["getUserMedia", "webkitGetUserMedia"] as const) {
      let grant!: (stream: InstanceType<typeof Stream>) => void;
      nativeLegacy[name].mockImplementationOnce((_constraints, success) => {
        grant = success;
      });
      const received = vi.fn();
      legacy[name]({}, received);
      revoke("microphone");
      const stream = new Stream([new Track("audio")]);
      grant(stream);
      expect(received).toHaveBeenCalledWith(stream);
      expect(stream.getTracks()[0]?.readyState).toBe("ended");
    }
  });
  it("preserves request rejection", async () => {
    const { devices, userMedia } = setup();
    userMedia.mockRejectedValueOnce(new Error("denied"));
    await expect(devices.getUserMedia()).rejects.toThrow("denied");
  });
});
