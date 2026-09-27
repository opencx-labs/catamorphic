import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeUtf8Prefix,
  followProcess,
  OutputWindow,
  type ProcessOutput,
  processReadBounds,
  shellSandboxProcesses,
} from "../processes.js";
import { sandboxCommandLine, spawnInSandbox } from "../sandbox-stdio.js";
import type { ExecOpts, ExecResult } from "../types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-processes-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A sandbox whose commands are host bash, the way a container runs them. */
function hostExecute(
  _sandboxId: string,
  command: string,
  opts?: ExecOpts,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: opts?.cwd ?? root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, result: output }),
    );
  });
}

const processes = shellSandboxProcesses({
  executeCommand: hostExecute,
  workspaceRoot: root,
  stateDirectory: path.join(root, "state"),
});
const sandboxId = "shell";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("shellSandboxProcesses", () => {
  it("starts, reads by cursor, waits, and reports the exit code", async () => {
    const started = await processes.startProcess({
      sandboxId,
      command: 'echo "one $GREETING"; sleep 0.4; echo two; exit 3',
      env: { GREETING: "hé llo" },
      name: "Counting",
    });
    expect(started).toMatchObject({
      status: "running",
      name: "Counting",
      cwd: root,
    });
    const first = await processes.readProcessOutput({
      sandboxId,
      processId: started.processId,
      waitMs: 5_000,
    });
    expect(first.chunk).toBe("one hé llo\n");
    expect(first.nextCursor).toBe(Buffer.byteLength("one hé llo\n"));
    const rest = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: first.nextCursor,
      timeoutMs: 10_000,
    });
    expect(rest).toMatchObject({
      output: "two\n",
      status: "exited",
      exitCode: 3,
      timedOut: false,
    });
    const [listed] = (await processes.listProcesses({ sandboxId })).filter(
      (entry) => entry.processId === started.processId,
    );
    expect(listed).toMatchObject({ status: "exited", exitCode: 3 });
    expect(listed?.endedAt).not.toBeNull();
    // The environment never stays behind on disk.
    expect(
      fs.readdirSync(path.join(root, "state", started.processId)).sort(),
    ).toEqual(["boot", "ended", "exit", "meta.json", "output", "pid"]);
  }, 20_000);

  it("waits for a line, then stops the whole process group", async () => {
    const pidFile = path.join(root, "grandchild.pid");
    const started = await processes.startProcess({
      sandboxId,
      command: `sleep 300 & echo $! > ${pidFile}; sleep 0.3; echo "ready on 4000"; wait`,
    });
    const ready = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      until: /ready on \d+/,
      timeoutMs: 10_000,
    });
    expect(ready).toMatchObject({
      matched: "ready on 4000",
      status: "running",
    });
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    await processes.signalProcess({
      sandboxId,
      processId: started.processId,
      signal: "SIGTERM",
    });
    const ended = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: ready.cursor,
      timeoutMs: 10_000,
    });
    expect(ended).toMatchObject({
      status: "exited",
      exitCode: null,
      signal: "SIGTERM",
    });
    await expect.poll(() => alive(grandchild)).toBe(false);
  }, 20_000);

  it("times out a follow without stopping the process", async () => {
    const started = await processes.startProcess({
      sandboxId,
      command: "sleep 30",
    });
    const followed = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      timeoutMs: 300,
    });
    expect(followed).toMatchObject({ timedOut: true, status: "running" });
    const killed = await processes.signalProcess({
      sandboxId,
      processId: started.processId,
      signal: "SIGKILL",
    });
    expect(killed.signal).toBe("SIGKILL");
    await expect
      .poll(
        async () =>
          (
            await processes.readProcessOutput({
              sandboxId,
              processId: started.processId,
            })
          ).status,
      )
      .toBe("exited");
  }, 20_000);

  it("pages large output and rejects foreign ids", async () => {
    const started = await processes.startProcess({
      sandboxId,
      command: "head -c 150000 /dev/zero | tr '\\0' x",
    });
    await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      timeoutMs: 10_000,
    });
    const page = await processes.readProcessOutput({
      sandboxId,
      processId: started.processId,
      maxBytes: 100_000,
    });
    expect(page).toMatchObject({ nextCursor: 100_000, more: true });
    const next = await processes.readProcessOutput({
      sandboxId,
      processId: started.processId,
      cursor: page.nextCursor,
      maxBytes: 100_000,
    });
    expect(next).toMatchObject({ nextCursor: 150_000, more: false });
    await expect(
      processes.readProcessOutput({ sandboxId, processId: "../etc" }),
    ).rejects.toThrow("Unknown process");
  }, 20_000);
});

describe("shellSandboxProcesses reads and state", () => {
  it("starts a read inside a character at the next one, and reads at least one character", async () => {
    const started = await processes.startProcess({
      sandboxId,
      command: "printf '😀😀'",
    });
    await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      timeoutMs: 10_000,
    });
    const inside = await processes.readProcessOutput({
      sandboxId,
      processId: started.processId,
      cursor: 1,
    });
    expect(inside).toMatchObject({ chunk: "😀", cursor: 4, nextCursor: 8 });
    const narrow = await processes.readProcessOutput({
      sandboxId,
      processId: started.processId,
      maxBytes: 1,
    });
    expect(narrow).toMatchObject({ chunk: "😀", nextCursor: 4, more: true });
  }, 20_000);

  it("treats a process from an earlier boot as exited, and leaves its group alone", async () => {
    const started = await processes.startProcess({
      sandboxId,
      command: "sleep 30",
    });
    const state = path.join(root, "state", started.processId);
    const pgid = Number(fs.readFileSync(path.join(state, "pid"), "utf8"));
    expect(alive(pgid)).toBe(true);
    // The sandbox restarted: this pgid may now belong to anything.
    fs.writeFileSync(path.join(state, "boot"), "an-earlier-boot");
    const [listed] = (await processes.listProcesses({ sandboxId })).filter(
      (item) => item.processId === started.processId,
    );
    expect(listed?.status).toBe("exited");
    await processes.signalProcess({
      sandboxId,
      processId: started.processId,
      signal: "SIGKILL",
    });
    expect(alive(pgid)).toBe(true);
    process.kill(-pgid, "SIGKILL");
  }, 20_000);
});

describe("followProcess", () => {
  it("times out while output keeps flowing", async () => {
    let cursor = 0;
    const chatty = {
      readProcessOutput: async (): Promise<ProcessOutput> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        cursor += 10;
        return {
          processId: "proc-chatty000",
          chunk: "building\n",
          cursor: cursor - 10,
          nextCursor: cursor,
          more: true,
          outputBytes: cursor + 100,
          status: "running",
          exitCode: null,
          signal: null,
        };
      },
    };
    const started = Date.now();
    const followed = await followProcess({
      processes: chatty,
      sandboxId,
      processId: "proc-chatty000",
      cursor: 0,
      timeoutMs: 300,
    });
    expect(followed.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);

  it("answers a matched line even while more output waits", async () => {
    let cursor = 0;
    const chatty = {
      readProcessOutput: async (): Promise<ProcessOutput> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        cursor += 6;
        return {
          processId: "proc-chatty000",
          chunk: "ready\n",
          cursor: cursor - 6,
          nextCursor: cursor,
          more: true,
          outputBytes: cursor + 100,
          status: "running",
          exitCode: null,
          signal: null,
        };
      },
    };
    const followed = await followProcess({
      processes: chatty,
      sandboxId,
      processId: "proc-chatty000",
      cursor: 0,
      timeoutMs: 300,
      until: /ready/,
    });
    expect(followed).toMatchObject({ matched: "ready", timedOut: false });
  }, 5_000);
});

describe("stdio processes in a sandbox (ADR 0180)", () => {
  it("delivers a large last write before end of file", async () => {
    const started = await processes.startProcess({
      sandboxId,
      // Starts reading late, then a byte at a time: the input waits in the
      // pipe well after the write that ended it returned.
      command:
        'sleep 2; n=0; while IFS= read -r line; do n=$((n+1)); done; echo "lines $n"',
      stdin: true,
    });
    await processes.writeProcessInput({
      sandboxId,
      processId: started.processId,
      data: `${"x".repeat(49)}\n`.repeat(20_000),
      end: true,
    });
    const followed = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      timeoutMs: 60_000,
    });
    expect(followed).toMatchObject({ status: "exited", exitCode: 0 });
    expect(followed.output).toBe("lines 20000\n");
  }, 90_000);

  it("writes input to a process started with stdin, and ends it", async () => {
    const started = await processes.startProcess({
      sandboxId,
      command: 'while read -r line; do echo "got $line"; done; echo eof',
      stdin: true,
    });
    await processes.writeProcessInput({
      sandboxId,
      processId: started.processId,
      data: "one\ntwo\n",
    });
    const first = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: 0,
      timeoutMs: 10_000,
      until: /got two/,
    });
    expect(first.output).toContain("got one\ngot two");
    await processes.writeProcessInput({
      sandboxId,
      processId: started.processId,
      data: "three\n",
      end: true,
    });
    const rest = await followProcess({
      processes,
      sandboxId,
      processId: started.processId,
      cursor: first.cursor,
      timeoutMs: 10_000,
    });
    expect(rest).toMatchObject({ status: "exited", exitCode: 0 });
    expect(rest.output).toContain("got three\neof");
    await expect(
      processes.writeProcessInput({
        sandboxId,
        processId: started.processId,
        data: "late\n",
      }),
    ).rejects.toThrow("input is closed");
  }, 30_000);

  it("runs a stdio command as a child process, errors apart", async () => {
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    fs.writeFileSync(path.join(root, "key"), "the-grant");
    const child = spawnInSandbox({
      processes,
      sandboxId,
      command: "bash",
      args: [
        "-c",
        'while read -r line; do echo "echo:$line:$(cat "$KEY_FILE")"; echo oops >&2; done',
      ],
      cwd: path.join(root, "work"),
      pathEnv: { KEY_FILE: path.join(root, "key") },
      stderrPath: path.join(root, "logs", "child.stderr"),
    });
    const lines: string[] = [];
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      lines.push(...parts);
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    child.stdin.write("hello\n");
    child.stdin.write("world\n");
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(lines).toEqual(["echo:hello:the-grant", "echo:world:the-grant"]);
    expect(
      fs.readFileSync(path.join(root, "logs", "child.stderr"), "utf8"),
    ).toBe("oops\noops\n");
  }, 30_000);

  it("resolves path variables from the working directory, inside the sandbox", () => {
    expect(
      sandboxCommandLine({
        command: "claude",
        args: ["--print", "it's"],
        cwd: "/workspace/project",
        pathEnv: {
          WORK_MODEL_KEY_FILE: "/workspace/.work-session/grants/model",
        },
        stderrPath: "/workspace/.work-session/claude.stderr",
      }),
    ).toBe(
      [
        "mkdir -p ../.work-session",
        'export WORK_MODEL_KEY_FILE="$(cd ../.work-session/grants && pwd -P)"/model',
        "exec claude --print 'it'\\''s' 2>>../.work-session/claude.stderr",
      ].join("\n"),
    );
  });
});

describe("process output helpers", () => {
  it("leaves a split UTF-8 character for the next read", () => {
    const bytes = new TextEncoder().encode("aé");
    expect(decodeUtf8Prefix(bytes.subarray(0, 2), false)).toEqual({
      text: "a",
      bytes: 1,
    });
    expect(decodeUtf8Prefix(bytes, false)).toEqual({ text: "aé", bytes: 3 });
  });

  it("reads at least one whole character", () => {
    expect(
      processReadBounds({ sandboxId, processId: "p", maxBytes: 1 }),
    ).toMatchObject({
      maxBytes: 4,
    });
  });

  it("keeps the start and end of long output", () => {
    const window = new OutputWindow(30);
    window.append("a".repeat(20));
    window.append("b".repeat(40));
    expect(window.toString()).toBe(
      `${"a".repeat(10)}\n[… 30 characters omitted …]\n${"b".repeat(20)}`,
    );
  });
});
