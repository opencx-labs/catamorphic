import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SystemKeys,
  type SystemKeysEvent,
  systemKeysOf,
} from "./system-keys.js";

const nativeDir = path.resolve(
  import.meta.dirname,
  "../../../native/voice-keys",
);

/** A helper process the test plays: what Work writes, and what it says. */
function fakeHelper() {
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) =>
    written.push(...chunk.trim().split("\n")),
  );
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
  return { written, stdout, child, spawns, spawnImpl };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("systemKeysOf", () => {
  it("names a binding's physical key and modifiers", () => {
    expect(systemKeysOf("Alt+Space")).toEqual({ keyCode: 49, modifiers: 4 });
    expect(systemKeysOf("Cmd+Shift+S")).toEqual({ keyCode: 1, modifiers: 9 });
    expect(systemKeysOf("Ctrl+F5")).toEqual({ keyCode: 96, modifiers: 2 });
  });

  it("knows no key it cannot place", () => {
    expect(systemKeysOf("")).toBeNull();
    expect(systemKeysOf("Cmd+é")).toBeNull();
  });
});

describe("SystemKeys", () => {
  it("binds each shortcut by name, hears them held, and dictates", async () => {
    const helper = fakeHelper();
    const events: SystemKeysEvent[] = [];
    const keys = new SystemKeys({
      helperPath: "/app/voice-keys",
      onEvent: (event) => events.push(event),
      onUntrusted: () => {},
      spawnImpl: helper.spawnImpl,
    });
    keys.watch({ dictate: "Alt+Space", "talk-to-work": "Cmd+Shift+Space" });
    keys.watch({ dictate: "Alt+Space", "talk-to-work": "Cmd+Shift+Space" });
    keys.watch({ dictate: "Cmd+Shift+S" });
    keys.dictate(3, "Ship it, then tell me.", true);
    keys.watchSend(true);
    await flush();
    expect(helper.spawns).toEqual(["/app/voice-keys"]);
    expect(helper.written).toEqual([
      "bind dictate 49 4",
      "bind talk-to-work 49 9",
      "bind talk-to-work -1 0",
      "bind dictate 1 9",
      `dictate 3 1 ${Buffer.from("Ship it, then tell me.").toString("base64")}`,
      "send-watch 1",
    ]);
    helper.stdout.write("ready\ndown dic");
    helper.stdout.write("tate\nup dictate\nsend\n");
    await flush();
    expect(events).toEqual([
      { type: "down", name: "dictate" },
      { type: "up", name: "dictate" },
      { type: "send" },
    ]);
    expect(keys.running).toBe(true);
  });

  it("names the app in front and its window", async () => {
    const helper = fakeHelper();
    const keys = new SystemKeys({
      helperPath: "/app/voice-keys",
      onEvent: () => {},
      onUntrusted: () => {},
      spawnImpl: helper.spawnImpl,
    });
    keys.watch({ dictate: "Alt+Space" });
    const place = keys.front();
    await flush();
    expect(helper.written.at(-1)).toBe("front");
    const json = Buffer.from(
      JSON.stringify({ app: "Slack", window: "#launch" }),
    ).toString("base64");
    helper.stdout.write(`front ${json}\n`);
    expect(await place).toEqual({ app: "Slack", window: "#launch" });
  });

  it("gives a late answer about the app in front to no one", async () => {
    vi.useFakeTimers();
    try {
      const helper = fakeHelper();
      const keys = new SystemKeys({
        helperPath: "/app/voice-keys",
        onEvent: () => {},
        onUntrusted: () => {},
        spawnImpl: helper.spawnImpl,
      });
      keys.watch({ dictate: "Alt+Space" });
      const late = keys.front();
      await vi.advanceTimersByTimeAsync(600);
      expect(await late).toBe(null);
      const next = keys.front();
      const answer = (app: string) =>
        Buffer.from(JSON.stringify({ app })).toString("base64");
      helper.stdout.write(
        `front ${answer("Mail")}\nfront ${answer("Slack")}\n`,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await next).toEqual({ app: "Slack", window: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when it stopped on its own, not when it was stopped", () => {
    const helper = fakeHelper();
    let gone = 0;
    const keys = new SystemKeys({
      helperPath: "/app/voice-keys",
      onEvent: () => {},
      onUntrusted: () => {},
      onGone: () => {
        gone += 1;
      },
      spawnImpl: helper.spawnImpl,
    });
    keys.watch({ dictate: "Alt+Space" });
    helper.child.emit("exit", 1);
    expect(gone).toBe(1);
    expect(keys.running).toBe(false);
    keys.watch({ dictate: "Alt+Space" });
    keys.stop();
    expect(gone).toBe(1);
  });

  it("says when macOS has not allowed it, and stops with no keys", async () => {
    const helper = fakeHelper();
    let untrusted = 0;
    const keys = new SystemKeys({
      helperPath: "/app/voice-keys",
      onEvent: () => {},
      onUntrusted: () => {
        untrusted += 1;
      },
      spawnImpl: helper.spawnImpl,
    });
    keys.watch({ dictate: "Alt+Space" });
    helper.stdout.write("untrusted\n");
    await flush();
    expect(untrusted).toBe(1);
    keys.watch({});
    expect(keys.running).toBe(false);
  });

  it("ships a prebuilt helper matching its source manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(nativeDir, "manifest.json"), "utf8"),
    );
    const digest = (file: string) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(nativeDir, file)))
        .digest("hex");
    expect(digest("keys.m")).toBe(manifest.sourceSha256);
    expect(digest("bin/voice-keys")).toBe(manifest.binarySha256);
    expect(manifest.protocol).toBe(1);
  });
});
