import { getTracer, type SpanAttributes, withSpan } from "@catamorphic/otel";
import type {
  ExecutionJob,
  ExecutionJobKind,
  ExecutionJobsService,
} from "./execution-jobs-service.js";
import type { RetentionService } from "./retention-service.js";

const tracer = getTracer("@catamorphic/core");

export type ExecutionJobHandler = (args: {
  job: ExecutionJob;
  signal: AbortSignal;
}) => Promise<void>;

export interface ExecutionWorkerOptions {
  name?: string;
  concurrency?: number;
  claimLimit?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  kinds?: readonly ExecutionJobKind[];
}

export interface ExecutionWorkerHandle {
  readonly id: string;
  readonly name?: string;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

const ALL_JOB_KINDS: readonly ExecutionJobKind[] = [
  "workflow_run",
  "durable_boundary",
  "durable_pause_timeout",
  "batch_source",
  "batch_item",
  "batch_step",
  "batch_sink",
];

export class ExecutionJobDeferredError extends Error {
  constructor(readonly availableAt: Date) {
    super(`Execution job deferred until ${availableAt.toISOString()}`);
    this.name = "ExecutionJobDeferredError";
  }
}

interface WorkerGroup {
  controller: AbortController;
  done: Promise<void>;
}

export class ExecutionWorkerService {
  private readonly handlers = new Map<ExecutionJobKind, ExecutionJobHandler>();
  private readonly workers = new Map<string, WorkerGroup>();
  // Shared across loops so N concurrent loops still sweep once per interval.
  private lastRetentionSweepAt = 0;
  private exhaustedHandler?: (args: {
    job: ExecutionJob;
    error: string;
  }) => Promise<void>;

  constructor(
    private readonly jobs: ExecutionJobsService,
    private readonly retention?: RetentionService,
  ) {}

  registerHandler(args: {
    kind: ExecutionJobKind;
    handler: ExecutionJobHandler;
  }): void {
    this.handlers.set(args.kind, args.handler);
  }

  registerExhaustedHandler(
    handler: (args: { job: ExecutionJob; error: string }) => Promise<void>,
  ): void {
    this.exhaustedHandler = handler;
  }

  start(options: ExecutionWorkerOptions = {}): ExecutionWorkerHandle {
    const name = options.name;
    const id = `${name ?? "execution"}-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const concurrency = boundedInteger({
      value: options.concurrency ?? 1,
      name: "concurrency",
      minimum: 1,
      maximum: 32,
    });
    const claimLimit = boundedInteger({
      value: options.claimLimit ?? 1,
      name: "claimLimit",
      minimum: 1,
      maximum: 100,
    });
    const loops = Array.from({ length: concurrency }, (_, index) =>
      this.runLoop({
        workerId: `${id}:${index}`,
        controller,
        claimLimit,
        leaseSeconds: options.leaseSeconds ?? 60,
        pollIntervalMs: options.pollIntervalMs ?? 500,
        kinds: options.kinds ?? ALL_JOB_KINDS,
      }),
    );
    const done = Promise.all(loops)
      .then(() => undefined)
      .finally(() => this.workers.delete(id));
    this.workers.set(id, { controller, done });
    let stopped: Promise<void> | undefined;
    return {
      id,
      name,
      done,
      stop: () => {
        if (!stopped) {
          controller.abort();
          stopped = done;
        }
        return stopped;
      },
    };
  }

  async stopAll(): Promise<void> {
    const groups = [...this.workers.values()];
    for (const group of groups) group.controller.abort();
    await Promise.allSettled(groups.map((group) => group.done));
  }

  private async runLoop(args: {
    workerId: string;
    controller: AbortController;
    claimLimit: number;
    leaseSeconds: number;
    pollIntervalMs: number;
    kinds: readonly ExecutionJobKind[];
  }): Promise<void> {
    const { signal } = args.controller;
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce(args);
        consecutiveFailures = 0;
      } catch (error) {
        // The database is reachable only intermittently during a failover or
        // pool exhaustion. Letting the loop exit would silently retire this
        // concurrency slot for the lifetime of the process, so back off and
        // keep polling instead.
        consecutiveFailures += 1;
        this.reportLoopError({ workerId: args.workerId, error });
        await abortableDelay({
          milliseconds: Math.min(
            args.pollIntervalMs * 2 ** Math.min(consecutiveFailures, 6),
            30_000,
          ),
          signal,
        });
      }
    }
  }

  /**
   * Purge aged-out runs on a slow timer shared by every loop in the process.
   *
   * One bounded batch per interval: the sweep rides the poll loop rather than
   * owning a timer, so it inherits the loop's error handling and shutdown, and
   * it never competes with job execution for more than one statement at a time.
   * A large backlog drains over successive sweeps instead of in one long
   * transaction.
   */
  private async sweepRetention(): Promise<void> {
    const retention = this.retention;
    if (!retention?.isEnabled) return;
    const now = Date.now();
    if (now - this.lastRetentionSweepAt < retention.sweepIntervalMs) return;
    this.lastRetentionSweepAt = now;
    await retention.purgeExpiredRuns();
  }

  private reportLoopError(args: { workerId: string; error: unknown }): void {
    const message =
      args.error instanceof Error ? args.error.message : String(args.error);
    console.error(
      `[catamorphic] execution worker '${args.workerId}' poll failed: ${message}`,
    );
  }

  private async pollOnce(args: {
    workerId: string;
    controller: AbortController;
    claimLimit: number;
    leaseSeconds: number;
    pollIntervalMs: number;
    kinds: readonly ExecutionJobKind[];
  }): Promise<void> {
    const { signal } = args.controller;
    await this.sweepRetention();
    await this.jobs.requeueExpired({ limit: 100 });
    const unhandled = await this.jobs.listUnhandledExhausted({ limit: 100 });
    await Promise.allSettled(
      unhandled.map((job) =>
        this.handleExhausted({
          job,
          error: job.lastError ?? "Execution job attempts exhausted",
        }),
      ),
    );
    const claimed = await this.jobs.claim({
      workerId: args.workerId,
      kinds: args.kinds,
      limit: args.claimLimit,
      leaseSeconds: args.leaseSeconds,
    });
    if (claimed.length === 0) {
      await abortableDelay({ milliseconds: args.pollIntervalMs, signal });
      return;
    }
    for (const job of claimed) {
      if (signal.aborted) {
        await this.jobs.release({
          jobId: job.id,
          workerId: args.workerId,
          leaseToken: requireLeaseToken(job),
          leaseGeneration: job.leaseGeneration,
          availableAt: new Date(),
        });
        continue;
      }
      await this.processJob({
        job,
        workerId: args.workerId,
        leaseSeconds: args.leaseSeconds,
        signal,
      });
    }
  }

  private async processJob(args: {
    job: ExecutionJob;
    workerId: string;
    leaseSeconds: number;
    signal: AbortSignal;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "queue.process",
        attributes: executionJobAttributes(args),
      },
      async (span) => {
        const handler = this.handlers.get(args.job.kind);
        if (!handler) {
          const error = `No handler registered for '${args.job.kind}'`;
          const status = await this.jobs.fail({
            jobId: args.job.id,
            workerId: args.workerId,
            error,
            leaseToken: requireLeaseToken(args.job),
            leaseGeneration: args.job.leaseGeneration,
          });
          if (status === "failed") {
            await this.handleExhausted({ job: args.job, error });
          }
          return;
        }
        const jobController = new AbortController();
        const abortJob = () => jobController.abort();
        args.signal.addEventListener("abort", abortJob, { once: true });
        const heartbeat = setInterval(
          () => {
            void this.jobs
              .heartbeat({
                jobId: args.job.id,
                workerId: args.workerId,
                leaseToken: requireLeaseToken(args.job),
                leaseGeneration: args.job.leaseGeneration,
                leaseSeconds: args.leaseSeconds,
              })
              .then((owned) => {
                if (!owned) jobController.abort();
              })
              .catch(() => jobController.abort());
          },
          Math.max(1_000, Math.floor((args.leaseSeconds * 1_000) / 3)),
        );
        try {
          await handler({ job: args.job, signal: jobController.signal });
          if (jobController.signal.aborted) {
            await this.jobs.release({
              jobId: args.job.id,
              workerId: args.workerId,
              leaseToken: requireLeaseToken(args.job),
              leaseGeneration: args.job.leaseGeneration,
              availableAt: new Date(),
            });
            return;
          }
          const completed = await this.jobs.complete({
            jobId: args.job.id,
            workerId: args.workerId,
            leaseToken: requireLeaseToken(args.job),
            leaseGeneration: args.job.leaseGeneration,
          });
          span.setAttribute(
            "catamorphic.queue.job.outcome",
            completed ? "completed" : "lease_lost",
          );
        } catch (error) {
          if (jobController.signal.aborted) {
            await this.jobs.release({
              jobId: args.job.id,
              workerId: args.workerId,
              leaseToken: requireLeaseToken(args.job),
              leaseGeneration: args.job.leaseGeneration,
              availableAt: new Date(),
            });
            return;
          }
          if (error instanceof ExecutionJobDeferredError) {
            await this.jobs.release({
              jobId: args.job.id,
              workerId: args.workerId,
              leaseToken: requireLeaseToken(args.job),
              leaseGeneration: args.job.leaseGeneration,
              availableAt: error.availableAt,
            });
            return;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          const status = await this.jobs.fail({
            jobId: args.job.id,
            workerId: args.workerId,
            leaseToken: requireLeaseToken(args.job),
            leaseGeneration: args.job.leaseGeneration,
            error: message,
          });
          if (status === "failed") {
            await this.handleExhausted({ job: args.job, error: message });
          }
        } finally {
          clearInterval(heartbeat);
          args.signal.removeEventListener("abort", abortJob);
        }
      },
    ).catch(() => undefined);
  }

  private async handleExhausted(args: {
    job: ExecutionJob;
    error: string;
  }): Promise<void> {
    if (!this.exhaustedHandler) return;
    await this.exhaustedHandler(args);
    await this.jobs.markExhaustionHandled({ jobId: args.job.id });
  }
}

function boundedInteger(args: {
  value: number;
  name: string;
  minimum: number;
  maximum: number;
}): number {
  if (
    !Number.isInteger(args.value) ||
    args.value < args.minimum ||
    args.value > args.maximum
  ) {
    throw new Error(
      `Execution worker ${args.name} must be an integer from ${args.minimum} to ${args.maximum}`,
    );
  }
  return args.value;
}

function executionJobAttributes(args: {
  job: ExecutionJob;
  workerId: string;
}): SpanAttributes {
  return {
    "catamorphic.tenant.id": args.job.tenantId,
    "catamorphic.queue.worker_id": args.workerId,
    "catamorphic.queue.job.id": args.job.id,
    "catamorphic.queue.job.kind": args.job.kind,
    "catamorphic.queue.job.attempt": args.job.attempt,
    "catamorphic.run.id": args.job.workflowRunId,
  };
}

function requireLeaseToken(job: ExecutionJob): string {
  if (!job.leaseToken)
    throw new Error(`Execution job '${job.id}' has no lease token`);
  return job.leaseToken;
}

async function abortableDelay(args: {
  milliseconds: number;
  signal: AbortSignal;
}): Promise<void> {
  if (args.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      args.signal.removeEventListener("abort", onAbort);
      resolve();
    }, args.milliseconds);
    args.signal.addEventListener("abort", onAbort, { once: true });
  });
}
