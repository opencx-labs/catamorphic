import { getTracer, type SpanAttributes, withSpan } from "@catamorphic/otel";
import type {
  ExecutionJob,
  ExecutionJobKind,
  ExecutionJobsService,
} from "./execution-jobs-service.js";

const tracer = getTracer("@catamorphic/core");

export type ExecutionJobHandler = (args: {
  job: ExecutionJob;
  signal: AbortSignal;
}) => Promise<void>;

export interface ExecutionWorkerOptions {
  workerId?: string;
  concurrency?: number;
  claimLimit?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  kinds?: readonly ExecutionJobKind[];
}

const ALL_JOB_KINDS: readonly ExecutionJobKind[] = [
  "workflow_run",
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

export class ExecutionWorkerService {
  private readonly handlers = new Map<ExecutionJobKind, ExecutionJobHandler>();
  private readonly workers = new Map<string, AbortController>();

  constructor(private readonly jobs: ExecutionJobsService) {}

  registerHandler(args: {
    kind: ExecutionJobKind;
    handler: ExecutionJobHandler;
  }): void {
    this.handlers.set(args.kind, args.handler);
  }

  start(options: ExecutionWorkerOptions = {}): string {
    const workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
    if (this.workers.has(workerId)) {
      throw new Error(`Execution worker '${workerId}' is already running`);
    }

    const controller = new AbortController();
    this.workers.set(workerId, controller);
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, 32));
    const loops = Array.from({ length: concurrency }, (_, index) =>
      this.runLoop({
        workerId: `${workerId}:${index}`,
        controller,
        claimLimit: options.claimLimit ?? 1,
        leaseSeconds: options.leaseSeconds ?? 60,
        pollIntervalMs: options.pollIntervalMs ?? 500,
        kinds: options.kinds ?? ALL_JOB_KINDS,
      }),
    );
    void Promise.allSettled(loops).finally(() => {
      if (this.workers.get(workerId) === controller) {
        this.workers.delete(workerId);
      }
    });
    return workerId;
  }

  stop(args: { workerId: string }): boolean {
    const controller = this.workers.get(args.workerId);
    if (!controller) return false;
    controller.abort();
    this.workers.delete(args.workerId);
    return true;
  }

  stopAll(): void {
    for (const controller of this.workers.values()) {
      controller.abort();
    }
    this.workers.clear();
  }

  isRunning(args: { workerId: string }): boolean {
    return this.workers.has(args.workerId);
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
    while (!signal.aborted) {
      await this.jobs.requeueExpired({ limit: 100 });
      const claimed = await this.jobs.claim({
        workerId: args.workerId,
        kinds: args.kinds,
        limit: args.claimLimit,
        leaseSeconds: args.leaseSeconds,
      });
      if (claimed.length === 0) {
        await abortableDelay({
          milliseconds: args.pollIntervalMs,
          signal,
        });
        continue;
      }

      for (const job of claimed) {
        if (signal.aborted) return;
        await this.processJob({
          job,
          workerId: args.workerId,
          leaseSeconds: args.leaseSeconds,
          signal,
        });
      }
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
          span.setAttribute("catamorphic.queue.job.outcome", "unhandled");
          await this.jobs.fail({
            jobId: args.job.id,
            workerId: args.workerId,
            error: `No handler registered for '${args.job.kind}'`,
          });
          return;
        }

        const heartbeat = setInterval(
          () => {
            void this.jobs.heartbeat({
              jobId: args.job.id,
              workerId: args.workerId,
              leaseSeconds: args.leaseSeconds,
            });
          },
          Math.max(1_000, Math.floor((args.leaseSeconds * 1_000) / 3)),
        );

        try {
          await handler({ job: args.job, signal: args.signal });
          await this.jobs.complete({
            jobId: args.job.id,
            workerId: args.workerId,
          });
          span.setAttribute("catamorphic.queue.job.outcome", "completed");
        } catch (error) {
          if (error instanceof ExecutionJobDeferredError) {
            await this.jobs.release({
              jobId: args.job.id,
              workerId: args.workerId,
              availableAt: error.availableAt,
            });
            span.setAttribute("catamorphic.queue.job.outcome", "deferred");
            return;
          }
          await this.jobs.fail({
            jobId: args.job.id,
            workerId: args.workerId,
            error: error instanceof Error ? error.message : String(error),
          });
          span.setAttribute("catamorphic.queue.job.outcome", "failed");
          throw error;
        } finally {
          clearInterval(heartbeat);
        }
      },
    ).catch(() => undefined);
  }
}

function executionJobAttributes(args: {
  job: ExecutionJob;
  workerId: string;
}): SpanAttributes {
  const payload = jsonRecord(args.job.payload);
  const batchRunId = stringValue(payload?.batchRunId);
  const itemId = stringValue(payload?.itemId);
  const invocationId = stringValue(payload?.invocationId);
  const chunkId = stringValue(payload?.chunkId);
  return {
    "catamorphic.tenant.id": args.job.tenantId,
    "catamorphic.queue.worker_id": args.workerId,
    "catamorphic.queue.job.id": args.job.id,
    "catamorphic.queue.job.kind": args.job.kind,
    "catamorphic.queue.job.attempt": args.job.attempt,
    "catamorphic.queue.wait_ms": Math.max(
      0,
      Date.now() - new Date(args.job.availableAt).getTime(),
    ),
    ...(batchRunId ? { "catamorphic.batch_run.id": batchRunId } : {}),
    ...(itemId ? { "catamorphic.item.id": itemId } : {}),
    ...(invocationId ? { "catamorphic.invocation.id": invocationId } : {}),
    ...(chunkId ? { "catamorphic.sink.chunk.id": chunkId } : {}),
  };
}

function jsonRecord(
  value: ExecutionJob["payload"],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

async function abortableDelay(args: {
  milliseconds: number;
  signal: AbortSignal;
}): Promise<void> {
  if (args.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, args.milliseconds);
    args.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
