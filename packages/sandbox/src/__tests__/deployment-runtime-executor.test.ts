import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import { describe, expect, it, vi } from "vitest";
import { DeploymentRuntimeExecutorAdapter } from "../deployment-runtime-executor.js";
import { instrumentSandboxProvider } from "../instrumented-provider.js";
import type {
  DeploymentRuntime,
  DeploymentRuntimeProvider,
  GetRuntimeHealthArgs,
  RunExecutor,
  RunResult,
  RuntimeHealth,
  RuntimeInvocationReceipt,
  SandboxProvider,
} from "../types.js";

const runtime: DeploymentRuntime = {
  runtimeId: "runtime-1",
  sandboxId: "sandbox-1",
  deploymentArtifactId: "artifact-1",
  artifactDigest: "digest-1",
  transformVersion: "transform-1",
  runtimeVersion: "runtime-1",
  generation: "generation-1",
  status: "healthy",
};

describe("DeploymentRuntimeExecutorAdapter", () => {
  it("uses a provider deployment runtime when available", async () => {
    const deploymentRuntime = createDeploymentRuntime();
    const provider = createProvider({ deploymentRuntime });
    const fallback: RunExecutor = { executeRun: vi.fn() };
    const executor = new DeploymentRuntimeExecutorAdapter({
      provider,
      runtime,
      fallback,
      timeoutSeconds: 30,
      now: () => new Date("2026-07-12T12:00:00.000Z"),
    });

    const result = await executor.executeRun({
      sandboxId: "sandbox-1",
      workingDirectory: "/deployment",
      workflowFile: "src/workflow.ts",
      workflowName: "run",
      triggerData: { value: 2 },
      runId: "run-1",
      secrets: { API_KEY: "secret" },
    });

    expect(deploymentRuntime.invoke).toHaveBeenCalledWith({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId: "runtime-1",
      invocationId: "run-1",
      deploymentArtifactId: "artifact-1",
      artifactDigest: "digest-1",
      transformVersion: "transform-1",
      runtimeVersion: "runtime-1",
      kind: "workflow",
      target: {
        modulePath: "src/workflow.ts",
        exportName: "run",
      },
      input: { value: 2 },
      attempt: 1,
      deadlineAt: "2026-07-12T12:00:30.000Z",
      env: { API_KEY: "secret" },
      eventSink: undefined,
      replay: undefined,
      traceContext: {},
    });
    expect(fallback.executeRun).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "completed",
      result: { doubled: 4 },
      steps: [],
    });
  });

  it("preserves command execution fallback for existing providers", async () => {
    const fallback: RunExecutor = {
      executeRun: vi.fn(
        async (): Promise<RunResult> => ({
          status: "completed",
          result: "fallback",
          steps: [],
        }),
      ),
    };
    const executor = new DeploymentRuntimeExecutorAdapter({
      provider: createProvider({}),
      runtime,
      fallback,
    });
    const run = {
      sandboxId: "sandbox-1",
      workingDirectory: "/deployment",
      workflowFile: "workflow.ts",
      workflowName: "run",
      triggerData: {},
      runId: "run-1",
    };

    await expect(executor.executeRun(run)).resolves.toMatchObject({
      result: "fallback",
    });
    expect(fallback.executeRun).toHaveBeenCalledWith(run);
  });

  it("maps cancellation and timeout terminals to failed run results", async () => {
    const deploymentRuntime = createDeploymentRuntime({
      terminal: {
        status: "timed_out",
        error: "Invocation deadline exceeded",
        steps: [],
      },
    });
    const executor = new DeploymentRuntimeExecutorAdapter({
      provider: createProvider({ deploymentRuntime }),
      runtime,
    });

    await expect(
      executor.executeRun({
        sandboxId: "sandbox-1",
        workingDirectory: "/deployment",
        workflowFile: "workflow.ts",
        workflowName: "run",
        triggerData: {},
        runId: "run-1",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "Invocation deadline exceeded",
    });
  });

  it("preserves optional runtime capabilities through instrumentation", async () => {
    const deploymentRuntime = createDeploymentRuntime();
    const instrumented = instrumentSandboxProvider(
      createProvider({ deploymentRuntime }),
    );

    await expect(
      instrumented.deploymentRuntime?.getHealth({ runtimeId: "runtime-1" }),
    ).resolves.toMatchObject({ runtimeId: "runtime-1", status: "healthy" });
    expect(deploymentRuntime.getHealth).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
    });
  });
});

function createDeploymentRuntime(args?: {
  terminal?: RuntimeInvocationReceipt["terminal"];
}): DeploymentRuntimeProvider {
  return {
    ensureRuntime: vi.fn(async () => runtime),
    invoke: vi.fn(async (invocation) => ({
      runtimeId: invocation.runtimeId,
      invocationId: invocation.invocationId,
      events: [],
      terminal: args?.terminal ?? {
        status: "completed",
        result: { doubled: 4 },
        steps: [],
      },
    })),
    cancel: vi.fn(async () => {}),
    getHealth: vi.fn(
      async (healthArgs: GetRuntimeHealthArgs): Promise<RuntimeHealth> => ({
        runtimeId: healthArgs.runtimeId,
        runtimeStatus: "healthy",
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        status: "healthy",
        activeInvocations: 0,
        queuedInvocations: 0,
        maxConcurrency: 1,
      }),
    ),
  };
}

function createProvider(args: {
  deploymentRuntime?: DeploymentRuntimeProvider;
}): SandboxProvider {
  return {
    workspaceRoot: "/workspace",
    deploymentRuntime: args.deploymentRuntime,
    createSandbox: vi.fn(),
    startSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    getSandboxStatus: vi.fn(),
    executeCommand: vi.fn(),
    uploadFiles: vi.fn(),
    downloadFile: vi.fn(),
    gitClone: vi.fn(),
    gitCheckout: vi.fn(),
  };
}
