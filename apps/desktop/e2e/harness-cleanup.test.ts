import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeE2eDirectory, terminate } from "./harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeE2eDirectory", () => {
  it("reclaims immutable snapshots without changing symlink targets", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cleanup-"));
    const own = path.join(base, "profile"),
      outside = path.join(base, "outside");
    fs.mkdirSync(own);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "unchanged");
    const before = fs.statSync(outside).mode;
    fs.symlinkSync(outside, path.join(own, "link"), "dir");
    const snapshot = path.join(own, "snapshot");
    fs.mkdirSync(snapshot);
    fs.writeFileSync(path.join(snapshot, "source.ts"), "source");
    fs.chmodSync(snapshot, 0o555);
    await removeE2eDirectory(own);
    expect(fs.existsSync(own)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe(
      "unchanged",
    );
    expect(fs.statSync(outside).mode).toBe(before);
    await removeE2eDirectory(base);
  });
});

describe("Electron teardown status", () => {
  it("waits for a successful signal-triggered cleanup", async () => {
    const child = spawn(process.execPath, [
      "-e",
      `
      process.on("SIGTERM", () => setTimeout(() => process.exit(0), 20));
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
    `,
    ]);
    await once(child.stdout, "data");
    await terminate(child);
    expect(child.exitCode).toBe(0);
  });

  it("rejects a process that already failed instead of passing teardown", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"]);
    await once(child, "exit");
    await expect(terminate(child)).rejects.toThrow("code 7");
  });

  it("detects an already signal-killed process without waiting for another exit event", async () => {
    const child = spawn(process.execPath, [
      "-e",
      'process.kill(process.pid, "SIGKILL")',
    ]);
    await once(child, "exit");
    await expect(terminate(child)).rejects.toThrow("SIGKILL");
  });
});
