import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { executionFiles } from "@catamorphic/parser";
import {
  removeWorkflowPackageDependency,
  resolveWorkflowPackageFallback,
} from "@catamorphic/sandbox";
import {
  PROJECT_PACKAGE_PATH,
  PROJECT_WORKFLOWS_PACKAGE_PATH,
} from "@catamorphic/workflow/project-layout";
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
    expect(relative.startsWith(".work/")).toBe(true);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
    manifest,
  );
  expect(fs.readdirSync(root).sort()).toEqual([".work", "package.json"]);
});

it("creates persistent data without Git and preserves deliberate ignore edits", async () => {
  const data = projectDataDirectory({ root });
  fs.mkdirSync(path.join(data, "catalog"));
  fs.writeFileSync(path.join(data, "catalog", "items.json"), "[]");
  expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  expect(fs.readdirSync(root)).toEqual([".work"]);
  await nativeGit(root, ["init", "-b", "main"]);
  const relative = ".work/app-data/catalog/items.json";
  expect(await nativeGit(root, ["check-ignore", relative])).toContain(relative);
  const ignore = path.join(root, ".work", ".gitignore");
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
    fs.symlinkSync(outside, path.join(root, ".work"));
    expect(() => projectDataDirectory({ root })).toThrow("symbolic link");
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(root, ".work"));
    fs.mkdirSync(path.join(root, ".work"));
    fs.symlinkSync(outside, path.join(root, ".work", "app-data"));
    expect(() => projectDataDirectory({ root })).toThrow("symbolic link");
    expect(fs.readdirSync(outside)).toEqual([]);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it("declares the workflow package at the root for triggers, and no execution install asks a registry for it", async () => {
  const scaffold = workspaceFiles({ name: "capabilities" });
  const devDependencies = (manifest: string | undefined) =>
    Object.keys(JSON.parse(manifest ?? "{}").devDependencies ?? {});
  // Bun installs workspaces isolated: `.work/triggers/` resolves only the
  // root manifest's own dependencies.
  expect(devDependencies(scaffold[PROJECT_PACKAGE_PATH])).toEqual([
    "@catamorphic/parser",
    "@catamorphic/workflow",
  ]);

  const files = executionFiles(scaffold);
  const workflows = files[PROJECT_WORKFLOWS_PACKAGE_PATH];
  // The workflows package keeps its declaration, which selects the host's
  // copy; the install then drops it and uploads that copy instead.
  const fallback = await resolveWorkflowPackageFallback({
    packageJson: workflows,
  });
  expect(fallback?.packageName).toBe("@catamorphic/workflow");
  const installed = {
    ...files,
    [PROJECT_WORKFLOWS_PACKAGE_PATH]: removeWorkflowPackageDependency({
      packageJson: workflows ?? "{}",
    }),
  };
  for (const [file, content] of Object.entries(installed)) {
    if (!file.endsWith("package.json")) continue;
    expect(content, file).not.toContain("@catamorphic/workflow");
    expect(content, file).not.toContain("@catamorphic/parser");
  }
});

it("never publishes mutable data as program files or deploys it with source", () => {
  const dataPath = ".work/app-data/store/private.md";
  const files = executionFiles({
    "package.json": "{}",
    "src/user-code.ts": "export const unrelated = true;",
    [dataPath]: "private",
    ".work/workflows/src/main.ts": "export const source = true;",
  });
  expect(Object.keys(files)).toEqual([".work/workflows/src/main.ts"]);
  const scopes: Array<Identity["scope"]> = [
    undefined,
    [{ kind: "workflow", projectId: "project", name: "*" }],
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
