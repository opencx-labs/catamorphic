import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CheckResult,
  type CommandWatch,
  CommandWatches,
  runShellCheck,
} from "./command-watches.js";

/** Scripted checks and a saved-file stand-in, on a fake clock. */
function harness(options: { saved?: CommandWatch[] } = {}) {
  const results: CheckResult[] = [];
  const runs: string[] = [];
  let saved: CommandWatch[] = options.saved ?? [];
  const woken: Array<{ content: string; notice: string; key: string }> = [];
  let failWake = false;
  const watches = new CommandWatches({
    run: async ({ command }) => {
      runs.push(command);
      return results.shift() ?? { exitCode: 1, output: "not yet" };
    },
    load: async () => structuredClone(saved),
    save: async (list) => {
      saved = structuredClone(list);
    },
    changed: () => {},
  });
  void watches.setNotifier(async (input) => {
    if (failWake) throw new Error("archived");
    woken.push({
      content: input.content,
      notice: input.notice,
      key: input.idempotencyKey,
    });
  });
  return {
    watches,
    results,
    runs,
    woken,
    saved: () => saved,
    failWakes: () => {
      failWake = true;
    },
  };
}

const start = (
  watches: CommandWatches,
  overrides: Partial<Parameters<CommandWatches["start"]>[0]> = {},
) =>
  watches.start({
    projectId: "p",
    sessionId: "s",
    command: "curl -fsS https://example.com/health",
    description: "Deploy is live",
    until: "success",
    everySeconds: 10,
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CommandWatches", () => {
  it("ends at once when a success check already passes", async () => {
    const h = harness();
    h.results.push({ exitCode: 0, output: "ok" });
    const result = await start(h.watches);
    expect(result).toMatchObject({
      status: "finished",
      output: "ok",
      nextCheckInSeconds: null,
    });
    expect(h.saved()).toEqual([]);
    expect(h.watches.list()).toMatchObject([
      { kind: "watch", status: "finished", key: null },
    ]);
  });

  it("wakes once when the check starts succeeding, then stops", async () => {
    const h = harness();
    const result = await start(h.watches);
    expect(result).toMatchObject({ status: "running", nextCheckInSeconds: 10 });
    expect(h.saved()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.woken).toEqual([]);
    h.results.push({ exitCode: 0, output: "healthy" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runs).toHaveLength(3);
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]?.content).toContain("succeeded on check 3");
    expect(h.woken[0]?.content).toContain("healthy");
    expect(h.woken[0]?.notice).toBe("Deploy is live: done");
    expect(h.saved()).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.runs).toHaveLength(3);
  });

  it("wakes on each change against the last output, not on repeats", async () => {
    const h = harness();
    h.results.push({ exitCode: 0, output: "pending" });
    await start(h.watches, {
      until: "change",
      description: "Review state",
      command: "gh pr view 7 --json reviewDecision -q .reviewDecision",
    });
    h.results.push({ exitCode: 0, output: "pending" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.woken).toEqual([]);
    h.results.push({ exitCode: 0, output: "APPROVED" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]?.content).toContain("Before:\npending");
    expect(h.woken[0]?.content).toContain("Now:\nAPPROVED");
    // A failing check is a change too.
    h.results.push({ exitCode: 1, output: "APPROVED" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.woken).toHaveLength(2);
    expect(h.woken[1]?.content).toContain("Now (exit 1)");
    expect(h.watches.list()).toMatchObject([{ status: "running" }]);
  });

  it("resumes saved watches with one check for all the time it missed", async () => {
    const saved: CommandWatch = {
      id: "watch-1",
      projectId: "p",
      sessionId: "s",
      command: "cat status",
      description: "Status",
      everySeconds: 30,
      until: "change",
      createdAt: Date.now() - 86_400_000,
      expiresAt: null,
      // Due a day ago: the laptop was asleep since.
      dueAt: Date.now() - 86_000_000,
      baseline: null,
      lastOutput: "building",
      checks: 4,
    };
    const h = harness({ saved: [saved] });
    h.results.push({ exitCode: 0, output: "deployed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.runs).toEqual(["cat status"]);
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]?.content).toContain("Before:\nbuilding");
    expect(h.saved()[0]?.dueAt).toBe(Date.now() + 30_000);
  });

  it("ends an expired watch with one message, even after downtime", async () => {
    const h = harness();
    await start(h.watches, { expiresInSeconds: 25 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]?.content).toContain("expired after 3 checks");
    expect(h.woken[0]?.notice).toBe("Stopped watching: Deploy is live");
    expect(h.saved()).toEqual([]);
  });

  it("stops with the chat: archive, stop, or a chat that is gone", async () => {
    const h = harness();
    const first = await start(h.watches);
    const second = await start(h.watches, { sessionId: "other" });
    expect(h.watches.count("p", ["s", "other"])).toBe(2);
    expect(await h.watches.stopForSessions("p", ["s"])).toBe(1);
    await expect(
      h.watches.stop({ sessionId: "s", id: second.id }),
    ).rejects.toThrow("No watch");
    expect(await h.watches.stop({ sessionId: "s", id: first.id })).toEqual({
      status: "stopped",
    });

    h.failWakes();
    h.results.push({ exitCode: 0, output: "up" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.saved()).toEqual([]);
    expect(h.watches.count("p", ["other"])).toBe(0);
  });
});

describe("runShellCheck", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns output and exit status, and kills a check that hangs", async () => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    await expect(
      runShellCheck({
        command: "echo hi; exit 3",
        timeoutMs: 5_000,
        env,
        shell: "/bin/sh",
      }),
    ).resolves.toEqual({ exitCode: 3, raw: "hi\n" });
    const hung = await runShellCheck({
      command: "sleep 30",
      timeoutMs: 200,
      env,
      shell: "/bin/sh",
    });
    expect(hung.exitCode).toBeNull();
    expect(hung.raw).toContain("timed out");
  });
});
