import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { JsonObject } from "@catamorphic/agent-protocol";

/** How the adapter starts one `codex app-server` process. */
export interface CodexSpawn {
  command: string;
  args: string[];
  /**
   * The environment the adapter sets. The process transport adds it over
   * the runner's own environment; a replay transport compares it.
   */
  env: Record<string, string>;
  cwd: string;
}

export interface CodexExit {
  code: number | null;
  signal: string | null;
  /** The process's last standard error, for diagnostics. */
  stderr: string;
}

/** One app-server process as the JSON-RPC client sees it: lines in, lines out. */
export interface CodexTransport {
  send(message: JsonObject): void;
  /** End input and stop the process; `onExit` still reports when it is gone. */
  close(): void;
}

/**
 * Starts the app server. The adapter uses {@link processTransport}; tests
 * pass a replay peer (`@catamorphic/codex/testing`) that serves a recorded
 * transcript instead of a process.
 */
export type CodexTransportFactory = (
  input: CodexSpawn & {
    onMessage: (message: JsonObject) => void;
    onExit: (exit: CodexExit) => void;
  },
) => CodexTransport;

const STDERR_TAIL = 4_000;

/**
 * The real `codex app-server` as a child process. Closing ends its input
 * first so Codex flushes its rollout, then signals it if it lingers.
 */
export const processTransport: CodexTransportFactory = (input) => {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let exited = false;
  const exit = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    input.onExit({ code, signal, stderr });
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`.slice(-STDERR_TAIL);
    exit(null, null);
  });
  child.on("exit", (code, signal) => exit(code, signal));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message)
    )
      input.onMessage(message as JsonObject);
  });
  return {
    send: (message) => {
      if (!exited && child.stdin.writable)
        child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    close: () => {
      if (exited) return;
      child.stdin.end();
      const term = setTimeout(() => {
        if (!exited) child.kill("SIGTERM");
      }, 2_000);
      const kill = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 4_000);
      term.unref();
      kill.unref();
      child.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
      });
    },
  };
};
