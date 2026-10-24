import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { accessBeyond } from "../shared/code-access.js";
import {
  canonicalModuleAccess,
  describeModuleAccess,
  readModuleAccess,
} from "./module-access.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    fs.rmSync(folder, { recursive: true, force: true });
});
function folder() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "module-access-")),
  );
  folders.push(root);
  return root;
}

it("resolves the existing ancestor of a new file before approval", () => {
  const projectRoot = folder();
  const outside = folder();
  fs.symlinkSync(outside, path.join(projectRoot, "output"), "dir");
  const access = canonicalModuleAccess({
    access: { writes: ["output/new/file.json"] },
    projectRoot,
  });
  expect(access.writes).toEqual([path.join(outside, "new/file.json")]);
  expect(
    accessBeyond({ writes: [path.join(projectRoot, "output")] }, access),
  ).toEqual(access);
});

it("asks again after a symlink changes its destination", () => {
  const projectRoot = folder();
  const first = folder();
  const second = folder();
  const link = path.join(projectRoot, "output");
  fs.symlinkSync(first, link, "dir");
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      catamorphic: { access: { writes: ["output"] } },
    }),
  );
  const read = () =>
    readModuleAccess({
      modulePath: path.join(projectRoot, "module.ts"),
      projectRoot,
    }).access;
  const approved = read();
  fs.unlinkSync(link);
  fs.symlinkSync(second, link, "dir");
  expect(approved.writes).toEqual([first]);
  expect(accessBeyond(approved, read())).toEqual({ writes: [second] });
});

it("refuses dangling symlinks and parent traversal", () => {
  const projectRoot = folder();
  fs.symlinkSync(
    path.join(projectRoot, "missing"),
    path.join(projectRoot, "output"),
  );
  expect(() =>
    canonicalModuleAccess({
      access: { writes: ["output/new.json"] },
      projectRoot,
    }),
  ).toThrow("Cannot resolve");
  expect(() =>
    canonicalModuleAccess({
      access: { writes: ["output/../.git/hooks"] },
      projectRoot,
    }),
  ).toThrow("writes name");
});

it("shows project paths and executable-directory warnings for canonical grants", () => {
  const projectRoot = folder();
  const access = canonicalModuleAccess({
    access: { writes: [".git/hooks", "."] },
    projectRoot,
  });
  expect(describeModuleAccess({ access, projectRoot })).toEqual([
    "Change any file in this project (including hooks and settings that run commands as you)",
    "Change .git/hooks (what is there can run commands as you)",
  ]);
});
