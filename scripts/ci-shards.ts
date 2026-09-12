import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { toolRuntime } from "./tool-runtime.js";

export function shardMatrix(input: {
  files: number;
  filesPerShard: number;
  maxShards: number;
}): { shard: number; total: number }[] {
  const total = Math.max(
    1,
    Math.min(input.maxShards, Math.ceil(input.files / input.filesPerShard)),
  );
  return Array.from({ length: total }, (_, index) => ({
    shard: index + 1,
    total,
  }));
}

/** Vitest discovers files without evaluating tests, starting databases or Electron. */
export function discoverTestFiles(input: {
  root: string;
  cwd: string;
  config: string;
}): number {
  const runtime = toolRuntime({ rootPath: input.root, env: process.env });
  const output = execFileSync(
    runtime.nodePath,
    [
      path.join(input.root, "node_modules/vitest/vitest.mjs"),
      "list",
      "--filesOnly",
      "--json",
      "--config",
      input.config,
    ],
    { cwd: input.cwd, env: runtime.env, encoding: "utf8", timeout: 30_000 },
  );
  const files: unknown = JSON.parse(output);
  if (!Array.isArray(files)) throw new Error("Expected Vitest's file list");
  return files.length;
}

function main(): void {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest: { workspaces: string[] } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const workspaceFiles = globSync(
    manifest.workspaces.map((workspace) => `${workspace}/package.json`),
    { cwd: root },
  ).reduce((total, file) => {
    const workspace: { scripts?: { test?: string } } = JSON.parse(
      readFileSync(path.join(root, file), "utf8"),
    );
    if (!workspace.scripts?.test) return total;
    const cwd = path.dirname(path.join(root, file));
    const localConfig = path.join(cwd, "vitest.config.ts");
    return (
      total +
      discoverTestFiles({
        root,
        cwd,
        config: existsSync(localConfig)
          ? localConfig
          : path.join(root, "vitest.config.ts"),
      })
    );
  }, 0);
  const desktopFiles = discoverTestFiles({
    root,
    cwd: path.join(root, "apps/desktop"),
    config: path.join(root, "apps/desktop/vitest.e2e.config.ts"),
  });
  if (workspaceFiles === 0 || desktopFiles === 0) {
    throw new Error(
      "Expected nonempty workspace and desktop suites; check discovery",
    );
  }
  const matrices = {
    workspace: shardMatrix({
      files: workspaceFiles,
      filesPerShard: 100,
      maxShards: 16,
    }),
    desktop_linux: shardMatrix({
      files: desktopFiles,
      filesPerShard: 5,
      maxShards: 32,
    }),
    desktop_macos: shardMatrix({
      files: desktopFiles,
      filesPerShard: 10,
      maxShards: 16,
    }),
  };
  console.log(
    JSON.stringify({ workspaceFiles, desktopFiles, matrices }, null, 2),
  );
  const githubOutputPath = process.argv[2];
  if (githubOutputPath) {
    appendFileSync(
      githubOutputPath,
      Object.entries(matrices)
        .map(([lane, matrix]) => `${lane}=${JSON.stringify(matrix)}\n`)
        .join(""),
    );
  }
}

if (import.meta.main) main();
