import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { ProjectRootsStore } from "./project-roots.js";

it("registers before creation, deduplicates aliases and keeps borrowed files after failure", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "project-roots-"));
  const database = new PGlite();
  try {
    const store = new ProjectRootsStore(database);
    await store.init();
    const root = path.join(temporary, "repo");
    await fs.mkdir(root);
    await nativeGit(root, ["init", "-b", "feature"]);
    await fs.writeFile(path.join(root, "private.txt"), "draft");
    const create = async (id: string, canonical: string) => {
      expect(store.getSync(id)).toBe(canonical);
      expect(store.checkpointsEnabled(id)).toBe(false);
      return id;
    };
    const reopen = async (id: string) => id;
    const first = await store.register({
      rootPath: root,
      existing: true,
      create,
      reopen,
    });
    const alias = path.join(temporary, "alias");
    await fs.symlink(root, alias);
    expect(
      await store.register({
        rootPath: alias,
        existing: true,
        create: async () => {
          throw new Error("duplicate");
        },
        reopen,
      }),
    ).toBe(first);
    const second = path.join(temporary, "failed");
    await fs.mkdir(second);
    await nativeGit(second, ["init", "-b", "main"]);
    await fs.writeFile(path.join(second, "notes.md"), "keep");
    let failedId = "";
    await expect(
      store.register({
        rootPath: second,
        existing: true,
        reopen,
        create: async (id) => {
          failedId = id;
          throw new Error("failed provisioning");
        },
      }),
    ).rejects.toThrow("failed provisioning");
    expect(await store.get(failedId)).toBeNull();
    expect(await fs.readFile(path.join(second, "notes.md"), "utf8")).toBe(
      "keep",
    );
    expect(await fs.readFile(path.join(root, "private.txt"), "utf8")).toBe(
      "draft",
    );
  } finally {
    await database.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

it("relocates only projects inside the copied development profile", async () => {
  const database = new PGlite();
  try {
    const store = new ProjectRootsStore(database);
    await store.init();
    const internal = crypto.randomUUID();
    const external = crypto.randomUUID();
    const neighbor = crypto.randomUUID();
    await store.set(internal, "/tmp/old/desktop/Catamorphic/project");
    await store.set(external, "/Users/test/my-project");
    await store.set(neighbor, "/tmp/old/desktop-other/project");
    const reopened = new ProjectRootsStore(database);
    await reopened.init({
      from: "/tmp/old/desktop",
      to: "/Users/test/.catamorphic/dev/desktop",
    });
    expect(reopened.getSync(internal)).toBe(
      "/Users/test/.catamorphic/dev/desktop/Catamorphic/project",
    );
    expect(reopened.getSync(external)).toBe("/Users/test/my-project");
    expect(reopened.getSync(neighbor)).toBe("/tmp/old/desktop-other/project");
  } finally {
    await database.close();
  }
});
