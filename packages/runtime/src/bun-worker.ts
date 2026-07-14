import { Worker } from "node:worker_threads";
import type {
  ResolvedRuntimeInvocation,
  RuntimeInvocationWorker,
  RuntimeInvocationWorkerFactory,
  RuntimeWorkerEvent,
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
  private worker?: Worker;
  private terminated = false;

  constructor(private readonly options: BunInvocationWorkerOptions) {}

  execute(args: {
    signal: AbortSignal;
    onEvent: (event: RuntimeWorkerEvent) => void;
  }): Promise<RuntimeTerminalResult> {
    if (this.worker) {
      return Promise.reject(
        new Error("An invocation worker can only execute once"),
      );
    }
    if (args.signal.aborted) {
      return Promise.reject(abortReason(args.signal));
    }

    const worker = new Worker(this.options.workerEntryUrl, {
      workerData: this.options.invocation,
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
      name: `catamorphic-${this.options.invocation.invocationId}`,
    });
    this.worker = worker;

    return new Promise<RuntimeTerminalResult>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        void this.terminate().finally(() => reject(abortReason(args.signal)));
      };
      args.signal.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (message: unknown) => {
        if (isWorkerEventMessage(message)) {
          args.onEvent(message.event);
          return;
        }
        if (isWorkerTerminalMessage(message)) {
          if (settled) return;
          settled = true;
          args.signal.removeEventListener("abort", onAbort);
          resolve(message.terminal);
        }
      });
      worker.on("error", (error) => {
        if (settled) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      worker.on("exit", (code) => {
        if (settled || this.terminated) return;
        settled = true;
        args.signal.removeEventListener("abort", onAbort);
        reject(
          new Error(
            `Invocation worker exited with code ${code} before reporting a result`,
          ),
        );
      });
    });
  }

  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    if (this.worker) await this.worker.terminate().then(() => {});
  }
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
    ((terminal.status === "failed" ||
      terminal.status === "canceled" ||
      terminal.status === "timed_out") &&
      typeof terminal.error === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
