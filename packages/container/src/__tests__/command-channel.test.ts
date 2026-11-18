import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCommandShell } from "@catamorphic/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandChannel,
  type CommandSession,
  startCommandChannel,
} from "../command-channel.js";

/**
 * The shim an agent side uses as its shell and the socket that carries its
 * commands (ADR 0332), with commands run here: what crosses the socket,
 * what the shim leaves behind, and what stops a command.
 */
describe("separated command channel", () => {
  let root: string;
  let channel: CommandChannel;
  let shell: string;
  const sessions: CommandSession[] = [];

  /** Runs a session's command in its own group here, as the provider does in its container. */
  const run = async (session: CommandSession) => {
    sessions.push(session);
    const [file, ...args] = session.request.argv;
    const child: ChildProcess = spawn(file ?? "bash", args, {
      cwd: session.request.cwd,
      env: session.request.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const group = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {}
    };
    session.aborted.addEventListener("abort", () => group("SIGKILL"));
    session.onInput((data) => {
      if (data === null) child.stdin?.end();
      else child.stdin?.write(data);
    });
    session.onSignal((signal) => group(signal));
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (data: Buffer) => session.stdout(data));
    child.stderr?.on("data", (data: Buffer) => session.stderr(data));
    const code = await new Promise<number>((resolve) =>
      child.once("close", (exit, signal) =>
        resolve(exit ?? 128 + (signal === "SIGTERM" ? 15 : 9)),
      ),
    );
    session.exit(code);
  };

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wcc-")));
    channel = await startCommandChannel({
      socketPath: path.join(root, "c.sock"),
      run,
    });
    ({ shell } = await writeCommandShell({
      directory: path.join(root, "agent"),
      socket: channel.socketPath,
      runtime: process.execPath,
    }));
  });

  afterEach(async () => {
    sessions.splice(0);
    await channel.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const shim = (
    args: string[],
    options: { input?: string; env?: NodeJS.ProcessEnv } = {},
  ) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(shell, args, {
          cwd: root,
          env: { ...process.env, ...options.env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        child.stdin.end(options.input ?? "");
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      },
    );

  it("runs the command as bash, with its output, errors, exit code and folder", async () => {
    const ran = await shim(["-c", "echo out; echo err >&2; pwd -P; exit 7"]);
    expect(ran.code).toBe(7);
    expect(ran.stdout).toBe(`out\n${root}\n`);
    expect(ran.stderr).toBe("err\n");
    expect(sessions[0]?.request.argv).toEqual([
      "bash",
      "-c",
      "echo out; echo err >&2; pwd -P; exit 7",
    ]);
  });

  it("passes standard input through and ends it", async () => {
    const ran = await shim(["-c", "cat; echo end"], { input: "hello\n" });
    expect(ran.stdout).toBe("hello\nend\n");
    expect(ran.code).toBe(0);
  });

  it("leaves Work's variables and model keys on the agent side", async () => {
    const ran = await shim(
      [
        "-c",
        'echo "keep=$KEEP model=$WORK_MODEL_API_KEY grant=$WORK_GATEWAY_READ_GRANT openai=$OPENAI_API_KEY anthropic=$ANTHROPIC_BASE_URL"',
      ],
      {
        env: {
          KEEP: "yes",
          WORK_MODEL_API_KEY: "loopback-key",
          WORK_GATEWAY_READ_GRANT: "/workspace/.work-session/read-grant",
          OPENAI_API_KEY: "loopback-key",
          ANTHROPIC_BASE_URL: "http://gateway/model/anthropic",
        },
      },
    );
    expect(ran.stdout).toBe("keep=yes model= grant= openai= anthropic=\n");
  });

  it("sends a signal the shim receives to the command's whole group", async () => {
    const pidFile = path.join(root, "child.pid");
    const child = spawn(shell, [
      "-c",
      `sleep 300 & echo $! > ${pidFile}; wait`,
    ]);
    await waitFor(
      () =>
        fs.existsSync(pidFile) &&
        fs.readFileSync(pidFile, "utf8").trim() !== "",
    );
    const background = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(background)).toBe(true);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) =>
      child.once("close", resolve),
    );
    expect(code).toBe(143);
    await waitFor(() => !alive(background));
  });

  it("stops the command's group when the shim goes away", async () => {
    const pidFile = path.join(root, "child.pid");
    const child = spawn(shell, [
      "-c",
      `sleep 300 & echo $! > ${pidFile}; wait`,
    ]);
    await waitFor(
      () =>
        fs.existsSync(pidFile) &&
        fs.readFileSync(pidFile, "utf8").trim() !== "",
    );
    const background = Number(fs.readFileSync(pidFile, "utf8"));
    child.kill("SIGKILL");
    await waitFor(() => sessions[0]?.aborted.aborted === true);
    await waitFor(() => !alive(background));
  });

  it("says so when the command side cannot be reached", async () => {
    await channel.close();
    const ran = await shim(["-c", "echo never"]);
    expect(ran.code).toBe(126);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(/command container is not reachable/);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
