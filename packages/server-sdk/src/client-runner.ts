import {
  type ClientRunnerOperation,
  ClientRunnerOperationSchema,
} from "@catamorphic/core";
import type { SandboxProvider } from "@catamorphic/sandbox";

export interface ClientRunnerTransport {
  renew(): Promise<void>;
  poll(): Promise<{ id: string; operation: unknown } | null>;
  complete(args: {
    jobId: string;
    response?: unknown;
    error?: string;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Runs only operations the remote authority admitted for this runner. A
 * member's desktop runner stops its sandboxes when the connection ends; a
 * remote worker (ADR 0164) passes `sandboxes` to keep ownership across
 * control-plane reconnects and `keepSandboxes` so relocation stays possible.
 */
export function startClientRunner(args: {
  provider: SandboxProvider;
  transport: ClientRunnerTransport;
  onError?: (error: unknown) => void;
  sandboxes?: Set<string>;
  keepSandboxes?: boolean;
  /** Most sandboxes this runner may hold at once. */
  maxSandboxes?: number;
  /** Delay between empty polls; a long-polling transport can pass 0. */
  idleDelayMs?: number;
  /** Operations run at once; 4 by default. */
  concurrency?: number;
}) {
  let stopped = false;
  let renewing = false;
  const ownedSandboxes = args.sandboxes ?? new Set<string>();
  const stopSandboxes = async () => {
    if (args.keepSandboxes) return;
    await Promise.allSettled(
      [...ownedSandboxes].map((id) => args.provider.stopSandbox(id)),
    );
  };
  const heartbeat = setInterval(() => {
    if (renewing || stopped) return;
    renewing = true;
    void args.transport
      .renew()
      .catch(async (error) => {
        stopped = true;
        await stopSandboxes();
        args.onError?.(error);
      })
      .finally(() => {
        renewing = false;
      });
  }, 10000);
  heartbeat.unref();
  let creating = 0;
  /** Run one admitted operation and deliver its receipt. */
  const run = async (job: { id: string; operation: unknown }) => {
    let receipt: { jobId: string; response?: unknown; error?: string };
    let reserved = false;
    try {
      const operation = ClientRunnerOperationSchema.parse(job.operation);
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
    // Retry only the idempotent receipt, never the operation.
    await args.transport
      .complete(receipt)
      .catch(() => args.transport.complete(receipt))
      .catch(async (error: unknown) => {
        if (receipt.error !== undefined) throw error;
        // A result the control plane refuses (too large to accept, or not
        // storable) fails that operation, not this runner.
        await args.transport.complete({
          jobId: job.id,
          error: receiptError(
            `The result could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          ),
        });
      });
  };
  const concurrency = Math.max(1, args.concurrency ?? 4);
  const running = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const work = (async () => {
    while (!stopped) {
      // A long read (a process's output, up to 20 seconds) or command
      // holds one slot; writes and other operations take the others.
      if (running.size >= concurrency) {
        await Promise.race(running);
        continue;
      }
      const job = await args.transport.poll();
      if (stopped) break;
      if (!job) {
        await new Promise((resolve) =>
          setTimeout(resolve, args.idleDelayMs ?? 200),
        );
        continue;
      }
      const task: Promise<void> = run(job)
        .catch((error: unknown) => {
          failure ??= { error };
          stopped = true;
        })
        .finally(() => running.delete(task));
      running.add(task);
    }
    await Promise.allSettled(running);
    if (failure) throw failure.error;
  })()
    .catch((error) => {
      stopped = true;
      args.onError?.(error);
    })
    .finally(async () => {
      clearInterval(heartbeat);
      await stopSandboxes();
    });
  return {
    stop: async () => {
      stopped = true;
      clearInterval(heartbeat);
      await stopSandboxes();
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
  operation: ClientRunnerOperation;
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
