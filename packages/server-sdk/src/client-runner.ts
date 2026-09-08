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

/** Runs only operations admitted by the remote authority for this member. */
export function startClientRunner(args: {
  provider: SandboxProvider;
  transport: ClientRunnerTransport;
  onError?: (error: unknown) => void;
}) {
  let stopped = false;
  let renewing = false;
  const ownedSandboxes = new Set<string>();
  const stopSandboxes = async () => {
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
  const work = (async () => {
    while (!stopped) {
      const job = await args.transport.poll();
      if (stopped) break;
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      let receipt: { jobId: string; response?: unknown; error?: string };
      try {
        const operation = ClientRunnerOperationSchema.parse(job.operation);
        // A server may only address sandboxes created for this connection.
        if (
          "sandboxId" in operation &&
          !ownedSandboxes.has(operation.sandboxId)
        )
          throw new Error("Sandbox does not belong to this runner connection");
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
          error:
            error instanceof Error ? error.message : "Client operation failed",
        };
      }
      // Retry only the idempotent receipt, never the operation.
      await args.transport.complete(receipt).catch(async () => {
        await args.transport.complete(receipt);
      });
    }
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
  }
}
