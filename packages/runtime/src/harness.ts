/**
 * Runtime harness that executes inside a Daytona sandbox.
 *
 * Environment variables:
 *   CATAMORPHIC_RUN_ID        - The run ID
 *   CATAMORPHIC_WORKFLOW_NAME - The workflow function name to execute
 *   CATAMORPHIC_TRIGGER_DATA  - JSON-encoded trigger data
 *   CATAMORPHIC_API_URL       - Base URL for the Catamorphic API
 *   CATAMORPHIC_COMMIT_SHA    - The commit SHA being executed
 */
import { reportRunResult } from "./reporter.js";
import {
  findStepFunctions,
  hasUseStepDirective,
  wrapStep,
} from "./step-wrapper.js";
import type { RunReport, StepEntry } from "./types.js";

const runId = process.env.CATAMORPHIC_RUN_ID ?? "";
const workflowName = process.env.CATAMORPHIC_WORKFLOW_NAME ?? "";
const triggerDataRaw = process.env.CATAMORPHIC_TRIGGER_DATA ?? "{}";
const apiUrl = process.env.CATAMORPHIC_API_URL;

if (!runId || !workflowName) {
  console.error("Missing CATAMORPHIC_RUN_ID or CATAMORPHIC_WORKFLOW_NAME");
  process.exit(1);
}

const triggerData = JSON.parse(triggerDataRaw) as Record<string, unknown>;
const stepLog: StepEntry[] = [];
const startedAt = new Date().toISOString();

async function findWorkflowFile(): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  async function scanDir(dir: string): Promise<string | null> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist"
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await scanDir(fullPath);
        if (found) return found;
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        const source = await fs.readFile(fullPath, "utf-8");
        if (
          source.includes(`function ${workflowName}`) &&
          source.includes('"use workflow"')
        ) {
          return fullPath;
        }
      }
    }
    return null;
  }

  return scanDir(process.cwd());
}

async function run(): Promise<void> {
  const workflowFile = await findWorkflowFile();
  if (!workflowFile) {
    throw new Error(`Workflow function '${workflowName}' not found`);
  }

  const fs = await import("node:fs/promises");
  const source = await fs.readFile(workflowFile, "utf-8");

  const mod = (await import(workflowFile)) as Record<string, unknown>;
  const workflowFn = mod[workflowName];
  if (typeof workflowFn !== "function") {
    throw new Error(`'${workflowName}' is not exported as a function`);
  }

  if (hasUseStepDirective(source)) {
    const steps = findStepFunctions(source);
    for (const step of steps) {
      const original = mod[step.name];
      if (typeof original === "function") {
        (mod as Record<string, unknown>)[step.name] = wrapStep(
          original as (...args: unknown[]) => unknown,
          step.name,
          stepLog,
        );
      }
    }
  }

  const result = await (workflowFn as (data: unknown) => Promise<unknown>)(
    triggerData,
  );
  const report: RunReport = {
    runId,
    status: "completed",
    result,
    steps: stepLog,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  if (apiUrl) {
    await reportRunResult(apiUrl, runId, report);
  }

  console.log(`CATAMORPHIC_REPORT:${JSON.stringify(report)}`);
}

run().catch(async (err: unknown) => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const report: RunReport = {
    runId,
    status: "failed",
    error: errorMessage,
    steps: stepLog,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  if (apiUrl) {
    await reportRunResult(apiUrl, runId, report).catch(() => {});
  }

  console.log(`CATAMORPHIC_REPORT:${JSON.stringify(report)}`);
  process.exit(1);
});
