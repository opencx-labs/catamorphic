import { describe, expect, it } from "vitest";
import { DockerStreamDemuxer, dockerFrame } from "../stream-demux.js";

function text(frames: ReturnType<DockerStreamDemuxer["push"]>) {
  return frames.map((frame) => `${frame.stream}:${frame.data.toString()}`);
}

describe("DockerStreamDemuxer", () => {
  it("splits stdout and stderr frames", () => {
    const demuxer = new DockerStreamDemuxer();
    const stream = Buffer.concat([
      dockerFrame(1, Buffer.from("out")),
      dockerFrame(2, Buffer.from("err")),
      dockerFrame(1, Buffer.from("")),
    ]);
    expect(text(demuxer.push(stream))).toEqual([
      "stdout:out",
      "stderr:err",
      "stdout:",
    ]);
    expect(demuxer.buffered).toBe(0);
  });

  it("joins frames cut anywhere, one byte at a time", () => {
    const demuxer = new DockerStreamDemuxer();
    const stream = Buffer.concat([
      dockerFrame(1, Buffer.from("hello ")),
      dockerFrame(2, Buffer.from("warning")),
      dockerFrame(1, Buffer.from("world")),
    ]);
    const frames = [...stream].flatMap((byte) =>
      text(demuxer.push(Uint8Array.of(byte))),
    );
    expect(frames).toEqual(["stdout:hello ", "stderr:warning", "stdout:world"]);
  });

  it("holds a partial frame until the rest arrives", () => {
    const demuxer = new DockerStreamDemuxer();
    const frame = dockerFrame(1, Buffer.alloc(100_000, 97));
    expect(demuxer.push(frame.subarray(0, 50_000))).toEqual([]);
    expect(demuxer.buffered).toBe(50_000);
    const [whole] = demuxer.push(frame.subarray(50_000));
    expect(whole?.data.length).toBe(100_000);
  });

  it("drops stdin echoes and refuses unknown streams", () => {
    const demuxer = new DockerStreamDemuxer();
    expect(demuxer.push(dockerFrame(0, Buffer.from("in")))).toEqual([]);
    const bad = dockerFrame(1, Buffer.from("x"));
    bad[0] = 7;
    expect(() => demuxer.push(bad)).toThrow("unknown stream");
  });
});
