import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ExecOpts,
  type ExecResult,
  type SandboxProvider,
  shellSandboxProcesses,
} from "@catamorphic/sandbox";
import type { Tool } from "ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAiSdkAdapter } from "../adapter.js";
import {
  runShell,
  type ShellProvider,
  type ShellState,
  shellTools,
  stopBackgroundCommands,
} from "../shell.js";
import { replayModel, replyCall, toolCallsCall } from "../testing/index.js";
import { attemptStart, FakeHost } from "./fake-host.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-processes-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * A sandbox reached through a request/response transport that refuses any
 * one request longer than `ceilingMs`, the way a worker's operation queue
 * or a member runner's jobs do.
 */
function sandbox(args: { ceilingMs: number }): ShellProvider & {
  requests: number[];
} {
  const requests: number[] = [];
  const executeCommand = (
    _id: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const began = Date.now();
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: opts?.cwd ?? root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
        detached: true,
      });
      const refuse = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
        reject(new Error("The transport's request ceiling was exceeded"));
      }, args.ceilingMs);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("close", (code) => {
        clearTimeout(refuse);
        requests.push(Date.now() - began);
        resolve({ exitCode: code ?? 1, result: output });
      });
    });
  return {
    requests,
    executeCommand,
    processes: shellSandboxProcesses({
      executeCommand,
      workspaceRoot: root,
      stateDirectory: path.join(root, ".processes"),
    }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function call(tools: Record<string, Tool>, name: string, input: unknown) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`No tool ${name}`);
  return execute(input, { toolCallId: "call-1", messages: [], context: {} });
}

describe("runShell over sandbox processes (ADR 0174)", () => {
  it("runs a command longer than any one request, within the Environment's budget", async () => {
    // The 20-minute test suite, scaled: the transport refuses requests over
    // 6.5s, the Environment allows 12s, the command takes 7s.
    const provider = sandbox({ ceilingMs: 6_500 });
    const state: ShellState = {};
    const result = await runShell({
      provider,
      sandboxId: "box",
      root,
      state,
      command: "echo started; sleep 7; echo finished; mkdir -p sub; cd sub",
      timeoutMs: 12_000,
      budgetSeconds: 12,
    });
    expect(result).toEqual({ exitCode: 0, output: "started\nfinished" });
    expect(state.cwd).toBe(path.join(root, "sub"));
    expect(Math.max(...provider.requests)).toBeLessThan(6_500);
  }, 30_000);

  it("stops a command that runs past its time, with everything it started", async () => {
    const provider = sandbox({ ceilingMs: 30_000 });
    const pidFile = path.join(root, "timeout.pid");
    const result = await runShell({
      provider,
      sandboxId: "box",
      root,
      state: {},
      command: `sleep 60 & echo $! > ${pidFile}; echo waiting; wait`,
      timeoutMs: 1_000,
      budgetSeconds: 600,
    });
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("waiting");
    expect(result.output).toContain("timed out after 1s and was stopped");
    await expect
      .poll(() => alive(Number(fs.readFileSync(pidFile, "utf8"))))
      .toBe(false);
  }, 30_000);

  it("never waits past the budget, whatever the agent asks", async () => {
    const provider = sandbox({ ceilingMs: 30_000 });
    const started = Date.now();
    const result = await runShell({
      provider,
      sandboxId: "box",
      root,
      state: {},
      command: "sleep 60",
      timeoutMs: 3_600_000,
      budgetSeconds: 1,
    });
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("stops a cancelled command", async () => {
    const provider = sandbox({ ceilingMs: 30_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await runShell({
      provider,
      sandboxId: "box",
      root,
      state: {},
      command: "echo busy; sleep 60",
      signal: controller.signal,
    });
    expect(result).toEqual({
      exitCode: 130,
      output: "busy\nCommand was cancelled.",
    });
  }, 30_000);
});

describe("background command tools", () => {
  it("start, wait for a line, read since the last read, and stop", async () => {
    const provider = sandbox({ ceilingMs: 30_000 });
    const state: ShellState = { cwd: root };
    const tools = shellTools({
      provider,
      sandboxId: "box",
      root: () => root,
      state,
      budgetSeconds: 30,
    });
    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      "read_background_output",
      "run_background_command",
      "stop_background_command",
    ]);
    const started = await call(tools, "run_background_command", {
      command:
        'echo booting; sleep 0.5; echo "ready on 4000"; while true; do echo tick; sleep 0.2; done',
      description: "Start the dev server",
    });
    expect(started).toMatchObject({ status: "running" });
    expect(started.output).toContain("booting");
    const id: string = started.id;

    const waited = await call(tools, "read_background_output", {
      id,
      wait_seconds: 10,
      wait_for: "ticks? \\d+|tick",
    });
    expect(waited).toMatchObject({ status: "running", matched: "tick" });
    expect(waited.output).not.toContain("booting");

    const stopped = await call(tools, "stop_background_command", { id });
    expect(stopped).toMatchObject({ status: "stopped", exitCode: null });
    await expect(
      call(tools, "read_background_output", { id: "proc-0000000000000000" }),
    ).rejects.toThrow("No background command");
    await expect(
      call(tools, "read_background_output", { id, wait_for: "(" }),
    ).rejects.toThrow("not a valid regular expression");
  }, 30_000);

  it("load the session's environment files first, from the project folder (ADRs 0205, 0211)", async () => {
    const provider = sandbox({ ceilingMs: 30_000 });
    const project = path.join(root, "secrets-project");
    const nested = path.join(project, "apps", "api");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, ".work-session", "env"), { recursive: true });
    const gateway = path.join(root, ".work-session", "env", "gateway.sh");
    const file = path.join(root, ".work-session", "env", "secrets.sh");
    fs.writeFileSync(gateway, "export WORK_HTTP_LOGS='http://gateway/logs'\n");
    fs.writeFileSync(file, "export API_KEY='key-from-file'\n");
    // The shell moved below the project folder in an earlier command.
    const state: ShellState = { cwd: nested };
    const tools = shellTools({
      provider,
      sandboxId: "box",
      root: () => project,
      state,
      budgetSeconds: 30,
      envFiles: [
        "../.work-session/env/gateway.sh",
        "../.work-session/env/secrets.sh",
      ],
    });
    const foreground = await call(tools, "bash", {
      command: 'printf "%s|%s|%s" "$API_KEY" "$WORK_HTTP_LOGS" "$PWD"',
    });
    expect(foreground).toEqual({
      exitCode: 0,
      output: `key-from-file|http://gateway/logs|${nested}`,
    });
    const started = await call(tools, "run_background_command", {
      command: 'printf "%s|%s\\n" "$API_KEY" "$PWD"',
      description: "Print the key",
    });
    const read = await call(tools, "read_background_output", {
      id: started.id,
      wait_seconds: 10,
    });
    expect(`${started.output}${read.output}`).toContain(
      `key-from-file|${nested}`,
    );
    // Without a file, commands run as before, with the other one.
    fs.rmSync(file);
    expect(
      await call(tools, "bash", {
        command:
          'if [ -z "$API_KEY" ]; then printf "unset|%s" "$WORK_HTTP_LOGS"; fi',
      }),
    ).toEqual({ exitCode: 0, output: "unset|http://gateway/logs" });
  }, 30_000);

  it("reports a finished command's exit code", async () => {
    const provider = sandbox({ ceilingMs: 30_000 });
    const tools = shellTools({
      provider,
      sandboxId: "box",
      root: () => root,
      state: {},
    });
    const started = await call(tools, "run_background_command", {
      command: "echo building; sleep 4; echo failed >&2; exit 2",
      description: "Build",
    });
    expect(started.status).toBe("running");
    const finished = await call(tools, "read_background_output", {
      id: started.id,
      wait_seconds: 20,
      wait_for: "never printed",
    });
    expect(finished).toEqual({
      status: "finished",
      exitCode: 2,
      output: "failed\n",
    });
  }, 30_000);

  it("offers only bash where the sandbox cannot run processes", () => {
    const tools = shellTools({
      provider: {
        executeCommand: async () => ({ exitCode: 0, result: "" }),
      },
      sandboxId: "box",
      root: () => root,
      state: {},
    });
    expect(Object.keys(tools)).toEqual(["bash"]);
    expect(tools.bash?.description).toContain("when it is available");
  });
});

describe("ai-sdk adapter background commands", () => {
  it("keeps a chat's background commands across turns until the chat stops them", async () => {
    const shell = sandbox({ ceilingMs: 30_000 });
    const pidFile = path.join(root, "server.pid");
    const provider: SandboxProvider = {
      workspaceRoot: root,
      createSandbox: vi.fn(),
      startSandbox: vi.fn(),
      stopSandbox: vi.fn(),
      destroySandbox: vi.fn(),
      getSandboxStatus: vi.fn(),
      executeCommand: shell.executeCommand,
      processes: shell.processes,
      uploadFiles: vi.fn(),
      downloadFile: vi.fn(),
      gitClone: vi.fn(),
      gitCheckout: vi.fn(),
    };
    const replay = replayModel({
      calls: [
        toolCallsCall([
          {
            id: "tool-1",
            name: "run_background_command",
            input: {
              command: `echo $$ > ${pidFile}; exec sleep 300`,
              description: "Start the server",
            },
          },
        ]),
        replyCall("Started."),
      ],
    });
    // The host keeps the chat's shell across attempts.
    const state: ShellState = {};
    const host = new FakeHost({
      adapter: createAiSdkAdapter({ model: replay.model }),
      attempt: attemptStart({
        thread: { mode: "fresh", providerThreadId: "chat-1" },
        workingDirectory: root,
      }),
      local: {
        sandbox: {
          provider,
          sandboxId: "box",
          workingDirectory: root,
          commandBudgetSeconds: 1_800,
        },
        shell: state,
      },
    });
    await host.done;
    const tools = JSON.stringify(replay.calls[0]?.tools ?? []);
    expect(tools).toContain("run_background_command");
    // The Environment's budget reaches the model as bash's ceiling.
    expect(tools).toContain("at most 1800s");
    const started = host
      .of("item.started")
      .find((event) => event.key === "tool:tool-1");
    expect(started?.item).toMatchObject({
      kind: "tool_call",
      tool: "run_background_command",
      description: "Start the server",
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    expect(state.background?.size).toBe(1);
    await stopBackgroundCommands({ provider, sandboxId: "box", state });
    await expect.poll(() => alive(pid)).toBe(false);
  }, 30_000);
});
