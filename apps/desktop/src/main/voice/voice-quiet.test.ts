import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUIET_PHASES,
  quietForConversation,
  VoiceQuiet,
} from "./voice-quiet.js";

const nativeDir = path.resolve(
  import.meta.dirname,
  "../../../native/voice-quiet",
);

/** A helper process the test plays: what Work writes, and what it says. */
function fakeHelper() {
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) =>
    written.push(...chunk.trim().split("\n")),
  );
  let ended = false;
  stdin.on("finish", () => {
    ended = true;
  });
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    kill: vi.fn(() => {
      child.emit("exit", null);
      return true;
    }),
  });
  const spawns: string[] = [];
  const spawnImpl = ((file: string) => {
    spawns.push(file);
    return child;
  }) as unknown as typeof spawn;
  return { child, written, stdout, spawns, spawnImpl, ended: () => ended };
}

afterEach(() => vi.useRealTimers());

const flush = () => new Promise((resolve) => setImmediate(resolve));
const label = "MacBook Pro Microphone (Built-in)";
const base64 = Buffer.from(label, "utf8").toString("base64");

describe("VoiceQuiet", () => {
  it("lowers other audio once voice knows its microphone, and lets it back up", async () => {
    const helper = fakeHelper();
    const quiet = new VoiceQuiet({
      helperPath: "/app/voice-quiet",
      spawnImpl: helper.spawnImpl,
    });
    // Nothing to name yet: nothing starts.
    quiet.set({ quiet: true, microphone: null });
    expect(helper.spawns).toEqual([]);
    quiet.set({ quiet: true, microphone: label });
    quiet.set({ quiet: true, microphone: label });
    quiet.set({ quiet: false, microphone: label });
    quiet.set({ quiet: true, microphone: label });
    await flush();
    expect(helper.spawns).toEqual(["/app/voice-quiet"]);
    expect(helper.written).toEqual([
      `quiet ${base64}`,
      "loud",
      `quiet ${base64}`,
    ]);
    quiet.stop();
    await flush();
    expect(helper.ended()).toBe(true);
  });

  it("follows a microphone changed mid-voice, and stops asking for one it cannot lower audio for", async () => {
    const helper = fakeHelper();
    const quiet = new VoiceQuiet({
      helperPath: "/app/voice-quiet",
      spawnImpl: helper.spawnImpl,
    });
    quiet.set({ quiet: true, microphone: label });
    helper.stdout.write("ready\nunavailable microphone\n");
    await flush();
    quiet.set({ quiet: false, microphone: label });
    quiet.set({ quiet: true, microphone: label });
    // Another microphone is asked about again.
    quiet.set({ quiet: true, microphone: "USB Mic (USB)" });
    quiet.set({ quiet: true, microphone: label });
    await flush();
    const usb = Buffer.from("USB Mic (USB)", "utf8").toString("base64");
    expect(helper.written).toEqual([`quiet ${base64}`, `quiet ${usb}`, "loud"]);
    // The next voice asks again.
    quiet.stop();
    const next = fakeHelper();
    const again = new VoiceQuiet({
      helperPath: "/app/voice-quiet",
      spawnImpl: next.spawnImpl,
    });
    again.set({ quiet: true, microphone: label });
    await flush();
    expect(next.written).toEqual([`quiet ${base64}`]);
  });

  it("releases native voice processing before letting the helper exit", async () => {
    const helper = fakeHelper();
    const quiet = new VoiceQuiet({
      helperPath: "/app/voice-quiet",
      spawnImpl: helper.spawnImpl,
    });
    quiet.set({ quiet: true, microphone: label });
    quiet.stop();
    await flush();
    expect(helper.written).toEqual([`quiet ${base64}`, "loud"]);
    expect(helper.ended()).toBe(true);
    expect(helper.child.kill).not.toHaveBeenCalled();
    helper.child.emit("exit", 0);
  });

  it("bounds cleanup of a helper that cannot exit", () => {
    vi.useFakeTimers();
    const helper = fakeHelper();
    const quiet = new VoiceQuiet({
      helperPath: "/app/voice-quiet",
      spawnImpl: helper.spawnImpl,
    });
    quiet.set({ quiet: true, microphone: label });
    quiet.stop();
    expect(helper.child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(helper.child.kill).toHaveBeenCalledOnce();
  });

  it("keeps other audio lowered while voice listens or waits, never while the agent speaks", () => {
    expect([...QUIET_PHASES].sort()).toEqual([
      "hearing",
      "listening",
      "thinking",
    ]);
  });

  it("keeps dictation and voice learning from lowering other audio", () => {
    for (const phase of QUIET_PHASES) {
      expect(
        quietForConversation({
          phase,
          target: { kind: "dictation" },
          learning: false,
        }),
      ).toBe(false);
      expect(
        quietForConversation({ phase, target: null, learning: false }),
      ).toBe(false);
      expect(
        quietForConversation({
          phase,
          target: { kind: "assistant" },
          learning: true,
        }),
      ).toBe(false);
      expect(
        quietForConversation({
          phase,
          target: { kind: "assistant" },
          learning: false,
        }),
      ).toBe(true);
      expect(
        quietForConversation({
          phase,
          target: { kind: "chat", projectId: "p", sessionId: "s" },
          learning: false,
        }),
      ).toBe(true);
    }
    expect(
      quietForConversation({
        phase: "speaking",
        target: { kind: "assistant" },
        learning: false,
      }),
    ).toBe(false);
    expect(
      quietForConversation({
        phase: "off",
        target: { kind: "assistant" },
        learning: false,
      }),
    ).toBe(false);
  });

  it("ships a prebuilt helper matching its source manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(nativeDir, "manifest.json"), "utf8"),
    );
    const digest = (file: string) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(nativeDir, file)))
        .digest("hex");
    expect(digest("quiet.m")).toBe(manifest.sourceSha256);
    expect(digest("bin/voice-quiet")).toBe(manifest.binarySha256);
    expect(manifest.protocol).toBe(1);
  });
});
