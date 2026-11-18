import type { SandboxProvider } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import {
  diagnostic,
  endRunner,
  type RunnerChannel,
  sandboxChannel,
} from "../services/sessions/runner-channels.js";

/*
 * Ending a runner for a restart (ADR 0333): asked first, its process group
 * killed when it does not go, and the next attempt waits for either.
 */

function fakeRunner(input: { exitsOn: "SIGTERM" | "SIGKILL" | "never" }) {
  const signals: string[] = [];
  let exited = false;
  const channel: RunnerChannel = {
    location: {
      kind: "sandbox_process",
      allocationId: "allocation",
      sandboxId: "sandbox",
      processId: "runner",
    } as RunnerChannel["location"],
    send: async () => {},
    read: async ({ cursor, waitMs }) => {
      if (!exited) await new Promise((resolve) => setTimeout(resolve, waitMs));
      return { frames: [], diagnostics: [], cursor, exited };
    },
    kill: async (options) => {
      const signal = options?.force ? "SIGKILL" : "SIGTERM";
      signals.push(signal);
      if (input.exitsOn === signal) exited = true;
    },
  };
  return { channel, signals };
}

describe("endRunner", () => {
  it("asks a runner to stop and waits for it to exit", async () => {
    const { channel, signals } = fakeRunner({ exitsOn: "SIGTERM" });
    expect(await endRunner({ channel, cursor: 0, graceMs: 2_000 })).toBe(
      "exited",
    );
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("kills the process group of one that does not stop in time, and only then returns", async () => {
    const { channel, signals } = fakeRunner({ exitsOn: "SIGKILL" });
    const started = Date.now();
    expect(await endRunner({ channel, cursor: 0, graceMs: 300 })).toBe(
      "killed",
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("gives up waiting on one that never exits", async () => {
    const { channel, signals } = fakeRunner({ exitsOn: "never" });
    expect(await endRunner({ channel, cursor: 0, graceMs: 100 })).toBe(
      "unknown",
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 15_000);

  it("signals a sandbox runner's process with SIGTERM, or SIGKILL when forced", async () => {
    const sent: string[] = [];
    const provider = {
      processes: {
        signalProcess: async ({ signal }: { signal: string }) => {
          sent.push(signal);
        },
      },
    } as unknown as SandboxProvider;
    const channel = sandboxChannel({
      provider,
      location: {
        kind: "sandbox_process",
        allocationId: "allocation",
        sandboxId: "sandbox",
        processId: "runner",
      } as Parameters<typeof sandboxChannel>[0]["location"],
    });
    await channel.kill();
    await channel.kill({ force: true });
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

it("keeps a runner's line whole or leaves it out, never part of one", () => {
  expect(diagnostic("short")).toBe("short");
  const secret = "sk-live-0123456789abcdef";
  const long = `${"x".repeat(3_990)} token=${secret}`;
  expect(diagnostic(long)).toBe(
    `[A ${long.length}-character line of output was left out]`,
  );
  expect(diagnostic(long)).not.toContain("sk-live");
});
