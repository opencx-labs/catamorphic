import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolRuntime } from "./tool-runtime.js";

const execute = promisify(execFile);

/** Electron's package entry repairs a missing binary; electron-vite bypasses it. */
export async function prepareDesktopRuntime({
  rootPath,
  runtime,
  signal,
}: {
  rootPath: string;
  runtime: ToolRuntime;
  signal?: AbortSignal;
}): Promise<void> {
  const require = createRequire(
    path.join(rootPath, "apps/desktop/package.json"),
  );
  const entry = require.resolve("electron");
  try {
    const { stdout } = await execute(
      runtime.nodePath,
      ["-e", "require(process.argv[1])", entry],
      { cwd: rootPath, env: runtime.env, signal, timeout: 120_000 },
    );
    if (stdout.trim()) process.stdout.write(stdout);
  } catch (cause) {
    throw new Error(
      "Could not prepare the pinned Electron runtime. Check network access and rerun bun run dev:desktop.",
      { cause },
    );
  }
}
