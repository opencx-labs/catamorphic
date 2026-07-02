import type {
  CloneSource,
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

/**
 * Payload describing a plugin package to mount inside the sandbox before the
 * harness runs. `files` is a map of paths (relative to the plugin package
 * root) to UTF-8 contents; the executor mirrors them into
 * `<workspaceRoot>/project/node_modules/<packageName>/`.
 */
export interface PluginPayload {
  packageName: string;
  files: Record<string, string>;
}

export interface ExecuteRunOpts {
  projectId: string;
  workflowName: string;
  triggerData: unknown;
  runId: string;
  commitSha: string;
  /**
   * When set, freshly created exec sandboxes `git clone` the project from
   * this remote (e.g. Cloudflare Artifacts) pinned to `commitSha`.
   */
  cloneSource?: CloneSource;
  /**
   * Plugin packages attached to the project. Uploaded into `node_modules/`
   * so workflow code can `import` them at runtime.
   */
  plugins?: PluginPayload[];
  /**
   * Additional environment variables to merge with the harness's built-in
   * `CATAMORPHIC_*` vars. Used by `@catamorphic/plugins` to inject per-project
   * secrets (bearer tokens, API URLs, ...).
   */
  secrets?: Record<string, string>;
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

  async executeRun(opts: ExecuteRunOpts): Promise<RunResult> {
    const sandbox = await this.sandboxManager.ensureExecSandbox({
      projectId: opts.projectId,
      commitSha: opts.commitSha,
      cloneSource: opts.cloneSource,
    });

    const projectDir = `${this.provider.workspaceRoot}/project`;
    await uploadPluginPayloads(
      this.provider,
      sandbox.providerId,
      projectDir,
      opts.plugins,
    );

    const env: Record<string, string> = {
      CATAMORPHIC_RUN_ID: opts.runId,
      CATAMORPHIC_WORKFLOW_NAME: opts.workflowName,
      CATAMORPHIC_TRIGGER_DATA: JSON.stringify(opts.triggerData ?? {}),
      CATAMORPHIC_API_URL: this.apiBaseUrl,
      CATAMORPHIC_COMMIT_SHA: opts.commitSha,
      ...(opts.secrets ?? {}),
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

/**
 * Mirror each plugin package under `<projectDir>/node_modules/<name>/`. We
 * invoke `uploadFiles` once per plugin so we can honor scoped names like
 * `@acme/example-sdk`. Upload is a no-op when `plugins` is empty.
 */
export async function uploadPluginPayloads(
  provider: SandboxProvider,
  sandboxId: string,
  projectDir: string,
  plugins?: PluginPayload[],
): Promise<void> {
  if (!plugins || plugins.length === 0) return;
  for (const plugin of plugins) {
    if (Object.keys(plugin.files).length === 0) continue;
    const basePath = `${projectDir}/node_modules/${plugin.packageName}`;
    await provider.uploadFiles(sandboxId, plugin.files, basePath);
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
