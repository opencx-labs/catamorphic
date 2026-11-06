import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const START = "__WORK_LOGIN_PATH_START__";
const END = "__WORK_LOGIN_PATH_END__";
const TIMEOUT_MS = 5000;

/**
 * The PATH the person's interactive login shell has: where Homebrew, nvm,
 * pyenv, gcloud and other installers add theirs. `printenv` prints the
 * exported, colon-separated value whatever the shell (fish keeps a list),
 * between markers on lines of their own, so whatever a profile prints
 * around them (a banner, a title escape without a newline) is ignored.
 *
 * The shell runs in a session of its own with no terminal and no input,
 * so a profile that asks a question reads end of file. It settles within
 * the timeout whatever the profile does: an interactive shell ignores
 * SIGTERM, and a job a profile leaves running keeps its output open, so
 * the answer is taken as soon as it is printed and the whole process
 * group is killed when time runs out.
 */
export function readLoginShellPath(
  options: { shell?: string; timeoutMs?: number } = {},
): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  const shell =
    options.shell ||
    process.env.SHELL ||
    safeUserShell() ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return new Promise((resolve) => {
    let output = "";
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      resolve(value);
    };
    const answer = () => {
      const lines = output.split(/\r?\n/);
      const start = lines.lastIndexOf(START);
      if (start === -1 || lines[start + 2] !== END) return undefined;
      return lines[start + 1]?.trim() || undefined;
    };
    try {
      child = spawn(
        shell,
        ["-ilc", `printf '\\n${START}\\n'; printenv PATH; printf '${END}\\n'`],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      );
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(
      () => finish(undefined),
      options.timeoutMs ?? TIMEOUT_MS,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(END)) {
        const value = answer();
        if (value !== undefined) finish(value);
      }
    });
    child.on("error", () => finish(undefined));
    child.on("exit", () => {
      // Output can still be in flight; give it a moment past the exit.
      setTimeout(() => finish(answer()), 50);
    });
  });
}

function safeUserShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The login shell's entries and this process's, each once and absolute
 * only (a relative entry would resolve against whatever directory a child
 * starts in). An app started from the Dock or Finder inherits only
 * launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so there the shell's
 * order wins, as in the person's terminal. An app started from a terminal
 * (development, tests) already has someone's PATH: it keeps its order and
 * gains what is missing.
 */
export function mergePaths(input: {
  current: string | undefined;
  login: string | undefined;
  loginFirst: boolean;
}): string {
  const split = (value: string | undefined) =>
    (value ?? "")
      .split(path.delimiter)
      .filter((entry) => path.isAbsolute(entry));
  const [first, second] = input.loginFirst
    ? [split(input.login), split(input.current)]
    : [split(input.current), split(input.login)];
  return [...new Set([...first, ...second])].join(path.delimiter);
}

let loginPath: Promise<string | undefined> | undefined;

/** The login shell's PATH, read once per process. */
export function loginShellPath(): Promise<string | undefined> {
  loginPath ??= readLoginShellPath();
  return loginPath;
}

let adopted: Promise<void> | undefined;

/**
 * Give this process, and so every agent, terminal, MCP server and tool it
 * starts, the person's own PATH: a local agent reaches what their terminal
 * reaches (gh, gcloud, node and npx, psql). Runs once; it settles within
 * the shell timeout and leaves PATH as it was when the shell cannot answer.
 */
export function adoptLoginShellPath(options: {
  packaged: boolean;
}): Promise<void> {
  adopted ??= loginShellPath().then((login) => {
    if (!login) return;
    process.env.PATH = mergePaths({
      current: process.env.PATH,
      login,
      loginFirst: options.packaged,
    });
  });
  return adopted;
}
