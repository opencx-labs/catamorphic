import { describe, expect, it } from "vitest";
import { liveFrames } from "./live-frames.js";

const frame = (
  name: string,
  state: { detached?: boolean; destroyed?: boolean } = {},
) => ({
  name,
  detached: state.detached ?? false,
  isDestroyed: () => state.destroyed ?? false,
});

describe("liveFrames", () => {
  it("skips the null entries Electron returns for frames mid-creation or teardown", () => {
    const frames = [frame("top"), null, frame("child"), undefined];
    expect(liveFrames(frames).map((f) => f.name)).toEqual(["top", "child"]);
  });

  it("skips detached and destroyed frames", () => {
    const frames = [
      frame("top"),
      frame("leaving", { detached: true }),
      frame("gone", { destroyed: true }),
    ];
    expect(liveFrames(frames).map((f) => f.name)).toEqual(["top"]);
  });

  it("reads a page with no frame tree as no frames", () => {
    expect(liveFrames(undefined)).toEqual([]);
  });
});
