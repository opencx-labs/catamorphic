import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runShell, type ShellState, truncateOutput } from "../shell.js";

const exec = promisify(execFile);
const bash = {
  async executeCommand(
    _id: string,
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ) {
    try {
      const { stdout, stderr } = await exec("bash", ["-c", command], {
        cwd: opts?.cwd,
        timeout: (opts?.timeout ?? 120) * 1000,
      });
      return { exitCode: 0, result: stdout + stderr };
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        result: (failure.stdout ?? "") + (failure.stderr ?? ""),
      };
    }
  },
};

describe("runShell", () => {
  it("keeps the working directory between commands, like a terminal", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "shell-")),
    );
    await fs.mkdir(path.join(root, "app"));
    const state: ShellState = {};
    const run = (command: string) =>
      runShell({ provider: bash, sandboxId: "", root, state, command });

    expect(await run("pwd")).toEqual({ exitCode: 0, output: root });
    await run("cd app");
    expect((await run("pwd")).output).toBe(path.join(root, "app"));
    expect(await run("echo oops >&2; exit 3")).toEqual({
      exitCode: 3,
      output: "oops",
    });
    // A directory that disappears sends the shell back to the project root.
    await fs.rm(path.join(root, "app"), { recursive: true });
    expect((await run("pwd")).output).toBe(root);
  });
});

describe("truncateOutput", () => {
  it("keeps the start and the end, where errors usually are", () => {
    const text = `${"a".repeat(50)}${"b".repeat(50)}END`;
    const kept = truncateOutput(text, 30);
    expect(kept.startsWith("a".repeat(10))).toBe(true);
    expect(kept.endsWith("END")).toBe(true);
    expect(kept).toContain("characters omitted");
  });
});
