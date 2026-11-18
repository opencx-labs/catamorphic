import { spawn } from "node:child_process";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import {
  diagnostic,
  endRunner,
  killProcessGroups,
  type RunnerChannel,
  sandboxChannel,
} from "../services/sessions/runner-channels.js";

/*
 * Ending a runner for a restart (ADR 0333): asked first, its process group
 * killed when it does not go, and the next attempt waits for either.
 */

function fakeRunner(input: { exitsOn: "SIGTERM" | "SIGKILL" | "never" }) {
  const signals: string[] = [];
  const killed: number[][] = [];
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
    // Groups are this machine's here: killed for real.
    killGroups: async (groups) => {
      killed.push([...groups]);
      killProcessGroups(groups);
    },
  };
  return { channel, signals, killed };
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

  it("kills every group its harness reported before giving up on a runner that ignores every signal", async () => {
    // An agent in a process group of its own, as an ACP agent runs.
    const agent = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    const pgid = agent.pid ?? 0;
    const alive = () => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = new Promise((resolve) => agent.once("exit", resolve));
    expect(alive()).toBe(true);
    const { channel, signals, killed } = fakeRunner({ exitsOn: "never" });
    expect(
      await endRunner({ channel, cursor: 0, graceMs: 100, groups: [pgid] }),
    ).toBe("unknown");
    // Its own group twice, and the agent's group with each.
    expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
    expect(killed).toEqual([[pgid], [pgid]]);
    await gone;
    expect(alive()).toBe(false);
  }, 15_000);

  it("signals a sandbox runner's process with SIGTERM, or SIGKILL when forced", async () => {
    const sent: string[] = [];
    const commands: string[] = [];
    const provider = {
      processes: {
        signalProcess: async ({ signal }: { signal: string }) => {
          sent.push(signal);
        },
      },
      executeCommand: async (_sandboxId: string, command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
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
    // Its harness's own groups, inside the sandbox; nothing a harness could
    // not have reported.
    await channel.killGroups([4242, 77, 1, -3, 2.5]);
    expect(commands).toEqual(["kill -KILL -- -4242 -- -77 2>/dev/null; true"]);
  });

  it("kills a harness's groups beside the runner, never in the command container of a sandbox that runs commands apart", async () => {
    // Two containers, two process namespaces (ADR 0332): the same group id
    // names the harness's agent beside the runner and an unrelated command
    // of the pull request's.
    const groups = {
      agent: new Set([42]),
      commands: new Set([42]),
    };
    const provider = {
      processes: { signalProcess: async () => {} },
      executeCommand: async (
        _sandboxId: string,
        command: string,
        opts?: { side?: "agent" | "commands" },
      ) => {
        const side = groups[opts?.side ?? "commands"];
        for (const [, group] of command.matchAll(/-- -(\d+)/g))
          side.delete(Number(group));
        return { exitCode: 0, result: "" };
      },
    } as unknown as SandboxProvider;
    const channel = sandboxChannel({
      provider,
      location: {
        kind: "sandbox_process",
        allocationId: "allocation",
        sandboxId: "sandbox",
        processId: "proc-agent-runner",
      } as Parameters<typeof sandboxChannel>[0]["location"],
    });
    await channel.killGroups([42]);
    expect(groups.agent.has(42)).toBe(false);
    expect(groups.commands.has(42)).toBe(true);
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
