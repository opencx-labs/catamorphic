import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ensureElectronBinary,
  installedElectronBinary,
} from "./dev-electron.js";

let root: string;
let desktopPath: string;
let packagePath: string;

/** A stand-in for Electron's install.js that records each run. */
async function writeInstaller(body: string): Promise<void> {
  await writeFile(
    path.join(packagePath, "install.js"),
    `const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "runs"), "run\\n");
${body}
`,
  );
}

const downloadingInstaller = `fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "dist", "electron"), "");
fs.writeFileSync(path.join(__dirname, "path.txt"), "electron");`;

async function installerRuns(): Promise<number> {
  const runs = await readFile(path.join(packagePath, "runs"), "utf8").catch(
    () => "",
  );
  return runs.split("\n").filter(Boolean).length;
}

beforeEach(async () => {
  // Real path: module resolution reports macOS's /private/var, not /var.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "dev-electron-")));
  desktopPath = path.join(root, "apps", "desktop");
  packagePath = path.join(desktopPath, "node_modules", "electron");
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    path.join(desktopPath, "package.json"),
    JSON.stringify({ name: "desktop" }),
  );
  await writeFile(
    path.join(packagePath, "package.json"),
    JSON.stringify({ name: "electron", version: "0.0.0" }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("leaves an installed binary, or one electron-vite is told to use, alone", async () => {
  await writeInstaller(downloadingInstaller);
  const input = { desktopPath, nodePath: process.execPath };
  ensureElectronBinary({ ...input, env: { ELECTRON_EXEC_PATH: "/opt/e" } });
  expect(await installerRuns()).toBe(0);

  await mkdir(path.join(packagePath, "dist"));
  await writeFile(path.join(packagePath, "dist", "electron"), "");
  await writeFile(path.join(packagePath, "path.txt"), "electron");
  ensureElectronBinary({ ...input, env: {} });
  expect(await installerRuns()).toBe(0);
  expect(console.log).not.toHaveBeenCalled();
});

it("downloads a missing binary once, including when path.txt outlived it", async () => {
  await writeInstaller(downloadingInstaller);
  const input = { desktopPath, nodePath: process.execPath, env: {} };
  ensureElectronBinary(input);
  expect(await installerRuns()).toBe(1);
  expect(installedElectronBinary(packagePath)).toBe(
    path.join(packagePath, "dist", "electron"),
  );
  expect(console.log).toHaveBeenCalledWith(
    "Electron's binary is missing; downloading it…",
  );

  ensureElectronBinary(input);
  expect(await installerRuns()).toBe(1);

  await rm(path.join(packagePath, "dist"), { recursive: true });
  ensureElectronBinary(input);
  expect(await installerRuns()).toBe(2);
});

it("fails clearly when the download fails or leaves no binary", async () => {
  const input = { desktopPath, nodePath: process.execPath, env: {} };
  await writeInstaller("process.exit(3);");
  expect(() => ensureElectronBinary(input)).toThrow(
    `Electron's install.js exited with code 3 in ${packagePath}`,
  );

  await writeInstaller("");
  expect(() => ensureElectronBinary(input)).toThrow(
    `Electron's install.js finished without a binary in ${packagePath}`,
  );
  expect(await installerRuns()).toBe(2);
});
