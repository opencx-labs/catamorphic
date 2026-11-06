import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * The user-project workspace is `.work/` and its Git-visible names follow it
 * (`@catamorphic/workflow/project-layout`). Catamorphic stays the framework's
 * name, so the old project names must not creep back through code, skills,
 * or docs. History (accepted ADRs, design history) keeps its words.
 */
const root = path.resolve(import.meta.dirname, "..");
const self = path.relative(root, import.meta.filename);

const HISTORY = [
  /^docs\/decisions\//,
  /^docs\/superpowers\//,
  /(^|\/)DESIGN-HISTORY\.md$/,
];

const RETIRED: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "project folder `.catamorphic/` (now `.work/`)",
    pattern: /(?<![\w@?)\]-])\.catamorphic(?![\w.-])/,
  },
  {
    name: "published ref `refs/catamorphic/` (now `refs/work/`)",
    pattern: /refs\/(heads\/)?catamorphic\//,
  },
  {
    name: "app data `catamorphic-app-data` / `CATAMORPHIC_APP_DATA_DIR`",
    pattern: /catamorphic-app-data|CATAMORPHIC_APP_DATA_DIR/,
  },
  {
    name: "checkpoint author `Catamorphic Agent`",
    pattern: /Catamorphic Agent/,
  },
  {
    name: "seeded skill `catamorphic-projects` (now `work-projects`)",
    pattern: /catamorphic-projects/,
  },
  {
    name: "seeded files `Seeded by Catamorphic` (now `Seeded by Work`)",
    pattern: /Seeded by Catamorphic/,
  },
];

/** Host storage, not a project path: `~/.catamorphic/dev` stays. */
const HOST_DEV_STORAGE = /~\/\.catamorphic\/dev|homedir\(\), "\.catamorphic"/;

function scannedFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        file &&
        file !== self &&
        !HISTORY.some((pattern) => pattern.test(file)) &&
        fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
    );
}

it("retired project-layout names do not come back", () => {
  const found: string[] = [];
  for (const file of scannedFiles()) {
    const bytes = fs.readFileSync(path.join(root, file));
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    lines.forEach((line, index) => {
      if (HOST_DEV_STORAGE.test(line)) return;
      for (const { name, pattern } of RETIRED) {
        if (pattern.test(line)) found.push(`${file}:${index + 1}: ${name}`);
      }
    });
  }
  expect(found).toEqual([]);
});
