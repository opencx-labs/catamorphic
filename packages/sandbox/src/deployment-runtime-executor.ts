import { currentTraceContext } from "@catamorphic/otel";
import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import { type ExecuteRunOpts, RunExecutorImpl } from "./run-executor.js";
import type {
  DeploymentRuntime,
  RunExecutor,
  RunResult,
  RuntimeInvocationEventSink,
  RuntimeInvocationReceipt,
  SandboxProvider,
  StepEntry,
} from "./types.js";
import { RuntimeInfrastructureError } from "./types.js";

export interface DeploymentRuntimeExecutorOptions {
  provider: SandboxProvider;
  runtime:
    | DeploymentRuntime
    | ((args: {
        run: ExecuteRunOpts;
      }) => DeploymentRuntime | Promise<DeploymentRuntime>);
  fallback?: RunExecutor;
  timeoutSeconds?: number;
  invocationId?: string;
  invocationAttempt?: number;
  replay?: Record<string, unknown>;
  eventSink?: RuntimeInvocationEventSink;
  signal?: AbortSignal;
  now?: () => Date;
}

export class DeploymentRuntimeExecutorAdapter implements RunExecutor {
  private readonly fallback: RunExecutor;
  private readonly timeoutSeconds: number;
  private readonly now: () => Date;

  constructor(private readonly options: DeploymentRuntimeExecutorOptions) {
    this.timeoutSeconds = options.timeoutSeconds ?? 300;
    this.now = options.now ?? (() => new Date());
    this.fallback =
      options.fallback ??
      new RunExecutorImpl({
        provider: options.provider,
        timeoutSeconds: this.timeoutSeconds,
      });
  }

  async executeRun(run: ExecuteRunOpts): Promise<RunResult> {
    const runtimeProvider = this.options.provider.deploymentRuntime;
    if (!runtimeProvider) return this.fallback.executeRun(run);

    const runtime =
      typeof this.options.runtime === "function"
        ? await this.options.runtime({ run })
        : this.options.runtime;
    let receipt: RuntimeInvocationReceipt;
    try {
      receipt = await runtimeProvider.invoke({
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        runtimeId: runtime.runtimeId,
        invocationId: this.options.invocationId ?? run.runId,
        deploymentArtifactId: runtime.deploymentArtifactId,
        artifactDigest: runtime.artifactDigest,
        transformVersion: runtime.transformVersion,
        runtimeVersion: runtime.runtimeVersion,
        kind: "workflow",
        target: {
          modulePath: run.workflowFile,
          exportName: run.workflowName,
        },
        input: run.triggerData,
        attempt: this.options.invocationAttempt ?? 1,
        deadlineAt: new Date(
          this.now().getTime() + this.timeoutSeconds * 1_000,
        ).toISOString(),
        replay: this.options.replay,
        env: run.secrets,
        eventSink: this.options.eventSink,
        signal: this.options.signal,
        traceContext: currentTraceContext(),
      });
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      if (error instanceof RuntimeInfrastructureError) throw error;
      throw new RuntimeInfrastructureError({
        operation: `invocation '${this.options.invocationId ?? run.runId}' handoff`,
        cause: error,
      });
    }
    return receiptToRunResult(receipt);
  }
}

function receiptToRunResult(receipt: RuntimeInvocationReceipt): RunResult {
  const steps: StepEntry[] = receipt.terminal.steps.map((step) => ({
    nodeId: step.nodeId,
    occurrence: step.occurrence,
    name: step.name,
    status: step.status,
    attempt: step.attempt,
    input: step.input,
    output: step.output,
    error: step.error,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  }));
  if (receipt.terminal.status === "completed") {
    return {
      status: "completed",
      result: receipt.terminal.result,
      steps,
    };
  }
  if (receipt.terminal.status === "suspended") {
    return {
      status: "failed",
      error: `Regular workflow suspended at batch step '${receipt.terminal.suspension.name}'`,
      steps,
    };
  }
  if (receipt.terminal.status === "skipped") {
    return {
      status: "failed",
      error: `Regular workflow attempted to skip a batch item: ${receipt.terminal.reason}`,
      steps,
    };
  }
  return {
    status: "failed",
    error: receipt.terminal.error,
    steps,
  };
}
