import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareDesktopRuntime } from "./dev-desktop-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(source: string) {
  const rootPath = await mkdtemp(path.join(tmpdir(), "desktop runtime "));
  roots.push(rootPath);
  const electron = path.join(rootPath, "apps/desktop/node_modules/electron");
  await mkdir(electron, { recursive: true });
  await writeFile(
    path.join(electron, "package.json"),
    JSON.stringify({ name: "electron", main: "index.cjs" }),
  );
  await writeFile(path.join(electron, "index.cjs"), source);
  return {
    rootPath,
    runtime: {
      nodePath: process.execPath,
      env: { PATH: process.env.PATH ?? "" },
    },
  };
}
it("loads this checkout's Electron entry so its own installer can repair missing artifacts", async () => {
  const input = await fixture(`
    const fs = require('node:fs');
    if (!fs.existsSync('runtime-ready')) fs.writeFileSync('runtime-ready', 'installed once');
  `);
  await prepareDesktopRuntime(input);
  await prepareDesktopRuntime(input);
  expect(
    await readFile(path.join(input.rootPath, "runtime-ready"), "utf8"),
  ).toBe("installed once");
});
it("fails startup with actionable context when the pinned installer fails", async () => {
  const input = await fixture("throw new Error('download unavailable')");
  await expect(prepareDesktopRuntime(input)).rejects.toThrow(
    "Could not prepare the pinned Electron runtime",
  );
});
it("honors cancellation before starting the installer", async () => {
  const input = await fixture("process.exit(0)");
  await expect(
    prepareDesktopRuntime({ ...input, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});
