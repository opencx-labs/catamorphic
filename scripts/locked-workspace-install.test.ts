import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { executionFiles } from "../packages/parser/src/types.js";

it("installs a locked execution snapshot without frontend or dev packages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "execution-install-"));
  const original = path.join(directory, "original");
  const runtime = path.join(directory, "runtime");
  const manifests = {
    "package.json": {
      name: "root",
      private: true,
      workspaces: ["workflows", "contracts", "apps/*"],
      devDependencies: { "dev-tool": "file:vendor/dev-tool" },
    },
    "workflows/package.json": {
      name: "@project/workflows",
      dependencies: {
        "@project/contracts": "workspace:*",
        "runtime-lib": "file:../vendor/runtime-lib",
      },
    },
    "contracts/package.json": { name: "@project/contracts" },
    "apps/dashboard/package.json": {
      name: "dashboard",
      dependencies: { "frontend-lib": "file:../../vendor/frontend-lib" },
    },
    "vendor/dev-tool/package.json": { name: "dev-tool", version: "1.0.0" },
    "vendor/runtime-lib/package.json": {
      name: "runtime-lib",
      version: "1.0.0",
    },
    "vendor/frontend-lib/package.json": {
      name: "frontend-lib",
      version: "1.0.0",
    },
  };
  const files: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(manifests).map(([name, value]) => [
        name,
        JSON.stringify(value),
      ]),
    ),
    "apps/dashboard/src/main.tsx": "export default function App() {}",
  };
  const write = async (root: string, contents: Record<string, string>) => {
    for (const [name, content] of Object.entries(contents)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  };
  try {
    await write(original, files);
    // Only local file dependencies; this test never contacts a registry.
    execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: original,
      stdio: "pipe",
    });
    const lock = await readFile(path.join(original, "bun.lock"), "utf8");
    await write(runtime, executionFiles({ ...files, "bun.lock": lock }));
    execFileSync(
      "bun",
      ["install", "--frozen-lockfile", "--production", "--filter", "!./apps/*"],
      { cwd: runtime, stdio: "pipe" },
    );
    expect(await readFile(path.join(runtime, "bun.lock"), "utf8")).toBe(lock);
    expect(
      existsSync(path.join(runtime, "workflows/node_modules/runtime-lib")),
    ).toBe(true);
    expect(existsSync(path.join(runtime, "node_modules/dev-tool"))).toBe(false);
    expect(
      existsSync(
        path.join(runtime, "apps/dashboard/node_modules/frontend-lib"),
      ),
    ).toBe(false);
    expect(existsSync(path.join(runtime, "apps/dashboard/src/main.tsx"))).toBe(
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
