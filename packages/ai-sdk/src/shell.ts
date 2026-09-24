import crypto from "node:crypto";
import type { SandboxProvider } from "@catamorphic/sandbox";

/** Foreground commands wait this long unless the agent asks for more. */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
/** The longest a foreground command may run; longer work goes to the background. */
export const SHELL_MAX_TIMEOUT_MS = 600_000;
/** Model-facing output budget: the start and the end of long output survive. */
export const SHELL_OUTPUT_LIMIT = 30_000;

/** Per-session shell state: the directory the last command left behind. */
export interface ShellState {
  cwd?: string;
}

/**
 * Run one foreground command the way a terminal user expects: in the
 * directory the previous command left (so `cd` persists between calls),
 * with stdout and stderr together, bounded in time, and cancellable.
 */
export async function runShell(input: {
  provider: Pick<SandboxProvider, "executeCommand">;
  sandboxId: string;
  /** The session's project folder: the starting directory and the fallback. */
  root: string;
  state: ShellState;
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; output: string }> {
  const marker = `__catamorphic_cwd_${crypto.randomUUID().replaceAll("-", "")}__`;
  const cwd = input.state.cwd ?? input.root;
  const script = [
    `cd ${quote(cwd)} 2>/dev/null || cd ${quote(input.root)}`,
    input.command,
    "__catamorphic_status=$?",
    `printf '\\n${marker}%s\\n' "$PWD"`,
    "exit $__catamorphic_status",
  ].join("\n");
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS, 1_000),
    SHELL_MAX_TIMEOUT_MS,
  );
  const result = await input.provider.executeCommand(input.sandboxId, script, {
    cwd: input.root,
    timeout: Math.ceil(timeoutMs / 1000),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let output = result.result;
  const at = output.lastIndexOf(marker);
  if (at !== -1) {
    const directory = output.slice(at + marker.length).split("\n", 1)[0];
    if (directory) input.state.cwd = directory;
    output = output.slice(0, at);
  }
  return {
    exitCode: result.exitCode,
    output: truncateOutput(output.replace(/\n+$/, "")),
  };
}

/** Keep the first and last parts of long output; errors usually sit at the end. */
export function truncateOutput(
  output: string,
  limit = SHELL_OUTPUT_LIMIT,
): string {
  if (output.length <= limit) return output;
  const head = Math.floor(limit / 3);
  const tail = limit - head;
  const omitted = output.length - head - tail;
  return `${output.slice(0, head)}\n[… ${omitted} characters omitted …]\n${output.slice(-tail)}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
