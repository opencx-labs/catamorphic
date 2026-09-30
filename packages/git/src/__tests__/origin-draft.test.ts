import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { draftRef } from "@catamorphic/workflow/project-layout";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapObject } from "../git-object-codec.js";
import { push } from "../git-sync.js";
import { InMemoryObjectStore } from "../in-memory-object-store.js";
import {
  DraftIgnoredPathError,
  DraftRefNotAllowedError,
  DraftsUnsupportedError,
  FsBackend,
  FsRemoteBackend,
  InvalidRefNameError,
  isValidRefName,
  OriginDraftRepo,
  PreconditionFailedError,
  ProjectManager,
  RefMovedError,
  type RemoteBackend,
} from "../index.js";
import {
  ObjectRemoteBackend,
  probeConditionalWrites,
} from "../object-remote-backend.js";
import type { ObjectStore } from "../object-store.js";
import {
  GitObjectCache,
  OriginObjects,
  parseTree,
  serializeTree,
} from "../origin-objects.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const bytes = (text: string) => new TextEncoder().encode(text);

describe("tree serialization", () => {
  it("orders and encodes entries exactly as git does", async () => {
    const blob = wrapObject({ type: "blob", data: bytes("x") }).sha;
    const tree = wrapObject({ type: "tree", data: new Uint8Array() }).sha;
    const entries = [
      { mode: "100644", name: "a.b", oid: blob },
      { mode: "40000", name: "a", oid: tree },
      { mode: "100755", name: "a-b", oid: blob },
      { mode: "120000", name: "link", oid: blob },
      { mode: "100644", name: "A", oid: blob },
    ];
    const ours = wrapObject({
      type: "tree",
      data: serializeTree(
        entries.map((entry) => ({ ...entry, nameBytes: bytes(entry.name) })),
      ),
    });
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

  it("keeps names that are not UTF-8 byte for byte", () => {
    const blob = wrapObject({ type: "blob", data: bytes("x") }).sha;
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const data = serializeTree([
      { mode: "100644", name: "ignored", nameBytes: latin1, oid: blob },
    ]);
    const [entry] = parseTree(data);
    expect(entry?.nameBytes).toEqual(latin1);
    expect(serializeTree(parseTree(data))).toEqual(data);
  });
});

describe("ref names", () => {
  it("follows git's rules", () => {
    for (const ok of ["main", "refs/heads/main", "work/a-b_c", "v1.0"])
      expect(isValidRefName(ok), ok).toBe(true);
    for (const bad of [
      "",
      "../work/drafts/bob",
      "refs/heads/../work/drafts/bob",
      "refs//heads",
      ".hidden",
      "refs/heads/.x",
      "a/",
      "a.",
      "main@{1}",
      "@",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[",
      "a\\b",
      "x.lock",
      "a\u0001b",
    ])
      expect(isValidRefName(bad), bad).toBe(false);
  });
});

describe("store conformance probe", () => {
  it("passes a store that enforces conditional writes", async () => {
    expect(
      await probeConditionalWrites({
        store: new InMemoryObjectStore(),
        key: "conformance/x",
      }),
    ).toBeNull();
  });

  it("refuses drafts on a store that ignores If-Match on deletes", async () => {
    const inner = new InMemoryObjectStore();
    const lax: ObjectStore = {
      get: (key) => inner.get(key),
      has: (key) => inner.has(key),
      put: (key, data, opts) => inner.put(key, data, opts),
      list: (prefix) => inner.list(prefix),
      delete: (key) => inner.delete(key),
      deletePrefix: (prefix) => inner.deletePrefix(prefix),
    };
    expect(
      await probeConditionalWrites({ store: lax, key: "conformance/x" }),
    ).toContain("If-Match on deletes");
    expect(await inner.has("conformance/x")).toBe(false);
    const manager = new ProjectManager(
      new FsBackend(await fs.mkdtemp(path.join(os.tmpdir(), "lax-"))),
      new ObjectRemoteBackend({ store: lax }),
    );
    await expect(
      manager.openDraft({
        tenantId: TENANT,
        projectId: PROJECT,
        externalUserId: "alice",
      }),
    ).rejects.toBeInstanceOf(DraftsUnsupportedError);
  });

  it("the in-memory store refuses a stale conditional delete", async () => {
    const store = new InMemoryObjectStore();
    await store.put("k", bytes("v"));
    await expect(
      store.delete("k", { ifMatch: '"nope"' }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
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
    const publish = async (member: string, message: string) =>
      (await draft(member)).publish({
        message,
        author: { name: member, email: `${member}@test.dev` },
      });

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
          "docs/lines.md": "one\ntwo\nthree\nfour\nfive\n",
        },
      });
      await created.dispose();
    });

    afterEach(async () => {
      vi.useRealTimers();
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
      const files = await alice.readAllFiles();
      expect(files["docs/a.md"]).toBe("a2");
      expect(files["docs/nested/deeper/c.md"]).toBe("c");
      expect(files["src/index.ts"]).toBe("export {};\n");
      expect(files["docs/nested/b.md"]).toBeUndefined();
      expect((await publish("alice", "Edit docs")).status).toBe("deployed");
      const checkout = await manager.openEphemeral({
        tenantId: TENANT,
        projectId: PROJECT,
      });
      try {
        expect(await checkout.readAllFiles()).toEqual(files);
        const [commit] = await git.log({
          fs: nodeFs,
          dir: checkout.repoPath,
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
        return (
          await objects.entry((await objects.commit(tip)).tree, "bin/run.sh")
        )?.mode;
      });
      expect(mode).toBe("100755");
    });

    it("refuses unsafe paths and reports filesystem-like errors", async () => {
      const alice = await draft();
      await expect(alice.writeFile(".git/config", "x")).rejects.toThrow(".git");
      await expect(alice.writeFile("../escape", "x")).rejects.toThrow(
        "traversal",
      );
      await expect(
        alice.writeFile("/.work/roles/admin.json", "{}"),
      ).rejects.toThrow("Absolute paths not allowed");
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

    it("keeps ignored paths out of the program, as a checkout commit did", async () => {
      const alice = await draft();
      await expect(
        alice.writeFile(".work/app-data/store/notes.md", "x"),
      ).rejects.toBeInstanceOf(DraftIgnoredPathError);
      await expect(
        alice.writeFile("web/node_modules/x/index.js", "x"),
      ).rejects.toBeInstanceOf(DraftIgnoredPathError);
      await alice.write({
        changes: [
          { path: ".work/app-data/store/notes.md", content: "x" },
          { path: "kept.md", content: "kept" },
          { path: "never-there.md", delete: true },
        ],
        skipIgnored: true,
        skipMissingDeletes: true,
      });
      const files = await alice.readAllFiles();
      expect(files["kept.md"]).toBe("kept");
      expect(files[".work/app-data/store/notes.md"]).toBeUndefined();
    });

    it("never resolves another member's draft or a session branch, however spelled", async () => {
      const bob = await draft("bob");
      await bob.writeFile("secret.md", "bob's");
      await origin.withOrigin(TENANT, PROJECT, (repo) =>
        repo.updateRef({
          ref: "refs/heads/sessions/s1",
          sha: "0".repeat(40),
        }),
      );
      const alice = await draft("alice");
      for (const ref of [
        draftRef("bob"),
        "../work/drafts/bob",
        "refs/heads/../work/drafts/bob",
        "refs/work/published/../../work/drafts/bob",
        "work/drafts/../../../refs/work/drafts/bob",
        "sessions/s1",
        "refs/heads/sessions/s1",
        "refs/work/published/sessions/s1",
        "main@{1}",
        ".hidden",
        "refs/tags/v1",
      ]) {
        await expect(alice.resolveRef(ref), ref).rejects.toSatisfy(
          (error) =>
            error instanceof DraftRefNotAllowedError ||
            error instanceof InvalidRefNameError,
        );
        await expect(alice.readAllFilesAtRef(ref), ref).rejects.toBeTruthy();
        await expect(
          alice.diff({ base: "main", head: ref }),
          ref,
        ).rejects.toBeTruthy();
        await expect(alice.log({ ref }), ref).rejects.toBeTruthy();
        await expect(
          alice.readBlobAtRef(ref, "secret.md"),
          ref,
        ).rejects.toBeTruthy();
      }
      expect(await alice.readAllFilesAtRef("main")).not.toHaveProperty(
        "secret.md",
      );
    });

    it("reads one snapshot per open, including its own writes", async () => {
      const reader = await draft();
      expect(await reader.readFile("docs/a.md")).toBe("a");
      await (await draft()).writeFile("docs/a.md", "changed elsewhere");
      expect(await reader.readFile("docs/a.md")).toBe("a");
      await reader.writeFile("docs/mine.md", "mine");
      expect(await reader.readFile("docs/a.md")).toBe("changed elsewhere");
      expect(await (await draft()).readFile("docs/a.md")).toBe(
        "changed elsewhere",
      );
    });

    it("merges edits to different lines of one file in memory", async () => {
      await (await draft("alice")).writeFile(
        "docs/lines.md",
        "ONE\ntwo\nthree\nfour\nfive\n",
      );
      await (await draft("bob")).writeFile(
        "docs/lines.md",
        "one\ntwo\nthree\nfour\nFIVE\n",
      );
      expect((await publish("bob", "Bob")).status).toBe("deployed");
      expect((await publish("alice", "Alice")).status).toBe("deployed");
      expect(await (await draft("reader")).readFile("docs/lines.md")).toBe(
        "ONE\ntwo\nthree\nfour\nFIVE\n",
      );
    });

    it("reports a conflict on the same line and publishes nothing", async () => {
      await (await draft("alice")).writeFile("docs/lines.md", "one\nALICE\n");
      await (await draft("bob")).writeFile("docs/lines.md", "one\nBOB\n");
      await publish("bob", "Bob");
      const result = await publish("alice", "Alice");
      expect(result.status).toBe("conflict");
      expect(result.conflicts).toEqual([
        {
          path: "docs/lines.md",
          base: "one\ntwo\nthree\nfour\nfive\n",
          ours: "one\nALICE\n",
          theirs: "one\nBOB\n",
        },
      ]);
      const alice = await draft("alice");
      await expect(
        alice.resolveConflicts({ resolutions: {}, message: "Resolve" }),
      ).rejects.toThrow("docs/lines.md");
      await alice.resolveConflicts({
        resolutions: { "docs/lines.md": "one\nBOTH\n" },
        message: "Resolve",
      });
      expect((await publish("alice", "Alice")).status).toBe("deployed");
      expect(await (await draft("reader")).readFile("docs/lines.md")).toBe(
        "one\nBOTH\n",
      );
    });

    it("publishes nothing when the merge leaves main as it is", async () => {
      await (await draft("alice")).writeFile("docs/a.md", "same");
      await (await draft("bob")).writeFile("docs/a.md", "same");
      await publish("bob", "Bob");
      const before = await (await draft("reader")).resolveRef("main");
      expect((await publish("alice", "Alice")).status).toBe(
        "nothing-to-deploy",
      );
      expect(await (await draft("reader")).resolveRef("main")).toBe(before);
    });

    it("finds the merge base by the commit graph, not by clocks", async () => {
      // Bob's commit carries a clock earlier than its own parent's.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      await (await draft("bob")).writeFile("bob.md", "bob");
      await publish("bob", "Bob");
      vi.useRealTimers();
      await (await draft("alice")).writeFile("alice.md", "alice");
      await (await draft("carol")).writeFile("carol.md", "carol");
      await publish("carol", "Carol");
      expect(await (await draft("alice")).status()).toMatchObject({
        modifiedFiles: ["alice.md"],
        ahead: 1,
        behind: 1,
      });
    });

    it("merges files published from an older base, and reports conflicts", async () => {
      const base = await (await draft("reader")).resolveRef("main");
      await (await draft("bob")).writeFile(
        "docs/lines.md",
        "one\ntwo\nthree\nfour\nBOB\n",
      );
      await publish("bob", "Bob");
      const clean = await manager.publishFiles({
        tenantId: TENANT,
        projectId: PROJECT,
        base,
        files: { "docs/lines.md": "DESK\ntwo\nthree\nfour\nfive\n" },
        message: "Desktop",
        author: { name: "d", email: "d@test.dev" },
      });
      expect(clean.status).toBe("deployed");
      expect(await (await draft("reader")).readFile("docs/lines.md")).toBe(
        "DESK\ntwo\nthree\nfour\nBOB\n",
      );
      const conflict = await manager.publishFiles({
        tenantId: TENANT,
        projectId: PROJECT,
        base,
        files: { "docs/lines.md": "one\ntwo\nthree\nfour\nDESK\n" },
        message: "Desktop again",
        author: { name: "d", email: "d@test.dev" },
      });
      expect(conflict).toMatchObject({
        status: "conflict",
        conflicts: [expect.objectContaining({ path: "docs/lines.md" })],
      });
    });

    it("counts what each side lacks since the histories met", async () => {
      const alice = await draft("alice");
      await alice.writeFile("alice-1.md", "1");
      await alice.writeFile("alice-2.md", "2");
      await (await draft("bob")).writeFile("bob.md", "b");
      await publish("bob", "Bob");
      expect(await (await draft("alice")).status()).toMatchObject({
        dirty: true,
        ahead: 2,
        behind: 1,
        modifiedFiles: ["alice-1.md", "alice-2.md"],
      });
      expect((await (await draft("alice")).pull()).status).toBe("clean");
      expect(await (await draft("alice")).status()).toMatchObject({
        behind: 0,
        modifiedFiles: ["alice-1.md", "alice-2.md"],
      });
      expect(await (await draft("alice")).readFile("bob.md")).toBe("b");
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

    it("keeps a member's store folder outside any draft", async () => {
      const folder = await manager.draftStoreFolder({
        tenantId: TENANT,
        projectId: PROJECT,
        externalUserId: "alice@example.com",
      });
      expect(folder).toContain(path.join(dir, "copies"));
      expect(nodeFs.existsSync(folder ?? "")).toBe(true);
    });
  });
}
