import { type RemoteOperation, RemoteOperationSchema } from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";

/**
 * The control plane ended this runner's session: its lease moved on, its
 * access was revoked, or it was refused. Retrying the call cannot help; the
 * runner stops and its owner connects again or gives up.
 */
export class RunnerSessionEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerSessionEndedError";
  }
}

/**
 * The control plane refused one receipt: the operation already settled or
 * its controller stopped waiting. The runner drops that receipt.
 */
export class ReceiptRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptRefusedError";
  }
}

/**
 * The control plane cannot take this result (too large to accept). The
 * runner reports the operation as failed instead.
 */
export class ResultRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultRejectedError";
  }
}

/**
 * How a runner reaches the control plane (ADR 0187). A transport throws
 * {@link RunnerSessionEndedError}, {@link ReceiptRefusedError}, or
 * {@link ResultRejectedError} for the control plane's definite answers.
 * Anything else (a network error, a timeout, a 5xx from a load balancer or
 * a restarting instance) is transient: the runner retries the same call.
 */
export interface ClientRunnerTransport {
  renew(): Promise<void>;
  /**
   * Take the next operation, long-polling. A retry repeats `pollId`, and
   * the control plane answers it with the operation that poll took, so an
   * operation is never lost with a response.
   */
  poll(args: {
    pollId: string;
    signal: AbortSignal;
  }): Promise<{ id: string; operation: unknown } | null>;
  /** Idempotent: a receipt retried after its response was lost succeeds. */
  complete(receipt: {
    jobId: string;
    response?: unknown;
    error?: string;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

/** Transient failures retry with jittered backoff up to this delay. */
const MAX_RETRY_DELAY_MS = 5_000;

function definite(error: unknown): boolean {
  return (
    error instanceof RunnerSessionEndedError ||
    error instanceof ReceiptRefusedError ||
    error instanceof ResultRejectedError
  );
}

/** The runner stopped while a call waited to be retried. */
class RunnerStoppedError extends Error {}

/**
 * Runs only operations the remote authority admitted for this runner. A
 * member's desktop runner stops its sandboxes when the connection ends; a
 * remote worker (ADR 0164) passes `sandboxes` to keep ownership across
 * control-plane reconnects and `keepSandboxes` so relocation stays possible.
 *
 * A session ends only on the control plane's definite answer. Transient
 * failures retry the same call in place while the lease lasts, so a load
 * balancer's 502 or an instance restarting never costs running work its
 * executor (ADR 0187). An operation runs at most once; only its receipt is
 * ever retried.
 */
export function startClientRunner(args: {
  provider: SandboxProvider;
  transport: ClientRunnerTransport;
  /** The session ended: {@link RunnerSessionEndedError} or a fault. */
  onError?: (error: unknown) => void;
  /** A transient failure the runner is riding out. */
  onRetry?: (error: unknown) => void;
  sandboxes?: Set<string>;
  keepSandboxes?: boolean;
  /** Most sandboxes this runner may hold at once. */
  maxSandboxes?: number;
  /** Operations run at once; 4 by default. */
  concurrency?: number;
}) {
  const stopping = new AbortController();
  const stopped = () => stopping.signal.aborted;
  let ended: { error: unknown } | undefined;
  const end = (error: unknown) => {
    if (ended || stopped()) return;
    ended = { error };
    stopping.abort();
  };
  const ownedSandboxes = args.sandboxes ?? new Set<string>();
  const stopSandboxes = async () => {
    if (args.keepSandboxes) return;
    await Promise.allSettled(
      [...ownedSandboxes].map((id) => args.provider.stopSandbox(id)),
    );
  };
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        stopping.signal.removeEventListener("abort", done);
        resolve();
      }
      stopping.signal.addEventListener("abort", done, { once: true });
    });
  /** Retry one idempotent call until it gets a definite answer. */
  const retrying = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (stopped()) throw new RunnerStoppedError();
      try {
        return await call();
      } catch (error) {
        if (definite(error)) throw error;
        if (stopped()) throw new RunnerStoppedError();
        args.onRetry?.(error);
        const ceiling = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt);
        await pause(ceiling / 2 + Math.random() * (ceiling / 2));
      }
    }
  };
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || stopped()) return;
    renewing = true;
    // A transient failure waits for the next beat; polls renew too.
    void args.transport
      .renew()
      .catch((error: unknown) => {
        if (error instanceof RunnerSessionEndedError) end(error);
        else args.onRetry?.(error);
      })
      .finally(() => {
        renewing = false;
      });
  }, 10000);
  heartbeat.unref();
  let creating = 0;
  /** Deliver a receipt; a refused one is dropped, a rejected result fails. */
  const deliver = async (receipt: {
    jobId: string;
    response?: unknown;
    error?: string;
  }): Promise<void> => {
    try {
      await retrying(() => args.transport.complete(receipt));
    } catch (error) {
      if (error instanceof ReceiptRefusedError) return;
      if (error instanceof ResultRejectedError && receipt.error === undefined) {
        await deliver({
          jobId: receipt.jobId,
          error: receiptError(
            `The result could not be delivered: ${error.message}`,
          ),
        });
        return;
      }
      throw error;
    }
  };
  /** Run one admitted operation and deliver its receipt. */
  const run = async (job: { id: string; operation: unknown }) => {
    let receipt: { jobId: string; response?: unknown; error?: string };
    let reserved = false;
    try {
      const operation = RemoteOperationSchema.parse(job.operation);
      // A server may only address sandboxes created for this connection.
      if ("sandboxId" in operation && !ownedSandboxes.has(operation.sandboxId))
        throw new Error("Sandbox does not belong to this runner connection");
      if (operation.kind === "create") {
        if (
          args.maxSandboxes !== undefined &&
          ownedSandboxes.size + creating >= args.maxSandboxes
        )
          throw new Error("This worker has no free workspace");
        creating++;
        reserved = true;
      }
      const response = await executeClientOperation({
        provider: args.provider,
        operation,
      });
      if (operation.kind === "create") {
        const handle = response;
        if (
          handle &&
          typeof handle === "object" &&
          "providerId" in handle &&
          typeof handle.providerId === "string"
        )
          ownedSandboxes.add(handle.providerId);
      }
      if (operation.kind === "destroy")
        ownedSandboxes.delete(operation.sandboxId);
      receipt = { jobId: job.id, response: response ?? null };
    } catch (error) {
      receipt = {
        jobId: job.id,
        error: receiptError(
          error instanceof Error ? error.message : "Client operation failed",
        ),
      };
    } finally {
      if (reserved) creating--;
    }
    await deliver(receipt);
  };
  const concurrency = Math.max(1, args.concurrency ?? 4);
  const running = new Set<Promise<void>>();
  const work = (async () => {
    while (!stopped()) {
      // A long read (a process's output, up to 20 seconds) or command
      // holds one slot; writes and other operations take the others.
      if (running.size >= concurrency) {
        await Promise.race(running);
        continue;
      }
      const pollId = crypto.randomUUID();
      const job = await retrying(() =>
        args.transport.poll({ pollId, signal: stopping.signal }),
      );
      if (!job) continue;
      const task: Promise<void> = run(job)
        .catch((error: unknown) => {
          if (!(error instanceof RunnerStoppedError)) end(error);
        })
        .finally(() => running.delete(task));
      running.add(task);
    }
  })()
    .catch((error: unknown) => {
      if (!(error instanceof RunnerStoppedError)) end(error);
    })
    .finally(async () => {
      await Promise.allSettled(running);
      clearInterval(heartbeat);
      await stopSandboxes();
      if (ended) args.onError?.(ended.error);
    });
  return {
    stop: async () => {
      stopping.abort();
      await work;
      await args.transport.disconnect().catch(() => {});
    },
  };
}

async function executeClientOperation({
  provider,
  operation,
}: {
  provider: SandboxProvider;
  operation: RemoteOperation;
}): Promise<unknown> {
  switch (operation.kind) {
    case "create":
      return provider.createSandbox(operation.options);
    case "start":
      return provider.startSandbox(operation.sandboxId);
    case "stop":
      return provider.stopSandbox(operation.sandboxId);
    case "destroy":
      return provider.destroySandbox(operation.sandboxId);
    case "status":
      return provider.getSandboxStatus(operation.sandboxId);
    case "execute":
      return provider.executeCommand(
        operation.sandboxId,
        operation.command,
        operation.options,
      );
    case "upload":
      return provider.uploadFiles(
        operation.sandboxId,
        operation.files,
        operation.basePath,
      );
    case "download":
      return provider.downloadFile(operation.sandboxId, operation.path);
    case "clone":
      return provider.gitClone(
        operation.sandboxId,
        operation.url,
        operation.path,
        operation.options,
      );
    case "checkout":
      return provider.gitCheckout(
        operation.sandboxId,
        operation.path,
        operation.ref,
      );
    case "process.start": {
      const { kind: _, ...args } = operation;
      return processesOf(provider).startProcess(args);
    }
    case "process.read": {
      const { kind: _, ...args } = operation;
      return processesOf(provider).readProcessOutput(args);
    }
    case "process.signal": {
      const { kind: _, ...args } = operation;
      return processesOf(provider).signalProcess(args);
    }
    case "process.write": {
      const { kind: _, ...args } = operation;
      await processesOf(provider).writeProcessInput(args);
      return null;
    }
    case "process.list":
      return processesOf(provider).listProcesses({
        sandboxId: operation.sandboxId,
      });
  }
}

/** Receipt routes cap an error's length; its start says what went wrong. */
const RECEIPT_ERROR_MAX = 4000;

function receiptError(message: string): string {
  return message.length > RECEIPT_ERROR_MAX
    ? `${message.slice(0, RECEIPT_ERROR_MAX - 1)}…`
    : message;
}

function processesOf(provider: SandboxProvider) {
  if (!provider.processes)
    throw new Error(
      "This machine's sandbox provider cannot run background processes",
    );
  return provider.processes;
}
