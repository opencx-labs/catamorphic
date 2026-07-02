import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  CreateSandboxOpts,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "./types.js";

const tracer = getTracer("@catamorphic/sandbox");

type HydratableProvider = SandboxProvider & {
  hydrateWorkspace: (sandboxId: string, tar: Uint8Array) => Promise<void>;
};

function hasHydrateWorkspace(
  provider: SandboxProvider,
): provider is HydratableProvider {
  return (
    typeof (provider as Partial<HydratableProvider>).hydrateWorkspace ===
    "function"
  );
}

/**
 * Wrap any `SandboxProvider` (built-in or host-supplied) so every operation
 * produces an OpenTelemetry span. Applied automatically when a provider is
 * handed to `CatamorphicCore`, so hosts get sandbox traces for free once they
 * register an OTel SDK.
 */
export function instrumentSandboxProvider(
  provider: SandboxProvider,
): SandboxProvider {
  const providerName = provider.constructor?.name ?? "SandboxProvider";
  const base = { "catamorphic.sandbox.provider": providerName };

  const instrumented: SandboxProvider &
    Partial<Pick<HydratableProvider, "hydrateWorkspace">> = {
    workspaceRoot: provider.workspaceRoot,

    createSandbox: (opts: CreateSandboxOpts): Promise<SandboxHandle> =>
      withSpan(
        { tracer, name: "sandbox.create", attributes: base },
        async (span) => {
          const handle = await provider.createSandbox(opts);
          span.setAttribute("catamorphic.sandbox.id", handle.id);
          return handle;
        },
      ),

    startSandbox: (sandboxId: string): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.start",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.startSandbox(sandboxId),
      ),

    stopSandbox: (sandboxId: string): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.stop",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.stopSandbox(sandboxId),
      ),

    destroySandbox: (sandboxId: string): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.destroy",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.destroySandbox(sandboxId),
      ),

    getSandboxStatus: (sandboxId: string): Promise<SandboxStatus> =>
      provider.getSandboxStatus(sandboxId),

    executeCommand: (
      sandboxId: string,
      command: string,
      opts?: ExecOpts,
    ): Promise<ExecResult> =>
      withSpan(
        {
          tracer,
          name: "sandbox.exec",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        async (span) => {
          const result = await provider.executeCommand(
            sandboxId,
            command,
            opts,
          );
          span.setAttribute("catamorphic.sandbox.exit_code", result.exitCode);
          return result;
        },
      ),

    uploadFiles: (
      sandboxId: string,
      files: Record<string, string>,
      basePath: string,
    ): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.upload_files",
          attributes: {
            ...base,
            "catamorphic.sandbox.id": sandboxId,
            "catamorphic.sandbox.file_count": Object.keys(files).length,
          },
        },
        () => provider.uploadFiles(sandboxId, files, basePath),
      ),

    downloadFile: (sandboxId: string, filePath: string): Promise<string> =>
      withSpan(
        {
          tracer,
          name: "sandbox.download_file",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.downloadFile(sandboxId, filePath),
      ),

    gitClone: (
      sandboxId: string,
      url: string,
      path: string,
      opts?: GitCloneOpts,
    ): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.git_clone",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.gitClone(sandboxId, url, path, opts),
      ),

    gitCheckout: (
      sandboxId: string,
      path: string,
      ref: string,
    ): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.git_checkout",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.gitCheckout(sandboxId, path, ref),
      ),
  };

  if (hasHydrateWorkspace(provider)) {
    instrumented.hydrateWorkspace = (
      sandboxId: string,
      tar: Uint8Array,
    ): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.hydrate_workspace",
          attributes: {
            ...base,
            "catamorphic.sandbox.id": sandboxId,
            "catamorphic.sandbox.tar_bytes": tar.byteLength,
          },
        },
        () => provider.hydrateWorkspace(sandboxId, tar),
      );
  }

  return instrumented;
}
