import type { SandboxProvider, StepEntry } from "@catamorphic/sandbox";

export interface PlaygroundRunRequest {
  files: Record<string, string>;
  workflowName: string;
  triggerData?: Record<string, unknown>;
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
import { findStepFunctions, hasUseStepDirective, wrapStep } from "./step-wrapper.js";

const workflowName = process.env.CATAMORPHIC_WORKFLOW_NAME ?? "";
const triggerDataRaw = process.env.CATAMORPHIC_TRIGGER_DATA ?? "{}";

if (!workflowName) {
  console.error("Missing CATAMORPHIC_WORKFLOW_NAME");
  process.exit(1);
}

const triggerData = JSON.parse(triggerDataRaw);
const stepLog = [];
const startedAt = new Date().toISOString();

async function findWorkflowFile() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  async function scanDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await scanDir(fullPath);
        if (found) return found;
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        const source = await fs.readFile(fullPath, "utf-8");
        if (source.includes("function " + workflowName) && source.includes('"use workflow"')) {
          return fullPath;
        }
      }
    }
    return null;
  }

  return scanDir(process.cwd());
}

async function run() {
  const workflowFile = await findWorkflowFile();
  if (!workflowFile) throw new Error("Workflow function '" + workflowName + "' not found");

  const fs = await import("node:fs/promises");
  const source = await fs.readFile(workflowFile, "utf-8");
  const mod = await import(workflowFile);
  const workflowFn = mod[workflowName];
  if (typeof workflowFn !== "function") throw new Error("'" + workflowName + "' is not exported as a function");

  const useStepRe = /["']use step["']/;
  if (useStepRe.test(source)) {
    const funcRe = /(?:export\\s+)?(async\\s+)?function\\s+(\\w+)\\s*\\([^)]*\\)\\s*(?::\\s*[^{]*)?\\{[^}]*["']use step["']/g;
    let match = funcRe.exec(source);
    while (match) {
      const stepName = match[2];
      const original = mod[stepName];
      if (typeof original === "function") {
        mod[stepName] = async (...callArgs) => {
          const args = callArgs[0];
          const entry = { nodeId: stepName, name: stepName, status: "completed", input: args, startedAt: new Date().toISOString(), completedAt: "" };
          stepLog.push(entry);
          try {
            const result = await original(...callArgs);
            entry.status = "completed";
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
      }
      match = funcRe.exec(source);
    }
  }

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
    const sandbox = await this.provider.createSandbox({
      language: "typescript",
      autoStopInterval: 5,
      labels: { purpose: "playground" },
    });

    try {
      const projectDir = "/home/daytona/project";
      await this.provider.uploadFiles(
        sandbox.providerId,
        request.files,
        projectDir,
      );
      await this.provider.uploadFiles(
        sandbox.providerId,
        { "harness.ts": HARNESS_SOURCE },
        projectDir,
      );

      const env = {
        CATAMORPHIC_WORKFLOW_NAME: request.workflowName,
        CATAMORPHIC_TRIGGER_DATA: JSON.stringify(request.triggerData ?? {}),
      };

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
