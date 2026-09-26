import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeComposerFiles, saveComposerFile } from "./composer-files.js";

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
    const attachmentsDir = await temp();
    const bytes = new Uint8Array([0, 137, 80, 255, 0]);
    const input = {
      attachmentsDir,
      projectId: "project-1",
      name: "../../Screenshot.png",
      bytes,
    };
    const first = await saveComposerFile(input);
    const second = await saveComposerFile(input);
    expect(first.path).not.toBe(second.path);
    expect(path.relative(attachmentsDir, first.path)).toMatch(
      /^project-1\/[0-9a-f-]+-\.\._\.\._Screenshot\.png$/,
    );
    expect(new Uint8Array(await readFile(first.path))).toEqual(bytes);
    const empty = await saveComposerFile({
      attachmentsDir,
      projectId: "project-1",
      name: "empty.txt",
      bytes: new Uint8Array(),
    });
    expect((await readFile(empty.path)).length).toBe(0);
  });
  it("keeps pastes out of any project folder and drops them with the project", async () => {
    const attachmentsDir = await temp();
    const saved = await saveComposerFile({
      attachmentsDir,
      projectId: "project-2",
      name: "shot.png",
      bytes: new Uint8Array([1]),
    });
    expect(saved.path.startsWith(`${attachmentsDir}${path.sep}`)).toBe(true);
    await removeComposerFiles({ attachmentsDir, projectId: "project-2" });
    await expect(stat(saved.path)).rejects.toThrow();
  });
  it("rejects a project id that would leave the attachments directory", async () => {
    const attachmentsDir = await temp();
    await expect(
      saveComposerFile({
        attachmentsDir,
        projectId: "../outside",
        name: "shot.png",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("Invalid project");
  });
});
