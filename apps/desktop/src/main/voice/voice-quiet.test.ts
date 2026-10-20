import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { QUIET_PHASES, VoiceQuiet } from "./voice-quiet.js";

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
    kill: () => {
      child.emit("exit", null);
      return true;
    },
  });
  const spawns: string[] = [];
  const spawnImpl = ((file: string) => {
    spawns.push(file);
    return child;
  }) as unknown as typeof spawn;
  return { written, stdout, spawns, spawnImpl, ended: () => ended };
}

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

  it("keeps other audio lowered while voice listens or waits, never while the agent speaks", () => {
    expect([...QUIET_PHASES].sort()).toEqual([
      "hearing",
      "listening",
      "thinking",
    ]);
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
