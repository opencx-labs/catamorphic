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

/** A sandbox provider that records every command it runs. */
function recordingProvider() {
  const commands: string[] = [];
  const provider = {
    workspaceRoot: "/workspace",
    executeCommand: async (_sandboxId: string, command: string) => {
      commands.push(command);
      return { exitCode: 0, result: command };
    },
    stopSandbox: async () => {},
  } as unknown as SandboxProvider;
  return { provider, commands };
}

/**
 * A control plane in memory: it hands out queued jobs by poll id, as the
 * real queue does, and lets each test fail calls on the way.
 */
function controlPlane(jobs: Job[]) {
  const taken = new Map<string, Job>();
  const pollIds: string[] = [];
  const receipts: Receipt[] = [];
  let waiting: (() => void) | undefined;
  const plane = {
    pollIds,
    receipts,
    faults: {
      poll: [] as Array<"transient" | "lost" | "ended">,
      complete: [] as Array<"transient" | "refused" | "rejected">,
    },
    transport: {
      renew: async () => {},
      poll: async ({ pollId, signal }) => {
        pollIds.push(pollId);
        const fault = plane.faults.poll.shift();
        if (fault === "transient") throw new Error("502 Bad Gateway");
        if (fault === "ended")
          throw new RunnerSessionEndedError("The lease moved on");
        const job = taken.get(pollId) ?? jobs.shift();
        if (!job) {
          // Long-poll until stopped.
          await new Promise<void>((resolve) => {
            waiting = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (signal.aborted) throw new Error("aborted");
          return null;
        }
        taken.set(pollId, job);
        // Taken on the server, but the response never arrives.
        if (fault === "lost") throw new Error("socket hang up");
        return job;
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
});
