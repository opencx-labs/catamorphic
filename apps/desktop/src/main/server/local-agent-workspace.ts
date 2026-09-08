import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SandboxProvider } from "@catamorphic/sandbox";

const execute = promisify(execFile);

/** Trusted desktop workspace IO. It operates on the assigned checkout, without a copied sandbox. */
export const localAgentWorkspace: Pick<
  SandboxProvider,
  "executeCommand" | "uploadFiles" | "downloadFile"
> = {
  async executeCommand(_id, command, options) {
    try {
      const result = await execute(
        process.env.SHELL || "/bin/sh",
        ["-lc", command],
        {
          cwd: options?.cwd,
          env: { ...process.env, ...options?.env },
          timeout: (options?.timeout ?? 120) * 1000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return { exitCode: 0, result: result.stdout + result.stderr };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const stdout =
        "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "";
      const stderr =
        "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : error.message;
      return {
        exitCode:
          "code" in error && typeof error.code === "number" ? error.code : 1,
        result: stdout + stderr,
      };
    }
  },
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
