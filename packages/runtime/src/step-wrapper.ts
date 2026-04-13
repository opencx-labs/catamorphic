import type { StepEntry } from "./types.js";

export function wrapStep(
  originalFn: (...args: unknown[]) => unknown,
  stepName: string,
  stepLog: StepEntry[],
): (...args: unknown[]) => Promise<unknown> {
  const wrapped = async (...callArgs: unknown[]): Promise<unknown> => {
    const args = callArgs[0] as Record<string, unknown> | undefined;
    const entry: StepEntry = {
      nodeId: stepName,
      name: stepName,
      status: "completed",
      input: args,
      startedAt: new Date().toISOString(),
      completedAt: "",
    };
    stepLog.push(entry);

    try {
      const result = await originalFn(...callArgs);
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
  return wrapped;
}

const USE_STEP_RE = /["']use step["']/;

export function hasUseStepDirective(source: string): boolean {
  return USE_STEP_RE.test(source);
}

export function findStepFunctions(
  source: string,
): Array<{ name: string; isAsync: boolean }> {
  const results: Array<{ name: string; isAsync: boolean }> = [];

  const funcRe =
    /(?:export\s+)?(async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]*)?\{[^}]*["']use step["']/g;
  let match = funcRe.exec(source);
  while (match) {
    results.push({
      name: match[2]!,
      isAsync: match[1] !== undefined,
    });
    match = funcRe.exec(source);
  }

  return results;
}
