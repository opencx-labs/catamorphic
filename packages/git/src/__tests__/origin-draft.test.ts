import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { draftRef } from "@catamorphic/workflow/project-layout";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapObject } from "../git-object-codec.js";
import { fetchObject, push } from "../git-sync.js";
import { InMemoryObjectStore } from "../in-memory-object-store.js";
import {
  FsBackend,
  FsRemoteBackend,
  OriginDraftRepo,
  ProjectManager,
  RefMovedError,
  type RemoteBackend,
} from "../index.js";
import { ObjectRemoteBackend } from "../object-remote-backend.js";
import {
  GitObjectCache,
  OriginObjects,
  serializeTree,
} from "../origin-objects.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

describe("tree serialization", () => {
  it("orders and encodes entries exactly as git does", async () => {
    const blob = wrapObject({
      type: "blob",
      data: new TextEncoder().encode("x"),
    }).sha;
    const tree = wrapObject({ type: "tree", data: new Uint8Array() }).sha;
    const entries = [
      { mode: "100644", name: "a.b", oid: blob },
      { mode: "40000", name: "a", oid: tree },
      { mode: "100755", name: "a-b", oid: blob },
      { mode: "120000", name: "link", oid: blob },
      { mode: "100644", name: "A", oid: blob },
    ];
    const ours = wrapObject({ type: "tree", data: serializeTree(entries) });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-order-"));
    try {
      await git.init({ fs: nodeFs, dir });
      const theirs = await git.writeTree({
        fs: nodeFs,
        dir,
        tree: entries.map((entry) => ({
          mode: entry.mode === "40000" ? "040000" : entry.mode,
          path: entry.name,
          oid: entry.oid,
          type: entry.mode === "40000" ? "tree" : "blob",
        })),
      });
      expect(ours.sha).toBe(theirs);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

for (const [label, makeOrigin] of [
  [
    "object store",
    () => new ObjectRemoteBackend({ store: new InMemoryObjectStore() }),
  ],
  [
    "bare repository",
    (dir: string) => new FsRemoteBackend(path.join(dir, "origin")),
  ],
] as const) {
  describe(`OriginDraftRepo over a ${label}`, () => {
    let dir: string;
    let origin: RemoteBackend;
    let manager: ProjectManager;

    const draft = async (externalUserId = "alice") => {
      const opened = await manager.openDraft({
        tenantId: TENANT,
        projectId: PROJECT,
        externalUserId,
      });
      if (!(opened instanceof OriginDraftRepo)) throw new Error("Not a draft");
      return opened;
    };

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "origin-draft-"));
      origin = makeOrigin(dir);
      manager = new ProjectManager(
        new FsBackend(path.join(dir, "copies")),
        origin,
      );
      const created = await manager.create(TENANT, PROJECT, {
        name: "drafts",
        initialFiles: {
          "bin/run.sh": "#!/bin/sh\n",
          "docs/a.md": "a",
          "docs/nested/b.md": "b",
        },
      });
      await created.dispose();
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("writes valid git objects a real checkout reads back", async () => {
      const alice = await draft();
      await alice.write({
        changes: [
          { path: "docs/a.md", content: "a2" },
          { path: "docs/nested/deeper/c.md", content: "c" },
          { path: "docs/nested/b.md", delete: true },
          { path: "./src//index.ts", content: "export {};\n" },
        ],
        message: "Edit docs",
      });
      const tip = await alice.resolveRef("HEAD");
      const checkout = await manager.openEphemeral({
        tenantId: TENANT,
        projectId: PROJECT,
      });
      try {
        await fetchObject({
          dev: checkout,
          remote: origin,
          tenantId: TENANT,
          projectId: PROJECT,
          sha: tip,
        });
        await git.checkout({
          fs: nodeFs,
          dir: checkout.repoPath,
          ref: tip,
          force: true,
        });
        expect(await checkout.readAllFilesAtRef(tip)).toEqual(
          await alice.readAllFiles(),
        );
        const files = await alice.readAllFiles();
        expect(files["docs/a.md"]).toBe("a2");
        expect(files["docs/nested/deeper/c.md"]).toBe("c");
        expect(files["src/index.ts"]).toBe("export {};\n");
        expect(files["docs/nested/b.md"]).toBeUndefined();
        const [commit] = await git.log({
          fs: nodeFs,
          dir: checkout.repoPath,
          ref: tip,
          depth: 1,
        });
        expect(commit?.commit.message).toBe("Edit docs\n");
      } finally {
        await checkout.dispose();
      }
    });

    it("keeps a file's mode when its content changes", async () => {
      const seed = await manager.openEphemeral({
        tenantId: TENANT,
        projectId: PROJECT,
      });
      try {
        await fs.chmod(path.join(seed.repoPath, "bin/run.sh"), 0o755);
        await seed.commit("Executable", { name: "t", email: "t@test.dev" });
        await push({
          dev: seed,
          remote: origin,
          tenantId: TENANT,
          projectId: PROJECT,
        });
      } finally {
        await seed.dispose();
      }
      const alice = await draft();
      await alice.writeFile("bin/run.sh", "#!/bin/sh\necho hi\n");
      const tip = await alice.resolveRef("HEAD");
      const mode = await origin.withOrigin(TENANT, PROJECT, async (repo) => {
        const objects = new OriginObjects(repo, new GitObjectCache());
        const entry = await objects.entry(
          (await objects.commit(tip)).tree,
          "bin/run.sh",
        );
        return entry?.mode;
      });
      expect(mode).toBe("100755");
      expect(await alice.readFile("bin/run.sh")).toBe("#!/bin/sh\necho hi\n");
    });

    it("refuses unsafe paths and reports filesystem-like errors", async () => {
      const alice = await draft();
      await expect(alice.writeFile(".git/config", "x")).rejects.toThrow(".git");
      await expect(alice.writeFile("../escape", "x")).rejects.toThrow(
        "traversal",
      );
      await expect(alice.writeFile("docs/a.md/x", "x")).rejects.toMatchObject({
        code: "ENOTDIR",
      });
      await expect(alice.writeFile("docs", "x")).rejects.toMatchObject({
        code: "EISDIR",
      });
      await expect(alice.deleteFile("missing.md")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(alice.readFile("missing.md")).rejects.toMatchObject({
        code: "ENOENT",
      });
      // Nothing above created a draft.
      await origin.withOrigin(TENANT, PROJECT, async (repo) =>
        expect(await repo.resolveRef(draftRef("alice"))).toBeNull(),
      );
    });

    it("counts what each side lacks since the histories met", async () => {
      const alice = await draft("alice");
      await alice.writeFile("alice-1.md", "1");
      await alice.writeFile("alice-2.md", "2");
      const bob = await draft("bob");
      await bob.writeFile("bob.md", "b");
      await bob.publish({
        message: "Bob",
        author: { name: "bob", email: "bob@test.dev" },
      });
      expect(await alice.status()).toMatchObject({
        dirty: true,
        ahead: 2,
        behind: 1,
        modifiedFiles: ["alice-1.md", "alice-2.md"],
      });
      const pulled = await alice.pull();
      expect(pulled.status).toBe("clean");
      expect(await alice.status()).toMatchObject({
        behind: 0,
        modifiedFiles: ["alice-1.md", "alice-2.md"],
      });
      expect(await alice.readFile("bob.md")).toBe("b");
    });

    it("never deletes a draft that moved since it was read", async () => {
      const alice = await draft();
      await alice.writeFile("one.md", "1");
      const read = await alice.resolveRef("HEAD");
      await alice.writeFile("two.md", "2");
      await origin.withOrigin(TENANT, PROJECT, async (repo) => {
        await expect(
          repo.deleteRef({ ref: alice.ref, expected: read }),
        ).rejects.toBeInstanceOf(RefMovedError);
        expect(await repo.resolveRef(alice.ref)).not.toBe(read);
      });
    });

    it("moves the draft with compare-and-swap under concurrent writers", async () => {
      const writers = await Promise.all(
        Array.from({ length: 5 }, () => draft()),
      );
      await Promise.all(
        writers.map((writer, i) => writer.writeFile(`w/${i}.md`, `${i}`)),
      );
      expect(await (await draft()).listFiles({ prefix: "w" })).toEqual([
        "w/0.md",
        "w/1.md",
        "w/2.md",
        "w/3.md",
        "w/4.md",
      ]);
    });
  });
}
