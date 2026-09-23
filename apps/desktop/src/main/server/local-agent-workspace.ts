import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExecOpts,
  ExecResult,
  SandboxProvider,
} from "@catamorphic/sandbox";

/** Output kept per command before the middle is dropped. */
const OUTPUT_CAP = 8 * 1024 * 1024;

/** Trusted desktop workspace IO. It operates on the assigned checkout, without a copied sandbox. */
export const localAgentWorkspace: Pick<
  SandboxProvider,
  "executeCommand" | "uploadFiles" | "downloadFile"
> = {
  executeCommand: (_id, command, options) => runLocalCommand(command, options),
  async uploadFiles(_id, files, root) {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`))
        throw new Error("File path escapes the working folder");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  },
  async downloadFile(_id, file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw new Error(
        "This file is too large for the text reader. Use a command to inspect the relevant part.",
      );
    return fs.readFile(file, "utf8");
  },
};

/**
 * One shell command on this machine, in its own process group so a timeout
 * or a cancelled turn stops everything it started. stdout and stderr are
 * kept in arrival order, the way a terminal shows them.
 */
export function runLocalCommand(
  command: string,
  options?: ExecOpts,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let dropped = 0;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_CAP) {
        const head = output.slice(0, OUTPUT_CAP / 4);
        dropped += output.length - OUTPUT_CAP;
        output = head + output.slice(-(OUTPUT_CAP - head.length));
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let stopped: "timeout" | "cancelled" | undefined;
    const stop = (reason: "timeout" | "cancelled") => {
      if (stopped || child.exitCode !== null) return;
      stopped = reason;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(
      () => stop("timeout"),
      (options?.timeout ?? 120) * 1000,
    );
    const onAbort = () => stop("cancelled");
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) onAbort();
    const finish = (exitCode: number, note?: string) => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      const omitted = dropped ? `\n[… ${dropped} characters omitted …]` : "";
      resolve({
        exitCode,
        result: `${output}${omitted}${note ? `\n${note}` : ""}`,
      });
    };
    child.on("error", (error) => finish(127, error.message));
    child.on("close", (code, signal) => {
      if (stopped === "timeout")
        finish(
          124,
          `Command timed out after ${options?.timeout ?? 120}s and was stopped.`,
        );
      else if (stopped === "cancelled") finish(130, "Command was cancelled.");
      else finish(code ?? (signal ? 128 : 1));
    });
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}
