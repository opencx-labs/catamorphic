import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveComposerFile } from "./composer-files.js";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "composer-files-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("clipboard file persistence", () => {
  it("preserves binary bytes and empty files, sanitizes names, and never overwrites a previous paste", async () => {
    const rootPath = await temp();
    const bytes = new Uint8Array([0, 137, 80, 255, 0]);
    const input = { rootPath, name: "../../Screenshot.png", bytes };
    const first = await saveComposerFile(input);
    const second = await saveComposerFile(input);
    expect(first.path).not.toBe(second.path);
    expect(path.relative(await realpath(rootPath), first.path)).toMatch(
      /^\.catamorphic\/attachments\//,
    );
    expect(new Uint8Array(await readFile(first.path))).toEqual(bytes);
    const empty = await saveComposerFile({
      rootPath,
      name: "empty.txt",
      bytes: new Uint8Array(),
    });
    expect((await readFile(empty.path)).length).toBe(0);
  });
  it("rejects an attachment directory that points outside the project", async () => {
    const rootPath = await temp();
    await symlink(await temp(), path.join(rootPath, ".catamorphic"));
    await expect(
      saveComposerFile({
        rootPath,
        name: "shot.png",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("inside the project");
  });
});
