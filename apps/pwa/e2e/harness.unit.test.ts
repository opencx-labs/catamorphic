// @vitest-environment node

import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  chromeCdpStartupTimeoutMs,
  chromeLaunchArgs,
  waitForHttp,
  watchChild,
} from "./harness.js";

describe("PWA E2E Chrome arguments", () => {
  it("keeps CDP on the probed IPv4 loopback address", () => {
    expect(chromeLaunchArgs({ ci: "true", platform: "linux" })).toEqual([
      "--remote-debugging-address=127.0.0.1",
      "--no-sandbox",
    ]);
    expect(chromeLaunchArgs({ ci: undefined, platform: "linux" })).toEqual([
      "--remote-debugging-address=127.0.0.1",
    ]);
    expect(chromeLaunchArgs({ ci: "true", platform: "darwin" })).toEqual([
      "--remote-debugging-address=127.0.0.1",
    ]);
  });

  it("allows extra Chrome startup time on shared CI runners", () => {
    expect(chromeCdpStartupTimeoutMs("true")).toBe(30_000);
    expect(chromeCdpStartupTimeoutMs(undefined)).toBe(15_000);
  });
});

describe("PWA E2E process lifecycle", () => {
  it("bounds an HTTP probe even when the server never responds", async () => {
    const fetchRequest = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const startedAt = Date.now();

    await expect(
      waitForHttp("http://example.test/health", {
        timeoutMs: 40,
        requestTimeoutMs: 10,
        childFailure: new Promise<never>(() => {}),
        fetchRequest,
      }),
    ).rejects.toThrow("Never reachable");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fetchRequest).toHaveBeenCalled();
  });

  it("turns a spawn error into a bounded child failure", async () => {
    const child = watchChild(
      spawn("catamorphic-command-that-does-not-exist"),
      "test backend",
      () => {},
    );

    await expect(child.failure).rejects.toThrow("test backend failed to start");
  });
});
