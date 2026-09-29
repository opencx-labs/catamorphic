import type { SandboxProvider } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import {
  type ClientRunnerTransport,
  ReceiptRefusedError,
  ResultRejectedError,
  RunnerSessionEndedError,
  startClientRunner,
} from "./client-runner.js";

type Job = { id: string; operation: unknown };
type Receipt = { jobId: string; response?: unknown; error?: string };

/**
 * A sandbox provider that records every command it runs. `sleep` commands
 * run until their sandbox stops.
 */
function recordingProvider() {
  const commands: string[] = [];
  const stopped: string[] = [];
  const sleeping = new Set<() => void>();
  const unsupported = async (): Promise<never> => {
    throw new Error("Not used by these tests");
  };
  const provider: SandboxProvider = {
    workspaceRoot: "/workspace",
    executeCommand: async (_sandboxId, command) => {
      commands.push(command);
      if (command.startsWith("sleep"))
        await new Promise<void>((resolve) => sleeping.add(resolve));
      return { exitCode: 0, result: command };
    },
    stopSandbox: async (sandboxId) => {
      stopped.push(sandboxId);
      for (const wake of sleeping) wake();
      sleeping.clear();
    },
    createSandbox: unsupported,
    startSandbox: unsupported,
    destroySandbox: unsupported,
    getSandboxStatus: unsupported,
    uploadFiles: unsupported,
    downloadFile: unsupported,
    gitClone: unsupported,
    gitCheckout: unsupported,
  };
  return { provider, commands, stopped };
}

/**
 * A control plane in memory: it hands out queued jobs by poll id, as the
 * real queue does, and lets each test fail calls on the way.
 */
function controlPlane(jobs: Job[]) {
  const taken = new Map<string, Job[]>();
  const pollIds: string[] = [];
  const maxes: number[] = [];
  const receipts: Receipt[] = [];
  let waiting: (() => void) | undefined;
  const plane = {
    pollIds,
    maxes,
    receipts,
    faults: {
      poll: [] as Array<"transient" | "lost" | "ended">,
      complete: [] as Array<"transient" | "refused" | "rejected">,
    },
    transport: {
      renew: async () => {},
      poll: async ({ pollId, max, signal }) => {
        pollIds.push(pollId);
        maxes.push(max);
        const fault = plane.faults.poll.shift();
        if (fault === "transient") throw new Error("502 Bad Gateway");
        if (fault === "ended")
          throw new RunnerSessionEndedError("The lease moved on");
        const took = taken.get(pollId) ?? jobs.splice(0, max);
        if (took.length === 0) {
          // Long-poll until stopped.
          await new Promise<void>((resolve) => {
            waiting = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (signal.aborted) throw new Error("aborted");
          return [];
        }
        taken.set(pollId, took);
        // Taken on the server, but the response never arrives.
        if (fault === "lost") throw new Error("socket hang up");
        return took;
      },
      complete: async (receipt) => {
        const fault = plane.faults.complete.shift();
        if (fault === "transient") throw new Error("503 Service Unavailable");
        if (fault === "refused")
          throw new ReceiptRefusedError("No longer accepted");
        if (fault === "rejected") throw new ResultRejectedError("Too large");
        receipts.push(receipt);
      },
      disconnect: async () => {},
    } satisfies ClientRunnerTransport,
    wake: () => waiting?.(),
  };
  return plane;
}

function execute(id: string, command: string): Job {
  return {
    id,
    operation: { kind: "execute", sandboxId: "sandbox-1", command },
  };
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("client runner transport (ADR 0187)", () => {
  it("rides out transient failures and runs each operation once", async () => {
    const { provider, commands } = recordingProvider();
    const plane = controlPlane([execute("job-1", "echo one")]);
    plane.faults.poll.push("transient", "transient", "lost");
    plane.faults.complete.push("transient", "transient");
    const retries: unknown[] = [];
    const errors: unknown[] = [];
    const runner = startClientRunner({
      provider,
      transport: plane.transport,
      sandboxes: new Set(["sandbox-1"]),
      onRetry: (error) => retries.push(error),
      onError: (error) => errors.push(error),
    });
    await until(() => plane.receipts.length === 1, "the receipt");
    await runner.stop();
    expect(commands).toEqual(["echo one"]);
    expect(plane.receipts).toEqual([
      { jobId: "job-1", response: { exitCode: 0, result: "echo one" } },
    ]);
    // Every retry of that poll carried the same id, so the job it took on
    // the lost response came back.
    const [first, ...retried] = plane.pollIds.slice(0, 4);
    expect(retried).toEqual([first, first, first]);
    expect(retries).toHaveLength(5);
    expect(errors).toEqual([]);
  });

  it("drops a refused receipt and keeps serving", async () => {
    const { provider, commands } = recordingProvider();
    const plane = controlPlane([
      execute("job-1", "echo abandoned"),
      execute("job-2", "echo next"),
    ]);
    plane.faults.complete.push("refused");
    const errors: unknown[] = [];
    const runner = startClientRunner({
      provider,
      transport: plane.transport,
      sandboxes: new Set(["sandbox-1"]),
      concurrency: 1,
      onError: (error) => errors.push(error),
    });
    await until(() => plane.receipts.length === 1, "the next receipt");
    await runner.stop();
    expect(commands).toEqual(["echo abandoned", "echo next"]);
    expect(plane.receipts.map((receipt) => receipt.jobId)).toEqual(["job-2"]);
    expect(errors).toEqual([]);
  });

  it("reports a result the control plane rejects as a failed operation", async () => {
    const { provider } = recordingProvider();
    const plane = controlPlane([execute("job-1", "cat huge")]);
    plane.faults.complete.push("rejected");
    const runner = startClientRunner({
      provider,
      transport: plane.transport,
      sandboxes: new Set(["sandbox-1"]),
    });
    await until(() => plane.receipts.length === 1, "the failure receipt");
    await runner.stop();
    expect(plane.receipts).toEqual([
      {
        jobId: "job-1",
        error: "The result could not be delivered: Too large",
      },
    ]);
  });

  it("ends the session only on the control plane's definite answer", async () => {
    const { provider } = recordingProvider();
    const plane = controlPlane([]);
    plane.faults.poll.push("transient", "ended");
    const errors: unknown[] = [];
    const ended = new Promise<void>((resolve) => {
      startClientRunner({
        provider,
        transport: plane.transport,
        onError: (error) => {
          errors.push(error);
          resolve();
        },
      });
    });
    await ended;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RunnerSessionEndedError);
  });

  it("stops without waiting for a long poll to return", async () => {
    const { provider } = recordingProvider();
    const plane = controlPlane([]);
    const runner = startClientRunner({ provider, transport: plane.transport });
    await until(() => plane.pollIds.length === 1, "the first poll");
    const started = Date.now();
    await runner.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("takes as many operations at once as it has free slots", async () => {
    const { provider, commands } = recordingProvider();
    const plane = controlPlane([
      execute("job-1", "sleep a"),
      execute("job-2", "sleep b"),
      execute("job-3", "echo c"),
    ]);
    const runner = startClientRunner({
      provider,
      transport: plane.transport,
      sandboxes: new Set(["sandbox-1"]),
      concurrency: 3,
    });
    await until(() => plane.receipts.length === 1, "the quick receipt");
    expect(plane.maxes[0]).toBe(3);
    expect(commands.sort()).toEqual(["echo c", "sleep a", "sleep b"]);
    // Two slots stay busy: the next poll asks for one.
    await until(() => plane.maxes.length === 2, "the next poll");
    expect(plane.maxes[1]).toBe(1);
    await runner.stop();
  });

  it("stops a member's sandboxes instead of waiting for their commands", async () => {
    const { provider, stopped } = recordingProvider();
    const plane = controlPlane([execute("job-1", "sleep forever")]);
    const runner = startClientRunner({
      provider,
      transport: plane.transport,
      sandboxes: new Set(["sandbox-1"]),
    });
    await until(() => plane.pollIds.length === 2, "the command to start");
    const started = Date.now();
    await runner.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stopped).toEqual(["sandbox-1"]);
    // The command's receipt finds the runner stopped and is not sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(plane.receipts).toEqual([]);
  });
});
