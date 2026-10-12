import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The Electron executable an installed `electron` package names, if present. */
export function installedElectronBinary(
  packagePath: string,
): string | undefined {
  try {
    const executable = readFileSync(path.join(packagePath, "path.txt"), "utf8");
    const binary = path.join(packagePath, "dist", executable);
    return executable && existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Download the desktop's Electron binary when its package has none.
 *
 * Electron 42 and later have no postinstall script: the package downloads its
 * binary the first time `require("electron")` or its CLI runs. electron-vite
 * reads `path.txt` itself instead, so `electron-vite dev` fails with
 * "Electron uninstall" in a fresh install until something else has run.
 */
export function ensureElectronBinary(input: {
  desktopPath: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
}): void {
  // electron-vite launches this instead of the package's binary when it is set.
  if (input.env.ELECTRON_EXEC_PATH) return;
  const packagePath = path.dirname(
    createRequire(path.join(input.desktopPath, "package.json")).resolve(
      "electron/package.json",
    ),
  );
  if (installedElectronBinary(packagePath)) return;
  console.log("Electron's binary is missing; downloading it…");
  const result = spawnSync(
    input.nodePath,
    [path.join(packagePath, "install.js")],
    { cwd: packagePath, env: input.env, stdio: "inherit" },
  );
  if (result.status === 0 && installedElectronBinary(packagePath)) return;
  const outcome = result.error
    ? `could not start (${result.error.message})`
    : result.signal
      ? `stopped on ${result.signal}`
      : result.status === 0
        ? "finished without a binary"
        : `exited with code ${result.status}`;
  throw new Error(
    `Electron's install.js ${outcome} in ${packagePath}; run \`node install.js\` there to retry`,
  );
}
