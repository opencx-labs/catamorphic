import { describe, expect, it, vi } from "vitest";
import { RunExecutorImpl } from "../run-executor.js";
import type { SandboxManager, SandboxProvider } from "../types.js";

function createMockProvider(
  commandResult: { exitCode: number; result: string } = {
    exitCode: 0,
    result: "",
  },
): SandboxProvider {
  return {
    createSandbox: vi.fn(async () => ({
      id: "sb-1",
      providerId: "sb-1",
      sandboxType: "execution" as const,
      status: "started" as const,
    })),
    startSandbox: vi.fn(async () => {}),
    stopSandbox: vi.fn(async () => {}),
    destroySandbox: vi.fn(async () => {}),
    getSandboxStatus: vi.fn(async () => "started" as const),
    executeCommand: vi.fn(async () => commandResult),
    uploadFiles: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => ""),
    gitClone: vi.fn(async () => {}),
    gitCheckout: vi.fn(async () => {}),
  };
}

function createMockManager(): SandboxManager {
  return {
    ensureExecSandbox: vi.fn(async () => ({
      id: "sb-1",
      providerId: "prov-1",
      sandboxType: "execution" as const,
      status: "started" as const,
    })),
    ensureDevSandbox: vi.fn(async () => ({
      id: "sb-2",
      providerId: "prov-2",
      sandboxType: "dev" as const,
      status: "started" as const,
    })),
    releaseSandbox: vi.fn(async () => {}),
  };
}

describe("RunExecutorImpl", () => {
  it("calls ensureExecSandbox with correct project and commit", async () => {
    const provider = createMockProvider();
    const manager = createMockManager();
    const executor = new RunExecutorImpl({
      provider,
      sandboxManager: manager,
      apiBaseUrl: "http://localhost:3001",
    });

    await executor.executeRun({
      projectId: "proj-1",
      workflowName: "myWorkflow",
      triggerData: { email: "test@test.com" },
      runId: "run-1",
      commitSha: "abc123",
    });

    expect(manager.ensureExecSandbox).toHaveBeenCalledWith({
      projectId: "proj-1",
      commitSha: "abc123",
    });
  });

  it("executes the harness command with env vars", async () => {
    const provider = createMockProvider();
    const manager = createMockManager();
    const executor = new RunExecutorImpl({
      provider,
      sandboxManager: manager,
      apiBaseUrl: "http://localhost:3001",
    });

    await executor.executeRun({
      projectId: "proj-1",
      workflowName: "myWorkflow",
      triggerData: { email: "test@test.com" },
      runId: "run-1",
      commitSha: "abc123",
    });

    expect(provider.executeCommand).toHaveBeenCalledTimes(1);
    const cmd = (provider.executeCommand as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as string;
    expect(cmd).toContain("CATAMORPHIC_RUN_ID");
    expect(cmd).toContain("CATAMORPHIC_WORKFLOW_NAME");
    expect(cmd).toContain("myWorkflow");
    expect(cmd).toContain("bun run");
  });

  it("parses a successful CATAMORPHIC_REPORT from output", async () => {
    const report = JSON.stringify({
      status: "completed",
      steps: [
        {
          nodeId: "step-1",
          name: "doStuff",
          status: "completed",
          input: { x: 1 },
          output: { y: 2 },
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:01Z",
        },
      ],
    });

    const provider = createMockProvider({
      exitCode: 0,
      result: `Some logs...\nCATAMORPHIC_REPORT:${report}`,
    });
    const manager = createMockManager();
    const executor = new RunExecutorImpl({
      provider,
      sandboxManager: manager,
      apiBaseUrl: "http://localhost:3001",
    });

    const result = await executor.executeRun({
      projectId: "proj-1",
      workflowName: "myWorkflow",
      triggerData: {},
      runId: "run-1",
      commitSha: "abc123",
    });

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.name).toBe("doStuff");
  });

  it("returns failed status on non-zero exit code", async () => {
    const provider = createMockProvider({
      exitCode: 1,
      result: "Error: something broke",
    });
    const manager = createMockManager();
    const executor = new RunExecutorImpl({
      provider,
      sandboxManager: manager,
      apiBaseUrl: "http://localhost:3001",
    });

    const result = await executor.executeRun({
      projectId: "proj-1",
      workflowName: "myWorkflow",
      triggerData: {},
      runId: "run-1",
      commitSha: "abc123",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("something broke");
  });

  it("returns completed with empty steps when no report marker", async () => {
    const provider = createMockProvider({
      exitCode: 0,
      result: "Just some output with no report marker",
    });
    const manager = createMockManager();
    const executor = new RunExecutorImpl({
      provider,
      sandboxManager: manager,
      apiBaseUrl: "http://localhost:3001",
    });

    const result = await executor.executeRun({
      projectId: "proj-1",
      workflowName: "myWorkflow",
      triggerData: {},
      runId: "run-1",
      commitSha: "abc123",
    });

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(0);
  });
});
