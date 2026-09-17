import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { executionFiles } from "@catamorphic/parser";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { workspaceFiles } from "../seeds.js";
import { documentAccessAllowed } from "../services/documents-service.js";
import { projectDataDirectory } from "../services/project-workspace.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-workspace-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("contains the entire scaffold without changing the imported package ecosystem", () => {
  const manifest = '{"name":"existing-app","packageManager":"pnpm@10.0.0"}\n';
  fs.writeFileSync(path.join(root, "package.json"), manifest);
  const scaffold = workspaceFiles({ name: "capabilities" });
  for (const [relative, content] of Object.entries(scaffold)) {
    expect(relative.startsWith(".catamorphic/")).toBe(true);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
    manifest,
  );
  expect(fs.readdirSync(root).sort()).toEqual([".catamorphic", "package.json"]);
});

it("creates persistent data without Git and preserves deliberate ignore edits", async () => {
  const data = projectDataDirectory({ root });
  fs.mkdirSync(path.join(data, "catalog"));
  fs.writeFileSync(path.join(data, "catalog", "items.json"), "[]");
  expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  expect(fs.readdirSync(root)).toEqual([".catamorphic"]);
  await nativeGit(root, ["init", "-b", "main"]);
  const relative = ".catamorphic/app-data/catalog/items.json";
  expect(await nativeGit(root, ["check-ignore", relative])).toContain(relative);
  const ignore = path.join(root, ".catamorphic", ".gitignore");
  fs.writeFileSync(ignore, "node_modules/\ndist/\n");
  expect(projectDataDirectory({ root })).toBe(data);
  expect(fs.readFileSync(ignore, "utf8")).toBe("node_modules/\ndist/\n");
  expect(
    await nativeGit(root, ["ls-files", "--others", "--exclude-standard"]),
  ).toContain(relative);
});

it("does not follow workspace or app-data symlinks", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cat-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, ".catamorphic"));
    expect(() => projectDataDirectory({ root })).toThrow("symbolic link");
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(root, ".catamorphic"));
    fs.mkdirSync(path.join(root, ".catamorphic"));
    fs.symlinkSync(outside, path.join(root, ".catamorphic", "app-data"));
    expect(() => projectDataDirectory({ root })).toThrow("symbolic link");
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it("never publishes mutable data as program files or deploys it with source", () => {
  const dataPath = ".catamorphic/app-data/store/private.md";
  const files = executionFiles({
    "package.json": "{}",
    "src/user-code.ts": "export const unrelated = true;",
    [dataPath]: "private",
    ".catamorphic/workflows/src/main.ts": "export const source = true;",
  });
  expect(Object.keys(files)).toEqual([".catamorphic/workflows/src/main.ts"]);
  const scopes: Array<Identity["scope"]> = [
    undefined,
    [{ kind: "project", projectId: "project" }],
  ];
  for (const scope of scopes) {
    expect(
      documentAccessAllowed(
        { tenantId: "tenant", externalUserId: "user", scope },
        "project",
        dataPath,
        "read",
      ),
    ).toBe(false);
  }
});
