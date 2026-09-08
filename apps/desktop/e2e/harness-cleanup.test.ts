import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeE2eDirectory, terminate } from "./harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeE2eDirectory", () => {
  it("retries transient Linux directory removal races", () => {
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    removeE2eDirectory("/tmp/catamorphic-e2e-data-test");

    expect(remove).toHaveBeenCalledWith("/tmp/catamorphic-e2e-data-test", {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
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
