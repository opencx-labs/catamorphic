import { getTracer, markSpanError, withSpan } from "@catamorphic/otel";
import type { SandboxProcess, SandboxProcessProvider } from "./processes.js";
import type {
  CancelRuntimeInvocationArgs,
  CreateSandboxOpts,
  DeploymentRuntime,
  DeploymentRuntimeProvider,
  EnsureDeploymentRuntimeArgs,
  ExecOpts,
  ExecResult,
  GetRuntimeHealthArgs,
  GitCloneOpts,
  RuntimeHealth,
  RuntimeInvocation,
  RuntimeInvocationReceipt,
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
    resourceLimits: provider.resourceLimits,
    isolation: provider.isolation,
    capabilities: provider.capabilities,
    deploymentRuntime: provider.deploymentRuntime
      ? instrumentDeploymentRuntimeProvider({
          provider: provider.deploymentRuntime,
          providerName,
        })
      : undefined,
    processes: provider.processes
      ? instrumentProcessProvider({
          provider: provider.processes,
          providerName,
        })
      : undefined,

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
      withSpan(
        {
          tracer,
          name: "sandbox.status",
          attributes: { ...base, "catamorphic.sandbox.id": sandboxId },
        },
        () => provider.getSandboxStatus(sandboxId),
      ),

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
          if (result.exitCode !== 0)
            markSpanError({ span, errorType: "process_exit" });
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

function instrumentProcessProvider(args: {
  provider: SandboxProcessProvider;
  providerName: string;
}): SandboxProcessProvider {
  const base = { "catamorphic.sandbox.provider": args.providerName };
  const record = (
    span: { setAttribute(key: string, value: string | number): unknown },
    process: SandboxProcess,
  ) => {
    span.setAttribute("catamorphic.process.id", process.processId);
    span.setAttribute("catamorphic.process.status", process.status);
    if (process.exitCode !== null)
      span.setAttribute("catamorphic.process.exit_code", process.exitCode);
  };
  return {
    startProcess: (options) =>
      withSpan(
        {
          tracer,
          name: "sandbox.process.start",
          attributes: { ...base, "catamorphic.sandbox.id": options.sandboxId },
        },
        async (span) => {
          const process = await args.provider.startProcess(options);
          record(span, process);
          return process;
        },
      ),
    readProcessOutput: (options) =>
      withSpan(
        {
          tracer,
          name: "sandbox.process.read",
          attributes: {
            ...base,
            "catamorphic.sandbox.id": options.sandboxId,
            "catamorphic.process.id": options.processId,
          },
        },
        async (span) => {
          const output = await args.provider.readProcessOutput(options);
          span.setAttribute(
            "catamorphic.process.bytes",
            output.nextCursor - output.cursor,
          );
          span.setAttribute("catamorphic.process.status", output.status);
          return output;
        },
      ),
    signalProcess: (options) =>
      withSpan(
        {
          tracer,
          name: "sandbox.process.signal",
          attributes: {
            ...base,
            "catamorphic.sandbox.id": options.sandboxId,
            "catamorphic.process.id": options.processId,
            "catamorphic.process.signal": options.signal,
          },
        },
        async (span) => {
          const process = await args.provider.signalProcess(options);
          record(span, process);
          return process;
        },
      ),
    listProcesses: (options) =>
      withSpan(
        {
          tracer,
          name: "sandbox.process.list",
          attributes: { ...base, "catamorphic.sandbox.id": options.sandboxId },
        },
        async (span) => {
          const processes = await args.provider.listProcesses(options);
          span.setAttribute("catamorphic.process.count", processes.length);
          return processes;
        },
      ),
  };
}

function instrumentDeploymentRuntimeProvider(args: {
  provider: DeploymentRuntimeProvider;
  providerName: string;
}): DeploymentRuntimeProvider {
  const base = { "catamorphic.sandbox.provider": args.providerName };
  return {
    ensureRuntime: (
      options: EnsureDeploymentRuntimeArgs,
    ): Promise<DeploymentRuntime> =>
      withSpan(
        {
          tracer,
          name: "sandbox.runtime.ensure",
          attributes: {
            ...base,
            "catamorphic.sandbox.id": options.sandboxId,
            "catamorphic.deployment_artifact.id": options.deploymentArtifactId,
          },
        },
        async (span) => {
          const runtime = await args.provider.ensureRuntime(options);
          span.setAttribute("catamorphic.runtime.id", runtime.runtimeId);
          return runtime;
        },
      ),
    invoke: (options: RuntimeInvocation): Promise<RuntimeInvocationReceipt> =>
      withSpan(
        {
          tracer,
          name: "sandbox.runtime.invoke",
          attributes: {
            ...base,
            "catamorphic.runtime.id": options.runtimeId,
            "catamorphic.invocation.id": options.invocationId,
            "catamorphic.deployment_artifact.id": options.deploymentArtifactId,
          },
        },
        () => args.provider.invoke(options),
      ),
    cancel: (options: CancelRuntimeInvocationArgs): Promise<void> =>
      withSpan(
        {
          tracer,
          name: "sandbox.runtime.cancel",
          attributes: {
            ...base,
            "catamorphic.runtime.id": options.runtimeId,
            "catamorphic.invocation.id": options.invocationId,
          },
        },
        () => args.provider.cancel(options),
      ),
    getHealth: (options: GetRuntimeHealthArgs): Promise<RuntimeHealth> =>
      withSpan(
        {
          tracer,
          name: "sandbox.runtime.health",
          attributes: {
            ...base,
            "catamorphic.runtime.id": options.runtimeId,
          },
        },
        async (span) => {
          const health = await args.provider.getHealth(options);
          span.setAttribute(
            "catamorphic.runtime.active_invocations",
            health.activeInvocations,
          );
          span.setAttribute(
            "catamorphic.runtime.queued_invocations",
            health.queuedInvocations,
          );
          span.setAttribute(
            "catamorphic.runtime.max_concurrency",
            health.maxConcurrency,
          );
          return health;
        },
      ),
  };
}
