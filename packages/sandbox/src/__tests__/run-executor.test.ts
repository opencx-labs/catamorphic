import { describe, expect, it, vi } from "vitest";
import { RunExecutorImpl } from "../run-executor.js";
import type { SandboxProvider } from "../types.js";

function createProvider(opts?: {
  exitCode?: number;
  result?: string;
}): SandboxProvider {
  return {
    workspaceRoot: "/workspace",
    createSandbox: vi.fn(),
    startSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    destroySandbox: vi.fn(),
    getSandboxStatus: vi.fn(),
    executeCommand: vi.fn(async () => ({
      exitCode: opts?.exitCode ?? 0,
      result:
        opts?.result ??
        'CATAMORPHIC_REPORT:{"status":"completed","result":{"ok":true},"steps":[]}',
    })),
    uploadFiles: vi.fn(async () => {}),
    downloadFile: vi.fn(),
    gitClone: vi.fn(),
    gitCheckout: vi.fn(),
  };
}

function execute(executor: RunExecutorImpl) {
  return executor.executeRun({
    sandboxId: "sandbox-1",
    workingDirectory: "/workspace/run-1",
    workflowFile: "src/workflow.ts",
    workflowName: "myWorkflow",
    triggerData: { value: "$(touch /tmp/injected)" },
    runId: "run-1",
    secrets: { API_KEY: "`not-shell-source`" },
  });
}

describe("RunExecutorImpl", () => {
  it("passes metadata through the provider environment", async () => {
    const provider = createProvider();
    await execute(new RunExecutorImpl({ provider }));

    expect(provider.executeCommand).toHaveBeenCalledWith(
      "sandbox-1",
      "bun run harness.ts",
      expect.objectContaining({
        cwd: "/workspace/run-1",
        env: {
          API_KEY: "`not-shell-source`",
          CATAMORPHIC_RUN_ID: "run-1",
          CATAMORPHIC_TRIGGER_DATA: '{"value":"$(touch /tmp/injected)"}',
          CATAMORPHIC_WORKFLOW_FILE: "src/workflow.ts",
          CATAMORPHIC_WORKFLOW_NAME: "myWorkflow",
        },
      }),
    );
  });

  it("uploads the canonical harness", async () => {
    const provider = createProvider();
    await execute(new RunExecutorImpl({ provider }));
    expect(provider.uploadFiles).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ "harness.ts": expect.any(String) }),
      "/workspace/run-1",
    );
  });

  it("parses a successful report", async () => {
    const provider = createProvider();
    const result = await execute(new RunExecutorImpl({ provider }));
    expect(result).toMatchObject({
      status: "completed",
      result: { ok: true },
      steps: [],
    });
  });

  it("fails when a successful process emits no report", async () => {
    const provider = createProvider({ result: "ordinary output" });
    const result = await execute(new RunExecutorImpl({ provider }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("ordinary output");
  });

  it("fails on a malformed report", async () => {
    const provider = createProvider({
      result: "CATAMORPHIC_REPORT:{not-json}",
    });
    const result = await execute(new RunExecutorImpl({ provider }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid workflow report");
  });

  it("fails when a report omits step data", async () => {
    const provider = createProvider({
      result: 'CATAMORPHIC_REPORT:{"status":"completed"}',
    });
    const result = await execute(new RunExecutorImpl({ provider }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid steps");
  });
});
