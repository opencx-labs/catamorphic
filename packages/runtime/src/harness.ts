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
import { instrumentSource, wrapStep } from "./step-wrapper.js";
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

// Instrumented project sources (see `instrumentSource`) route every step
// call through this global wrapper. Patching the imported module namespace
// does not work: ESM namespaces are read-only, and intra-module calls bind
// to the declaration directly.
(
  globalThis as Record<string, unknown> & {
    __catamorphicWrapStep?: unknown;
  }
).__catamorphicWrapStep = (
  fn: (...args: unknown[]) => unknown,
  stepName: string,
) => wrapStep(fn, stepName, stepLog);

async function listSourceFiles(): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const found: string[] = [];
  const harnessPath = path.join(process.cwd(), "harness.ts");

  async function scanDir(dir: string): Promise<void> {
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
        await scanDir(fullPath);
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) &&
        fullPath !== harnessPath
      ) {
        found.push(fullPath);
      }
    }
  }

  await scanDir(process.cwd());
  return found;
}

async function run(): Promise<void> {
  const fs = await import("node:fs/promises");
  const files = await listSourceFiles();

  const workflowFiles: string[] = [];
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf-8");
    if (
      source.includes(`function ${workflowName}`) &&
      source.includes('"use workflow"')
    ) {
      workflowFiles.push(filePath);
    }
    const instrumented = instrumentSource(source);
    if (instrumented !== null) {
      await fs.writeFile(filePath, instrumented);
    }
  }

  const workflowFile = workflowFiles[0];
  if (!workflowFile) {
    throw new Error(`Workflow function '${workflowName}' not found`);
  }

  const mod = (await import(workflowFile)) as Record<string, unknown>;
  const workflowFn = mod[workflowName];
  if (typeof workflowFn !== "function") {
    throw new Error(`'${workflowName}' is not exported as a function`);
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
