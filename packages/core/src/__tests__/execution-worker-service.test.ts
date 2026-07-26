import { describe, expect, it } from "vitest";
import type {
  ExecutionJob,
  ExecutionJobsService,
} from "../services/execution-jobs-service.js";
import { ExecutionWorkerService } from "../services/execution-worker-service.js";
import type { RetentionService } from "../services/retention-service.js";

function job(id: string): ExecutionJob {
  return {
    id,
    tenantId: "tenant",
    workflowRunId: "run",
    workflowStepAttemptId: null,
    kind: "workflow_run",
    payload: {},
    status: "running",
    priority: 0,
    availableAt: new Date().toISOString(),
    attempt: 1,
    maxAttempts: 5,
    leasedBy: "worker",
    leaseToken: "token",
    leaseGeneration: "1",
    leaseExpiresAt: new Date().toISOString(),
    dedupeKey: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    exhaustionHandledAt: null,
  };
}

describe("execution worker retention sweep", () => {
  const idleJobs = {
    requeueExpired: async () => 0,
    listUnhandledExhausted: async () => [],
    claim: async () => [],
    heartbeat: async () => true,
    complete: async () => true,
    fail: async () => "completed" as const,
    release: async () => true,
  } as unknown as ExecutionJobsService;

  it("sweeps once per interval no matter how often the loop polls", async () => {
    let sweeps = 0;
    const retention = {
      isEnabled: true,
      // Long enough that the many polls in this window collapse to one sweep.
      sweepIntervalMs: 60_000,
      purgeExpiredRuns: async () => {
        sweeps += 1;
        return { purgedRuns: 0 };
      },
    } as unknown as RetentionService;

    const service = new ExecutionWorkerService(idleJobs, retention);
    const worker = service.start({ pollIntervalMs: 1, concurrency: 4 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await worker.stop();

    expect(sweeps).toBe(1);
  });

  it("does not sweep when retention is disabled", async () => {
    let sweeps = 0;
    const retention = {
      isEnabled: false,
      sweepIntervalMs: 1,
      purgeExpiredRuns: async () => {
        sweeps += 1;
        return { purgedRuns: 0 };
      },
    } as unknown as RetentionService;

    const service = new ExecutionWorkerService(idleJobs, retention);
    const worker = service.start({ pollIntervalMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.stop();

    expect(sweeps).toBe(0);
  });
});

describe("execution worker resilience", () => {
  it("keeps polling after a transient database error", async () => {
    let claimCalls = 0;
    const processed: string[] = [];
    const jobs = {
      requeueExpired: async () => 0,
      listUnhandledExhausted: async () => [],
      claim: async () => {
        claimCalls += 1;
        // A connection reset on the first poll, work available on the next.
        if (claimCalls === 1) throw new Error("connection terminated");
        if (claimCalls === 2) return [job("job-1")];
        return [];
      },
      heartbeat: async () => true,
      complete: async () => true,
      fail: async () => "completed" as const,
      release: async () => true,
    } as unknown as ExecutionJobsService;

    const service = new ExecutionWorkerService(jobs);
    service.registerHandler({
      kind: "workflow_run",
      handler: async ({ job: claimed }) => {
        processed.push(claimed.id);
      },
    });

    const worker = service.start({ pollIntervalMs: 1 });
    // Give the loop room to hit the error, recover, and claim real work.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await worker.stop();

    // Without recovery the loop exits on the first throw: claimCalls stays 1
    // and the job is never seen, silently retiring a concurrency slot.
    expect(processed).toEqual(["job-1"]);
    expect(claimCalls).toBeGreaterThan(2);
  });

  it("surfaces no unhandled rejection when a poll fails", async () => {
    const jobs = {
      requeueExpired: async () => {
        throw new Error("pool timeout");
      },
      listUnhandledExhausted: async () => [],
      claim: async () => [],
      heartbeat: async () => true,
      complete: async () => true,
      fail: async () => "completed" as const,
      release: async () => true,
    } as unknown as ExecutionJobsService;

    const service = new ExecutionWorkerService(jobs);
    const worker = service.start({ pollIntervalMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
