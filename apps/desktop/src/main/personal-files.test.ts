import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createPersonalFile, listPersonalFiles } from "./personal-files.js";

it("creates numbered untitled files in the profile's personal folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "personal-files-"));
  try {
    const create = () =>
      createPersonalFile({ root, profileId: "p1", extension: "md" });
    expect(await create()).toBe(".work/personal/p1/Untitled.md");
    expect(await create()).toBe(".work/personal/p1/Untitled 2.md");
    expect(
      await readFile(path.join(root, ".work/personal/p1/Untitled.md"), "utf8"),
    ).toBe("");
    expect(await listPersonalFiles({ root, profileId: "p1" })).toEqual(
      expect.arrayContaining([
        { path: ".work/personal/p1/Untitled.md" },
        { path: ".work/personal/p1/Untitled 2.md" },
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("never creates through a linked personal folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "personal-files-"));
  const elsewhere = await mkdtemp(path.join(tmpdir(), "personal-elsewhere-"));
  try {
    await mkdir(path.join(root, ".work"));
    await symlink(elsewhere, path.join(root, ".work/personal"));
    await expect(
      createPersonalFile({ root, profileId: "p1", extension: "md" }),
    ).rejects.toThrow("is not a folder");
    await expect(
      createPersonalFile({ root, profileId: "../p1", extension: "md" }),
    ).rejects.toThrow("Invalid profile");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
