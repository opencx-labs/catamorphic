import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseSetupRecord,
  planWorkspaceSetup,
  SETUP_LOG_TAIL_LINES,
  type WorkspaceSetupOutcome,
} from "@catamorphic/core";

/**
 * Set up a chat's own worktree on this computer (ADR 0208, 0215), the way
 * a new sandbox workspace is set up: the Environment's `setup`, then the
 * person's own, each run by bash with `-e` under the person's login shell
 * (their PATH and tools) in the worktree. What last succeeded is recorded
 * in `stateDirectory`, the worktree's own Git directory, so it goes with
 * the worktree and a worktree checked out again sets up again. Output is
 * appended to `work-setup.log` there.
 */
export async function runNativeWorkspaceSetup(input: {
  workingDirectory: string;
  stateDirectory: string;
  environment?: string;
  personal?: string;
  personalAllowed: boolean;
  timeoutMinutes: number;
  signal: AbortSignal;
  onRun(): Promise<void>;
  shell?: string;
}): Promise<{ outcome: WorkspaceSetupOutcome; logPath: string }> {
  const logPath = path.join(input.stateDirectory, "work-setup.log");
  const recordPath = path.join(input.stateDirectory, "work-setup.json");
  const plan = planWorkspaceSetup({
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.personal ? { personal: input.personal } : {}),
    personalAllowed: input.personalAllowed,
    recorded: parseSetupRecord(
      await fs.readFile(recordPath, "utf8").catch(() => ""),
    ),
  });
  if (!plan) return { outcome: { status: "current" }, logPath };
  const parts = [
    ...(plan.environment
      ? [
          {
            part: "environment" as const,
            label: "Environment setup",
            command: plan.environment,
          },
        ]
      : []),
    ...(plan.personal
      ? [
          {
            part: "personal" as const,
            label: "Personal setup",
            command: plan.personal,
          },
        ]
      : []),
  ];
  const record = async () =>
    fs.writeFile(recordPath, `${JSON.stringify(plan.record)}\n`);
  if (parts.length === 0) {
    await record();
    return { outcome: { status: "current" }, logPath };
  }
  await input.onRun();
  const scripts = path.join(input.stateDirectory, "work-setup");
  await fs.mkdir(scripts, { recursive: true });
  const log = await fs.open(logPath, "a");
  const deadline = Date.now() + input.timeoutMinutes * 60_000;
  try {
    await log.write(
      `\n== Workspace setup started ${new Date().toISOString()} ==\n`,
    );
    for (const { part, label, command } of parts) {
      const script = path.join(scripts, `${part}.sh`);
      await fs.writeFile(script, `${command}\n`);
      await log.write(`\n-- ${label}\n`);
      const ran = await runPart({
        script,
        workingDirectory: input.workingDirectory,
        logFd: log.fd,
        timeoutMs: Math.max(0, deadline - Date.now()),
        signal: input.signal,
        shell: input.shell,
      });
      if (ran === "aborted") return { outcome: { status: "aborted" }, logPath };
      if (ran.exitCode !== 0 || ran.timedOut) {
        await log.write(
          ran.timedOut
            ? `\n== ${label} did not finish in time ==\n`
            : `\n== ${label} failed with exit code ${ran.exitCode} ==\n`,
        );
        await log.close();
        return {
          outcome: {
            status: "failed",
            exitCode: ran.exitCode,
            timedOut: ran.timedOut,
            log: await tail(logPath),
            parts: parts.map((entry) => entry.part),
          },
          logPath,
        };
      }
    }
    await record();
    await log.write(
      `\n== Workspace setup finished ${new Date().toISOString()} ==\n`,
    );
    return { outcome: { status: "succeeded" }, logPath };
  } finally {
    await log.close().catch(() => undefined);
  }
}

/**
 * One part, as its own process group so a timeout or a stopped turn ends
 * everything it started.
 */
function runPart(input: {
  script: string;
  workingDirectory: string;
  logFd: number;
  timeoutMs: number;
  signal: AbortSignal;
  shell?: string;
}): Promise<{ exitCode: number | null; timedOut: boolean } | "aborted"> {
  if (input.signal.aborted) return Promise.resolve("aborted");
  const shell =
    input.shell ??
    process.env.SHELL ??
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lc", 'exec bash -e "$0"', input.script], {
      cwd: input.workingDirectory,
      env: process.env,
      detached: true,
      stdio: ["ignore", input.logFd, input.logFd],
    });
    let timedOut = false;
    let aborted = false;
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      resolve(aborted ? "aborted" : { exitCode, timedOut });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(timedOut ? null : code));
  });
}

async function tail(logPath: string): Promise<string> {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").slice(-SETUP_LOG_TAIL_LINES).join("\n");
}
