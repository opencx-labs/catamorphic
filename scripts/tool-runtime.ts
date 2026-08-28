import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const EXPECTED_NODE_VERSION = "v24.13.0";

export interface ToolRuntime {
  nodePath: string;
  env: NodeJS.ProcessEnv & { PATH: string };
}

export function toolRuntime(input: {
  rootPath: string;
  env: NodeJS.ProcessEnv;
}): ToolRuntime {
  const nodePath = path.join(
    input.rootPath,
    "node_modules",
    "node",
    "bin",
    "node",
  );
  const actualVersion = execFileSync(nodePath, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (actualVersion !== EXPECTED_NODE_VERSION) {
    throw new Error(
      `Expected repository Node ${EXPECTED_NODE_VERSION}, received ${actualVersion}`,
    );
  }

  const nodeBinDirectory = path.dirname(nodePath);
  const prefixedPath = input.env.PATH
    ? `${nodeBinDirectory}${path.delimiter}${input.env.PATH}`
    : nodeBinDirectory;

  return {
    nodePath,
    env: { ...input.env, PATH: prefixedPath },
  };
}

if (import.meta.main) {
  const rootPath = path.resolve(import.meta.dirname, "..");
  const runtime = toolRuntime({ rootPath, env: process.env });
  const result = spawnSync(
    runtime.nodePath,
    [
      path.join(rootPath, "node_modules", "vitest", "vitest.mjs"),
      "run",
      ...process.argv.slice(2),
    ],
    {
      cwd: rootPath,
      env: runtime.env,
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}
