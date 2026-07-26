import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type ResolvedRuntimeInvocation,
  RuntimeInvocationInfrastructureError,
  type RuntimeInvocationWorker,
  type RuntimeInvocationWorkerFactory,
  type RuntimeWorkerEvent,
} from "./supervisor-dispatcher.js";
import type { RuntimeTerminalResult } from "./supervisor-protocol.js";
import { toProtocolJson } from "./supervisor-protocol.js";

export interface BunWorkerFactoryOptions {
  workerEntryUrl?: URL;
}

export class BunWorkerFactory implements RuntimeInvocationWorkerFactory {
  private readonly workerEntryUrl: URL;

  constructor(options: BunWorkerFactoryOptions = {}) {
    this.workerEntryUrl =
      options.workerEntryUrl ??
      new URL("./supervisor-worker.js", import.meta.url);
  }

  create(args: {
    invocation: ResolvedRuntimeInvocation;
  }): RuntimeInvocationWorker {
    return new BunInvocationWorker({
      invocation: args.invocation,
      workerEntryUrl: this.workerEntryUrl,
    });
  }
}

interface BunInvocationWorkerOptions {
  invocation: ResolvedRuntimeInvocation;
  workerEntryUrl: URL;
}

class BunInvocationWorker implements RuntimeInvocationWorker {
  private child?: ChildProcess;
  private started = false;
  private terminated = false;
  private termination?: Promise<void>;
  private abortPending = false;

  constructor(private readonly options: BunInvocationWorkerOptions) {}

  execute(args: {
    signal: AbortSignal;
    onEvent: (event: RuntimeWorkerEvent) => void;
  }): Promise<RuntimeTerminalResult> {
    if (this.started) {
      return Promise.reject(
        new Error("An invocation worker can only execute once"),
      );
    }
    if (args.signal.aborted) {
      return Promise.reject(abortReason(args.signal));
    }
    this.started = true;

    let child: ChildProcess;
    try {
      child = fork(fileURLToPath(this.options.workerEntryUrl), [], {
        cwd: this.options.invocation.workingDirectory,
        env: {
          ...process.env,
          ...this.options.invocation.env,
          CATAMORPHIC_INVOCATION_ID: this.options.invocation.invocationId,
          CATAMORPHIC_INVOCATION_CWD: this.options.invocation.workingDirectory,
          CATAMORPHIC_DEPLOYMENT_ARTIFACT_ID:
            this.options.invocation.deploymentArtifactId,
          CATAMORPHIC_RUN_ID: this.options.invocation.invocationId,
          CATAMORPHIC_WORKFLOW_NAME: this.options.invocation.target.exportName,
          CATAMORPHIC_WORKFLOW_FILE: this.options.invocation.target.modulePath,
          CATAMORPHIC_TRIGGER_DATA: JSON.stringify(
            toProtocolJson(this.options.invocation.input),
          ),
        },
        serialization: "json",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      return Promise.reject(this.infrastructureError(error));
    }
    this.child = child;

    return new Promise<RuntimeTerminalResult>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        this.abortPending = true;
        if (child.connected) {
          child.send({
            type: "abort",
            reason:
              args.signal.reason instanceof Error
                ? args.signal.reason.message
                : "Invocation was aborted",
          });
        }
        void this.terminate().finally(() => reject(abortReason(args.signal)));
      };
      args.signal.addEventListener("abort", onAbort, { once: true });
      child.on("message", (message: unknown) => {
        if (isWorkerEventMessage(message)) {
          args.onEvent(message.event);
          return;
        }
        if (isWorkerTerminalMessage(message)) {
          if (settled) return;
          settled = true;
          args.signal.removeEventListener("abort", onAbort);
          resolve(message.terminal);
          return;
        }
        if (isWorkerInfrastructureErrorMessage(message)) {
          if (settled) return;
          settled = true;
          args.signal.removeEventListener("abort", onAbort);
          reject(this.infrastructureError(new Error(message.error)));
        }
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        reject(this.infrastructureError(error));
      });
      child.on("disconnect", () => {
        if (settled) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        reject(
          this.infrastructureError(
            new Error(
              "Invocation child disconnected before reporting a result",
            ),
          ),
        );
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        reject(
          this.infrastructureError(
            new Error(
              `Invocation child exited with code ${code ?? "null"}${
                signal ? ` and signal ${signal}` : ""
              } before reporting a result`,
            ),
          ),
        );
      });
      child.send(
        { type: "init", invocation: this.options.invocation },
        (error) => {
          if (!error || settled) return;
          settled = true;
          args.signal.removeEventListener("abort", onAbort);
          reject(this.infrastructureError(error));
        },
      );
    });
  }

  async terminate(): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = this.terminateChild();
    return this.termination;
  }

  private async terminateChild(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    if (this.abortPending) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await waitForExit({ child, timeoutMs: 1_000 });
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit({ child, timeoutMs: 1_000 });
    }
  }

  private infrastructureError(
    cause: unknown,
  ): RuntimeInvocationInfrastructureError {
    return new RuntimeInvocationInfrastructureError({
      invocationId: this.options.invocation.invocationId,
      cause,
    });
  }
}

function waitForExit(args: {
  child: ChildProcess;
  timeoutMs: number;
}): Promise<void> {
  if (args.child.exitCode !== null || args.child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      args.child.off("exit", onExit);
      resolve();
    }, args.timeoutMs);
    args.child.once("exit", onExit);
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Invocation was aborted");
}

function isWorkerEventMessage(
  value: unknown,
): value is { type: "event"; event: RuntimeWorkerEvent } {
  if (!isRecord(value) || value.type !== "event" || !isRecord(value.event)) {
    return false;
  }
  const event = value.event;
  return (
    (event.type === "step_started" &&
      typeof event.nodeId === "string" &&
      Number.isInteger(event.occurrence) &&
      typeof event.name === "string") ||
    (event.type === "step_completed" &&
      typeof event.nodeId === "string" &&
      Number.isInteger(event.occurrence) &&
      typeof event.name === "string") ||
    (event.type === "step_failed" &&
      typeof event.nodeId === "string" &&
      Number.isInteger(event.occurrence) &&
      typeof event.name === "string" &&
      typeof event.error === "string")
  );
}

function isWorkerTerminalMessage(
  value: unknown,
): value is { type: "terminal"; terminal: RuntimeTerminalResult } {
  if (!isRecord(value) || value.type !== "terminal") return false;
  const terminal = value.terminal;
  if (!isRecord(terminal) || !Array.isArray(terminal.steps)) return false;
  return (
    terminal.status === "completed" ||
    (terminal.status === "suspended" && isRecord(terminal.suspension)) ||
    (terminal.status === "skipped" && typeof terminal.reason === "string") ||
    (terminal.status === "rate_limited" &&
      typeof terminal.retryAfterMs === "number" &&
      typeof terminal.error === "string") ||
    ((terminal.status === "failed" ||
      terminal.status === "canceled" ||
      terminal.status === "timed_out") &&
      typeof terminal.error === "string")
  );
}

function isWorkerInfrastructureErrorMessage(
  value: unknown,
): value is { type: "infrastructure_error"; error: string } {
  return (
    isRecord(value) &&
    value.type === "infrastructure_error" &&
    typeof value.error === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
