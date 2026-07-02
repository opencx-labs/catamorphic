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

export const INSTRUMENTED_MARKER = "/* @catamorphic-instrumented */";

const STEP_FN_RE =
  /(export\s+)?((?:async\s+)?function\s+)([A-Za-z_$][\w$]*)(\s*\([^)]*\)\s*(?::[^{]*)?\{\s*["']use step["'])/g;

/**
 * Rewrite `"use step"` function declarations so every call — including
 * intra-module calls — routes through `globalThis.__catamorphicWrapStep`.
 * Patching the imported module namespace does not work: ESM namespaces are
 * read-only, and calls within the defining module bind to the declaration
 * directly.
 *
 * Returns the transformed source, or `null` when there is nothing to do
 * (no step functions, or the file was already instrumented).
 */
export function instrumentSource(source: string): string | null {
  if (source.startsWith(INSTRUMENTED_MARKER)) return null;

  const steps: Array<{ name: string; exported: boolean }> = [];
  const transformed = source.replace(
    STEP_FN_RE,
    (
      _match,
      exported: string | undefined,
      fnKeyword: string,
      name: string,
      rest: string,
    ) => {
      steps.push({ name, exported: Boolean(exported) });
      return `${fnKeyword}__catamorphic_step_${name}${rest}`;
    },
  );
  if (steps.length === 0) return null;

  const footer = steps
    .map(
      (step) =>
        `${step.exported ? "export " : ""}const ${step.name} = globalThis.__catamorphicWrapStep(__catamorphic_step_${step.name}, ${JSON.stringify(step.name)});`,
    )
    .join("\n");

  return `${INSTRUMENTED_MARKER}\n${transformed}\n${footer}\n`;
}
