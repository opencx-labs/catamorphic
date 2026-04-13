import type {
  RunExecutor,
  RunResult,
  SandboxManager,
  SandboxProvider,
  StepEntry,
} from "./types.js";

interface RunExecutorOpts {
  provider: SandboxProvider;
  sandboxManager: SandboxManager;
  apiBaseUrl: string;
  harnessPath?: string;
}

export class RunExecutorImpl implements RunExecutor {
  private readonly provider: SandboxProvider;
  private readonly sandboxManager: SandboxManager;
  private readonly apiBaseUrl: string;
  private readonly harnessPath: string;

  constructor(opts: RunExecutorOpts) {
    this.provider = opts.provider;
    this.sandboxManager = opts.sandboxManager;
    this.apiBaseUrl = opts.apiBaseUrl;
    this.harnessPath = opts.harnessPath ?? "/opt/catamorphic/harness.ts";
  }

  async executeRun(opts: {
    projectId: string;
    workflowName: string;
    triggerData: unknown;
    runId: string;
    commitSha: string;
  }): Promise<RunResult> {
    const sandbox = await this.sandboxManager.ensureExecSandbox({
      projectId: opts.projectId,
      commitSha: opts.commitSha,
    });

    const env = {
      CATAMORPHIC_RUN_ID: opts.runId,
      CATAMORPHIC_WORKFLOW_NAME: opts.workflowName,
      CATAMORPHIC_TRIGGER_DATA: JSON.stringify(opts.triggerData ?? {}),
      CATAMORPHIC_API_URL: this.apiBaseUrl,
      CATAMORPHIC_COMMIT_SHA: opts.commitSha,
    };

    const envFlags = Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");

    const result = await this.provider.executeCommand(
      sandbox.providerId,
      `${envFlags} bun run ${this.harnessPath}`,
      { timeout: 300 },
    );

    if (result.exitCode !== 0) {
      return {
        status: "failed",
        error: result.result || `Process exited with code ${result.exitCode}`,
        steps: parseStepsFromOutput(result.result),
      };
    }

    return parseRunResult(result.result);
  }
}

function parseStepsFromOutput(output: string): StepEntry[] {
  try {
    const marker = "CATAMORPHIC_REPORT:";
    const idx = output.lastIndexOf(marker);
    if (idx === -1) return [];
    const json = output.slice(idx + marker.length).trim();
    const report = JSON.parse(json) as { steps?: StepEntry[] };
    return report.steps ?? [];
  } catch {
    return [];
  }
}

function parseRunResult(output: string): RunResult {
  try {
    const marker = "CATAMORPHIC_REPORT:";
    const idx = output.lastIndexOf(marker);
    if (idx === -1) {
      return { status: "completed", steps: [] };
    }
    const json = output.slice(idx + marker.length).trim();
    return JSON.parse(json) as RunResult;
  } catch {
    return { status: "completed", steps: [] };
  }
}
