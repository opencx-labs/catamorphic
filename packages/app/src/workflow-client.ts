import type { RunHandle, TypedRunSnapshot } from "./contract.js";
import { AppCallError, type RunSnapshot } from "./protocol.js";

export interface WorkflowRequest {
  workflow: string;
  input?: unknown;
}

/** One call/start/run contract for app guests and other authorized host surfaces. */
export interface WorkflowClient {
  call<Output = unknown>(input: WorkflowRequest): Promise<Output>;
  start<Output = unknown>(input: WorkflowRequest): Promise<RunHandle<Output>>;
  run<Output = unknown>(input: { runId: string }): RunHandle<Output>;
}

export interface WorkflowClientTransport {
  call(input: WorkflowRequest): Promise<unknown>;
  start(input: WorkflowRequest): Promise<{ runId: string }>;
  poll(input: { runId: string; signal?: AbortSignal }): Promise<RunSnapshot>;
}

/** Each transport enforces its own live identity and workflow/run authorization. */
export function createWorkflowClient(
  transport: WorkflowClientTransport,
  defaults?: { signal?: AbortSignal },
): WorkflowClient {
  const run = <Output = unknown>({
    runId,
  }: {
    runId: string;
  }): RunHandle<Output> => {
    const poll = async (
      signal = defaults?.signal,
    ): Promise<TypedRunSnapshot<Output>> => {
      const value = await transport.poll({ runId, signal });
      return { ...value, output: (value.output ?? null) as Output | null };
    };
    return {
      runId,
      poll,
      async result(options) {
        const signal = options?.signal ?? defaults?.signal;
        const interval = options?.pollIntervalMs ?? 750;
        if (
          !Number.isFinite(interval) ||
          interval < 1 ||
          interval > 2_147_483_647
        )
          throw new Error("pollIntervalMs must be a positive timer duration");
        for (;;) {
          signal?.throwIfAborted();
          const snapshot = await poll(signal);
          if (snapshot.status === "completed") return snapshot.output as Output;
          if (snapshot.status === "failed" || snapshot.status === "canceled")
            throw new AppCallError(
              "workflow_failed",
              snapshot.error ?? `Run ${runId} ${snapshot.status}`,
            );
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", abort);
              reject(signal?.reason);
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              resolve();
            }, interval);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
      },
    };
  };
  return {
    call: async <Output = unknown>(input: WorkflowRequest) =>
      (await transport.call(input)) as Output,
    start: async <Output = unknown>(input: WorkflowRequest) =>
      run<Output>(await transport.start(input)),
    run,
  };
}
