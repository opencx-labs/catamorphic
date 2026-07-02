import type { CloneSource } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type {
  RunPluginPayload,
  SandboxProvider,
  StepEntry,
} from "@catamorphic/sandbox";
import { uploadPluginPayloads } from "@catamorphic/sandbox";
import { uploadWorkspace } from "./playground/workspace-upload.js";

const tracer = getTracer("@catamorphic/core");

export interface PlaygroundRunRequest {
  files: Record<string, string>;
  workflowName: string;
  triggerData?: Record<string, unknown>;
  /**
   * Deterministic commit SHA for the working tree being executed. Passed to
   * the harness via `CATAMORPHIC_COMMIT_SHA` so runtime code can correlate
   * with the storage backend.
   */
  commitSha?: string | null;
  /**
   * Plugin packages attached to the project. Uploaded into
   * `node_modules/<packageName>` so workflow code can import them.
   */
  plugins?: RunPluginPayload[];
  /**
   * Secret env vars declared by attached plugin manifests. Injected into the
   * harness process alongside the built-in `CATAMORPHIC_*` vars.
   */
  secrets?: Record<string, string>;
  /**
   * When set, the sandbox `git clone`s the project from this remote (e.g. a
   * Cloudflare Artifacts repo) instead of receiving `files` as uploads.
   * `files` is still used for the pre-flight workflow lookup; only the
   * harness is uploaded on top of the clone. `commitSha` pins the checkout.
   */
  cloneSource?: CloneSource;
}

export interface PlaygroundRunResult {
  status: "completed" | "failed";
  result: unknown;
  error: string | null;
  steps: StepEntry[];
  startedAt: string;
  completedAt: string;
}

const HARNESS_SOURCE = `
const workflowName = process.env.CATAMORPHIC_WORKFLOW_NAME ?? "";
const triggerDataRaw = process.env.CATAMORPHIC_TRIGGER_DATA ?? "{}";

if (!workflowName) {
  console.error("Missing CATAMORPHIC_WORKFLOW_NAME");
  process.exit(1);
}

const triggerData = JSON.parse(triggerDataRaw);
const stepLog = [];
const startedAt = new Date().toISOString();

// Step functions are rewritten at the source level (see instrumentSource)
// to route through this global wrapper. Module-namespace patching does not
// work: ESM namespaces are read-only and intra-module calls bind directly.
globalThis.__catamorphicWrapStep = (fn, stepName) => async (...callArgs) => {
  const entry = { nodeId: stepName, name: stepName, status: "completed", input: callArgs[0], startedAt: new Date().toISOString(), completedAt: "" };
  stepLog.push(entry);
  try {
    const result = await fn(...callArgs);
    entry.output = result;
    entry.completedAt = new Date().toISOString();
    return result;
  } catch (err) {
    entry.status = "failed";
    entry.error = err instanceof Error ? err.message : String(err);
    entry.completedAt = new Date().toISOString();
    throw err;
  }
};

const INSTRUMENTED_MARKER = "/* @catamorphic-instrumented */";
const STEP_FN_RE = /(export\\s+)?((?:async\\s+)?function\\s+)([A-Za-z_$][\\w$]*)(\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{\\s*["']use step["'])/g;

function instrumentSource(source) {
  if (source.startsWith(INSTRUMENTED_MARKER)) return null;
  const steps = [];
  const transformed = source.replace(STEP_FN_RE, (_m, exported, fnKeyword, name, rest) => {
    steps.push({ name, exported: Boolean(exported) });
    return fnKeyword + "__catamorphic_step_" + name + rest;
  });
  if (steps.length === 0) return null;
  const footer = steps
    .map((s) =>
      (s.exported ? "export " : "") +
      "const " + s.name + " = globalThis.__catamorphicWrapStep(__catamorphic_step_" + s.name + ", " + JSON.stringify(s.name) + ");",
    )
    .join("\\n");
  return INSTRUMENTED_MARKER + "\\n" + transformed + "\\n" + footer + "\\n";
}

async function listSourceFiles() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const found = [];

  async function scanDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath);
      } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".js")) && fullPath !== path.join(process.cwd(), "harness.ts")) {
        found.push(fullPath);
      }
    }
  }

  await scanDir(process.cwd());
  return found;
}

async function run() {
  const fs = await import("node:fs/promises");
  const files = await listSourceFiles();

  let workflowFile = null;
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf-8");
    if (source.includes("function " + workflowName) && source.includes('"use workflow"')) {
      workflowFile = filePath;
    }
    const instrumented = instrumentSource(source);
    if (instrumented !== null) {
      await fs.writeFile(filePath, instrumented);
    }
  }

  if (!workflowFile) throw new Error("Workflow function '" + workflowName + "' not found");

  const mod = await import(workflowFile);
  const workflowFn = mod[workflowName];
  if (typeof workflowFn !== "function") throw new Error("'" + workflowName + "' is not exported as a function");

  const result = await workflowFn(triggerData);
  const report = { status: "completed", result, steps: stepLog, startedAt, completedAt: new Date().toISOString() };
  console.log("CATAMORPHIC_REPORT:" + JSON.stringify(report));
}

run().catch((err) => {
  const report = { status: "failed", error: err instanceof Error ? err.message : String(err), steps: stepLog, startedAt, completedAt: new Date().toISOString() };
  console.log("CATAMORPHIC_REPORT:" + JSON.stringify(report));
  process.exit(1);
});
`;

function parseReport(output: string): PlaygroundRunResult {
  const marker = "CATAMORPHIC_REPORT:";
  const idx = output.lastIndexOf(marker);
  if (idx === -1) {
    return {
      status: "failed",
      result: null,
      error: output || "No report produced",
      steps: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  const json = output.slice(idx + marker.length).trim();
  const parsed = JSON.parse(json) as {
    status?: string;
    result?: unknown;
    error?: string;
    steps?: StepEntry[];
    startedAt?: string;
    completedAt?: string;
  };

  return {
    status: parsed.status === "completed" ? "completed" : "failed",
    result: parsed.result ?? null,
    error: parsed.error ?? null,
    steps: parsed.steps ?? [],
    startedAt: parsed.startedAt ?? new Date().toISOString(),
    completedAt: parsed.completedAt ?? new Date().toISOString(),
  };
}

export class PlaygroundExecutor {
  constructor(private readonly provider: SandboxProvider) {}

  async execute(request: PlaygroundRunRequest): Promise<PlaygroundRunResult> {
    return withSpan(
      {
        tracer,
        name: "workflow.execute",
        attributes: {
          "catamorphic.workflow.name": request.workflowName,
          "catamorphic.run.file_count": Object.keys(request.files).length,
        },
      },
      async (span) => {
        const result = await this.executeInner(request);
        span.setAttribute("catamorphic.run.status", result.status);
        return result;
      },
    );
  }

  private async executeInner(
    request: PlaygroundRunRequest,
  ): Promise<PlaygroundRunResult> {
    const sandbox = await this.provider.createSandbox({
      language: "typescript",
      autoStopInterval: 5,
      labels: { purpose: "playground" },
    });

    try {
      const projectDir = `${this.provider.workspaceRoot}/project`;

      if (request.cloneSource) {
        await this.provider.gitClone(
          sandbox.providerId,
          request.cloneSource.url,
          projectDir,
          {
            branch: request.cloneSource.branch,
            commitId: request.commitSha ?? undefined,
            username: request.cloneSource.username,
            password: request.cloneSource.password,
          },
        );
        await uploadWorkspace({
          provider: this.provider,
          sandboxId: sandbox.providerId,
          projectDir,
          files: { "harness.ts": HARNESS_SOURCE },
        });
      } else {
        await uploadWorkspace({
          provider: this.provider,
          sandboxId: sandbox.providerId,
          projectDir,
          files: {
            ...request.files,
            "harness.ts": HARNESS_SOURCE,
          },
        });
      }

      await uploadPluginPayloads(
        this.provider,
        sandbox.providerId,
        projectDir,
        request.plugins,
      );

      const env: Record<string, string> = {
        CATAMORPHIC_WORKFLOW_NAME: request.workflowName,
        CATAMORPHIC_TRIGGER_DATA: JSON.stringify(request.triggerData ?? {}),
        ...(request.secrets ?? {}),
      };
      if (request.commitSha) {
        env.CATAMORPHIC_COMMIT_SHA = request.commitSha;
      }

      const envFlags = Object.entries(env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");

      const result = await this.provider.executeCommand(
        sandbox.providerId,
        `cd ${projectDir} && ${envFlags} bun run harness.ts`,
        { timeout: 120 },
      );

      if (result.exitCode !== 0) {
        try {
          return parseReport(result.result);
        } catch {
          return {
            status: "failed",
            result: null,
            error:
              result.result || `Process exited with code ${result.exitCode}`,
            steps: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        }
      }

      return parseReport(result.result);
    } finally {
      this.provider.destroySandbox(sandbox.providerId).catch(() => {});
    }
  }
}
