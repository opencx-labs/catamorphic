import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads the published dist-only package in Bun, including layout", async () => {
  const root = fileURLToPath(new URL("../packages/parser/", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "parser-package-"));
  const installed = path.join(directory, "node_modules/@catamorphic/parser");
  try {
    await mkdir(installed, { recursive: true });
    // The published package excludes src. Exercise Bun's actual condition
    // resolution against that payload, rather than the monorepo symlink.
    await cp(
      path.join(root, "package.json"),
      path.join(installed, "package.json"),
    );
    await cp(path.join(root, "dist"), path.join(installed, "dist"), {
      recursive: true,
    });
    const metadata = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    for (const name of Object.keys(metadata.dependencies)) {
      await symlink(
        path.join(root, "node_modules", name),
        path.join(directory, "node_modules", name),
      );
    }
    expect(
      execFileSync(
        "bun",
        [
          "-e",
          'await import("@catamorphic/parser"); await import("@catamorphic/parser/layout"); console.log("loaded");',
        ],
        { cwd: directory, encoding: "utf8" },
      ).trim(),
    ).toBe("loaded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
