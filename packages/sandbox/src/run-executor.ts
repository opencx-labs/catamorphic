import { RUNTIME_HARNESS_SOURCE } from "@catamorphic/runtime";
import type {
  RunExecutor,
  RunResult,
  SandboxProvider,
  StepEntry,
} from "./types.js";

interface RunExecutorOpts {
  provider: SandboxProvider;
  timeoutSeconds?: number;
}

export interface PluginPayload {
  packageName: string;
  files: Record<string, string>;
}

export interface ExecuteRunOpts {
  sandboxId: string;
  workingDirectory: string;
  workflowFile: string;
  workflowName: string;
  triggerData: unknown;
  runId: string;
  plugins?: PluginPayload[];
  secrets?: Record<string, string>;
}

export class RunExecutorImpl implements RunExecutor {
  private readonly timeoutSeconds: number;

  constructor(private readonly opts: RunExecutorOpts) {
    this.timeoutSeconds = opts.timeoutSeconds ?? 300;
  }

  async executeRun(opts: ExecuteRunOpts): Promise<RunResult> {
    await this.opts.provider.uploadFiles(
      opts.sandboxId,
      { "harness.ts": RUNTIME_HARNESS_SOURCE },
      opts.workingDirectory,
    );
    await uploadPluginPayloads({
      provider: this.opts.provider,
      sandboxId: opts.sandboxId,
      projectDir: opts.workingDirectory,
      plugins: opts.plugins,
    });

    const result = await this.opts.provider.executeCommand(
      opts.sandboxId,
      "bun run harness.ts",
      {
        cwd: opts.workingDirectory,
        timeout: this.timeoutSeconds,
        env: {
          CATAMORPHIC_RUN_ID: opts.runId,
          CATAMORPHIC_WORKFLOW_NAME: opts.workflowName,
          CATAMORPHIC_WORKFLOW_FILE: opts.workflowFile,
          CATAMORPHIC_TRIGGER_DATA: JSON.stringify(opts.triggerData ?? {}),
          ...(opts.secrets ?? {}),
        },
      },
    );

    return parseRunResult({
      output: result.result,
      exitCode: result.exitCode,
    });
  }
}

export async function uploadPluginPayloads(opts: {
  provider: SandboxProvider;
  sandboxId: string;
  projectDir: string;
  plugins?: PluginPayload[];
}): Promise<void> {
  for (const plugin of opts.plugins ?? []) {
    assertPackageName(plugin.packageName);
    for (const filePath of Object.keys(plugin.files)) {
      assertRelativeFilePath(filePath);
    }
    if (Object.keys(plugin.files).length === 0) continue;
    await opts.provider.uploadFiles(
      opts.sandboxId,
      plugin.files,
      `${opts.projectDir}/node_modules/${plugin.packageName}`,
    );
  }
}

function parseRunResult(opts: { output: string; exitCode: number }): RunResult {
  const marker = "CATAMORPHIC_REPORT:";
  const markerIndex = opts.output.lastIndexOf(marker);
  if (markerIndex === -1) {
    return {
      status: "failed",
      error:
        opts.output.trim() ||
        `Workflow process exited with code ${opts.exitCode} without a report`,
      steps: [],
    };
  }

  const reportLine = opts.output
    .slice(markerIndex + marker.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!reportLine) {
    return {
      status: "failed",
      error: "Workflow produced an empty report",
      steps: [],
    };
  }

  try {
    const parsed = JSON.parse(reportLine) as {
      status?: unknown;
      result?: unknown;
      error?: unknown;
      steps?: unknown;
    };
    if (parsed.status !== "completed" && parsed.status !== "failed") {
      throw new Error("Workflow report had an invalid status");
    }
    if (!isStepEntries(parsed.steps)) {
      throw new Error("Workflow report had invalid steps");
    }
    if (parsed.status === "failed" && typeof parsed.error !== "string") {
      throw new Error("Failed workflow report had no error");
    }
    return {
      status: parsed.status,
      result: parsed.result,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      steps: parsed.steps,
    };
  } catch (error) {
    return {
      status: "failed",
      error:
        error instanceof Error
          ? `Invalid workflow report: ${error.message}`
          : "Invalid workflow report",
      steps: [],
    };
  }
}

function isStepEntries(value: unknown): value is StepEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "nodeId" in entry &&
        typeof entry.nodeId === "string" &&
        "name" in entry &&
        typeof entry.name === "string" &&
        "status" in entry &&
        (entry.status === "completed" ||
          entry.status === "failed" ||
          entry.status === "skipped") &&
        "startedAt" in entry &&
        typeof entry.startedAt === "string" &&
        isValidDate(entry.startedAt) &&
        "completedAt" in entry &&
        typeof entry.completedAt === "string" &&
        isValidDate(entry.completedAt),
    )
  );
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function assertPackageName(packageName: string): void {
  const valid = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(
    packageName,
  );
  if (!valid) {
    throw new Error(`Invalid plugin package name '${packageName}'`);
  }
}

function assertRelativeFilePath(filePath: string): void {
  const parts = filePath.split("/");
  if (
    filePath.startsWith("/") ||
    filePath.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid plugin file path '${filePath}'`);
  }
}
