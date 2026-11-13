import { execFileSync, type spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeRecognition } from "./native-recognition.js";

const nativeDir = path.resolve(
  import.meta.dirname,
  "../../../native/speech-recognition",
);

function fakeHelper() {
  const written: Buffer[] = [];
  const stdin = new PassThrough();
  stdin.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
  const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
  const reply = (value: unknown, code = 0) => {
    stdout.write(`${JSON.stringify(value)}\n`);
    child.emit("close", code, null);
  };
  const success = {
    protocol: 1,
    ok: true,
    text: "A sentence.",
    confidence: -0.2,
  };
  return { child, spawnImpl, stdout, written, reply, success };
}

const audio = () => new Float32Array([0.125, -0.5, 0.25]);

afterEach(() => vi.useRealTimers());

describe("live native recognition", () => {
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  function live() {
    const prepare = fakeHelper();
    const stream = fakeHelper();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(prepare.child)
      .mockReturnValueOnce(stream.child) as unknown as typeof spawn;
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl,
    });
    return { prepare, stream, recognition, spawnImpl };
  }

  it("streams copied PCM and revised UTF-8 text before release, then finalizes on EOF", async () => {
    const native = live();
    const partials: string[] = [];
    const held = native.recognition.start((text) => partials.push(text));
    const samples = audio();
    held.write(samples);
    samples.fill(1);
    native.prepare.reply(native.prepare.success);
    await flush();
    expect(native.spawnImpl).toHaveBeenLastCalledWith(
      "/app/speech-recognition",
      ["--stream"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(native.stream.child.stdin.writableEnded).toBe(false);
    expect(Buffer.concat(native.stream.written).readFloatLE(0)).toBe(0.125);
    const line = Buffer.from(
      `${JSON.stringify({ protocol: 1, type: "partial", text: "café" })}\n`,
    );
    const accent = line.indexOf(Buffer.from("é"));
    native.stream.stdout.write(line.subarray(0, accent + 1));
    expect(partials).toEqual([]);
    native.stream.stdout.write(line.subarray(accent + 1));
    expect(partials).toEqual(["café"]);
    native.stream.stdout.write(
      JSON.stringify({ protocol: 1, type: "partial", text: "café today" }) +
        "\n",
    );
    expect(partials).toEqual(["café", "café today"]);
    const done = held.finish();
    expect(native.stream.child.stdin.writableEnded).toBe(true);
    native.stream.reply({ ...native.stream.success, text: "Café today." });
    await expect(done).resolves.toMatchObject({ text: "Café today." });
    native.recognition.dispose();
  });

  it("cancels an active stream and ignores its late partial and final results", async () => {
    const native = live();
    const partial = vi.fn();
    const held = native.recognition.start(partial);
    native.prepare.reply(native.prepare.success);
    await flush();
    held.write(audio());
    held.cancel();
    const done = held.finish();
    native.stream.stdout.write(
      JSON.stringify({ protocol: 1, type: "partial", text: "old target" }) +
        "\n",
    );
    native.stream.reply(native.stream.success);
    await expect(done).rejects.toThrow("stopped");
    expect(partial).not.toHaveBeenCalled();
    expect(native.stream.child.kill).toHaveBeenCalledWith("SIGTERM");
    native.recognition.dispose();
  });
});

describe("NativeRecognition", () => {
  it("sends only the supplied float32 view and returns Apple's transcript and log confidence", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      locale: "en-US",
      spawnImpl: helper.spawnImpl,
    });
    const samples = new Float32Array([99, 0.125, -0.5, 99]).subarray(1, 3);
    const pending = recognition.recognize(samples);
    samples.fill(1);
    expect(helper.spawnImpl).toHaveBeenCalledWith(
      "/app/speech-recognition",
      ["--locale", "en-US"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const bytes = Buffer.concat(helper.written);
    expect(bytes.length).toBe(8);
    expect(bytes.readFloatLE(0)).toBe(0.125);
    expect(bytes.readFloatLE(4)).toBe(-0.5);
    helper.reply(helper.success);
    await expect(pending).resolves.toEqual({
      text: "A sentence.",
      confidence: -0.2,
    });
    recognition.dispose();
    expect(helper.child.kill).not.toHaveBeenCalled();
  });

  it("returns empty or silent audio without starting Apple's recognizer", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    for (const samples of [
      new Float32Array(),
      new Float32Array(16_000),
      new Float32Array([0.000001, -0.000001]),
    ]) {
      await expect(recognition.recognize(samples)).resolves.toEqual({
        text: "",
        confidence: 0,
      });
    }
    expect(helper.spawnImpl).not.toHaveBeenCalled();
  });

  it("rejects nonfinite and oversized input before starting a helper", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    for (const invalid of [NaN, Infinity, -Infinity]) {
      await expect(
        recognition.recognize(new Float32Array([invalid])),
      ).rejects.toThrow("invalid audio");
    }
    await expect(
      recognition.recognize(new Float32Array(16_000 * 60 + 1)),
    ).rejects.toThrow("up to one minute");
    expect(helper.spawnImpl).not.toHaveBeenCalled();
  });

  it("prepares once, sharing permission/asset setup across callers", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.prepare();
    expect(recognition.prepare()).toBe(pending);
    expect(helper.spawnImpl).toHaveBeenCalledWith(
      "/app/speech-recognition",
      ["--prepare"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(helper.written).toEqual([]);
    helper.reply({ protocol: 1, ok: true, text: "", confidence: 0 });
    await expect(pending).resolves.toBeUndefined();
    await recognition.prepare();
    expect(helper.spawnImpl).toHaveBeenCalledOnce();
  });

  it("preserves actionable native errors and permits retrying failed preparation", async () => {
    const first = fakeHelper();
    const second = fakeHelper();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl,
    });
    const denied = recognition.prepare();
    first.reply(
      {
        protocol: 1,
        ok: false,
        error: {
          code: "speech_permission",
          message:
            "Allow Work in System Settings > Privacy & Security > Speech Recognition.",
        },
      },
      1,
    );
    await expect(denied).rejects.toThrow("Allow Work in System Settings");
    const retry = recognition.prepare();
    second.reply({ protocol: 1, ok: true, text: "", confidence: 0 });
    await expect(retry).resolves.toBeUndefined();
  });

  it("collects JSON split across byte chunks without damaging non-Latin text", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    const bytes = Buffer.from(
      JSON.stringify({ ...helper.success, text: "مرحبا بالعالم" }),
    );
    for (const byte of bytes) helper.stdout.write(Buffer.from([byte]));
    helper.child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({
      text: "مرحبا بالعالم",
      confidence: -0.2,
    });
  });

  it("returns zero confidence when the OS recognizes no words", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    helper.reply({ ...helper.success, text: "", confidence: -5 });
    await expect(pending).resolves.toEqual({ text: "", confidence: 0 });
  });

  it.each([
    { protocol: 2, ok: true, text: "words", confidence: 0 },
    { protocol: 1, ok: true, text: "words", confidence: 0.8 },
    { protocol: 1, ok: true, text: "words" },
    { protocol: 1, ok: true, text: 4, confidence: 0 },
  ])("rejects invalid native responses: %j", async (reply) => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    helper.reply(reply);
    await expect(pending).rejects.toThrow("without a valid response");
  });

  it("rejects a crash instead of treating its last JSON as success", async () => {
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    helper.reply(helper.success, 1);
    await expect(pending).rejects.toThrow("ended unexpectedly");
  });

  it("handles a missing helper without leaving a pending request", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/missing/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    helper.child.emit("error", new Error("ENOENT"));
    helper.child.emit("close", -2, null);
    await expect(pending).rejects.toThrow(
      "Could not start macOS speech recognition",
    );
    vi.advanceTimersByTime(1000);
    expect(helper.child.kill).toHaveBeenCalledTimes(1);
  });

  it("bounds transcription time and force-kills a stuck helper", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      timeoutMs: 100,
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    const rejected = expect(pending).rejects.toThrow("timed out");
    vi.advanceTimersByTime(100);
    await rejected;
    expect(helper.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    vi.advanceTimersByTime(1000);
    expect(helper.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    helper.child.emit("close", null, "SIGKILL");
  });

  it("bounds permission/asset setup separately from transcription", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      timeoutMs: 1,
      prepareTimeoutMs: 100,
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.prepare();
    const rejected = expect(pending).rejects.toThrow(
      "speech preparation timed out",
    );
    vi.advanceTimersByTime(100);
    await rejected;
    helper.child.emit("close", null, "SIGTERM");
    vi.advanceTimersByTime(1000);
    expect(helper.child.kill).toHaveBeenCalledOnce();
  });

  it("cancels active helpers and immediately prepares and recognizes again", async () => {
    vi.useFakeTimers();
    const first = fakeHelper();
    const second = fakeHelper();
    const third = fakeHelper();
    const fourth = fakeHelper();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(third.child)
      .mockReturnValueOnce(fourth.child) as unknown as typeof spawn;
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl,
    });
    const preparing = recognition.prepare();
    const transcribing = recognition.recognize(audio());
    const rejected = [
      expect(preparing).rejects.toThrow("stopped"),
      expect(transcribing).rejects.toThrow("stopped"),
    ];
    recognition.cancel();
    // Start the next preparation before the previous rejection's microtask.
    const nextPreparation = recognition.prepare();
    await Promise.all(rejected);
    expect(recognition.prepare()).toBe(nextPreparation);
    expect(first.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second.child.kill).toHaveBeenCalledWith("SIGTERM");
    // Late results from canceled helpers cannot settle the next request.
    first.reply(first.success);
    second.reply(second.success);
    third.reply({ protocol: 1, ok: true, text: "", confidence: 0 });
    await expect(nextPreparation).resolves.toBeUndefined();
    const nextTranscript = recognition.recognize(audio());
    fourth.reply(fourth.success);
    await expect(nextTranscript).resolves.toEqual({
      text: "A sentence.",
      confidence: -0.2,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1000);
    expect(first.child.kill).toHaveBeenCalledOnce();
    expect(second.child.kill).toHaveBeenCalledOnce();
    expect(third.child.kill).not.toHaveBeenCalled();
    expect(fourth.child.kill).not.toHaveBeenCalled();
  });

  it("keeps successful asset preparation across holds without keeping a helper alive", async () => {
    const first = fakeHelper();
    const second = fakeHelper();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl,
    });
    const prepared = recognition.prepare();
    first.reply({ protocol: 1, ok: true, text: "", confidence: 0 });
    await prepared;
    expect(recognition.prepare()).toBe(prepared);
    recognition.cancel();
    recognition.cancel();
    expect(recognition.prepare()).toBe(prepared);
    expect(spawnImpl).toHaveBeenCalledOnce();
    const result = recognition.recognize(audio());
    second.reply(second.success);
    await expect(result).resolves.toMatchObject({ text: "A sentence." });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    recognition.dispose();
  });

  it("rechecks assets after a genuine stream failure", async () => {
    const first = fakeHelper();
    const stream = fakeHelper();
    const retry = fakeHelper();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(stream.child)
      .mockReturnValueOnce(retry.child);
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: spawnImpl as unknown as typeof spawn,
    });
    const held = recognition.start(() => {});
    first.reply(first.success);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const failed = expect(held.finish()).rejects.toThrow(
      "Prepare assets again.",
    );
    stream.reply(
      {
        protocol: 1,
        ok: false,
        error: { code: "assets_required", message: "Prepare assets again." },
      },
      1,
    );
    await failed;
    const preparing = recognition.prepare();
    expect(spawnImpl).toHaveBeenCalledTimes(3);
    retry.reply(retry.success);
    await preparing;
    recognition.dispose();
  });

  it("cancels all pending native work when disposed and rejects later work", async () => {
    vi.useFakeTimers();
    const first = fakeHelper();
    const second = fakeHelper();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl,
    });
    const preparing = recognition.prepare();
    const transcribing = recognition.recognize(audio());
    const rejected = [
      expect(preparing).rejects.toThrow("stopped"),
      expect(transcribing).rejects.toThrow("stopped"),
    ];
    recognition.dispose();
    await Promise.all(rejected);
    expect(first.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second.child.kill).toHaveBeenCalledWith("SIGTERM");
    first.child.emit("close", null, "SIGTERM");
    second.child.emit("close", null, "SIGTERM");
    recognition.dispose();
    await expect(recognition.prepare()).rejects.toThrow("stopped");
    await expect(recognition.recognize(new Float32Array())).rejects.toThrow(
      "stopped",
    );
    vi.advanceTimersByTime(1000);
    expect(first.child.kill).toHaveBeenCalledOnce();
    expect(second.child.kill).toHaveBeenCalledOnce();
  });

  it("bounds malformed helper output", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    helper.stdout.write(Buffer.alloc(256 * 1024 + 1));
    await expect(pending).rejects.toThrow("too much data");
    helper.child.emit("close", null, "SIGTERM");
  });

  it("handles a closed stdin pipe without crashing Work", async () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const recognition = new NativeRecognition({
      helperPath: "/app/speech-recognition",
      spawnImpl: helper.spawnImpl,
    });
    const pending = recognition.recognize(audio());
    helper.child.stdin.emit("error", new Error("EPIPE"));
    helper.child.emit("close", 1, null);
    await expect(pending).rejects.toThrow("Could not send audio");
  });

  it("ships a universal helper pinned to the source and embedded permission description", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(nativeDir, "manifest.json"), "utf8"),
    );
    const digest = (file: string) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(nativeDir, file)))
        .digest("hex");
    expect(digest("speech.swift")).toBe(manifest.sourceSha256);
    expect(digest("Info.plist")).toBe(manifest.infoPlistSha256);
    expect(digest("bin/speech-recognition")).toBe(manifest.binarySha256);
    expect(manifest.protocol).toBe(1);
    expect(manifest.minimumMacOS).toBe("13.0");
  });

  it.skipIf(process.platform !== "darwin")(
    "answers version and silent PCM without asking permissions or preparing assets",
    () => {
      const helper = path.join(nativeDir, "bin/speech-recognition");
      expect(
        execFileSync(helper, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim(),
      ).toBe("work-speech-recognition 1");
      const output = execFileSync(helper, [], {
        input: Buffer.alloc(64_000),
        encoding: "utf8",
        timeout: 5000,
      });
      expect(JSON.parse(output)).toEqual({
        protocol: 1,
        ok: true,
        text: "",
        confidence: 0,
      });
    },
  );
});
