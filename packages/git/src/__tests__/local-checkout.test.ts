import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutRemoteBackend } from "../checkout-remote-backend.js";
import { FsBackend } from "../fs-backend.js";
import { FsRemoteBackend } from "../fs-remote-backend.js";
import { push } from "../git-sync.js";
import { discoverLocalFolder, nativeGit } from "../native-git.js";
import { NativeProjectRepo } from "../native-project-repo.js";
import { cloneFromRemote } from "../network.js";
import { ProjectManager } from "../project-manager.js";

const tenant = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const project = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const author = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

describe("opening a local repository", () => {
  let temporary: string;
  let root: string;
  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-local-"));
    root = path.join(temporary, "checkout");
    await fs.mkdir(root);
    await nativeGit(root, ["init", "-b", "feature"]);
    await fs.writeFile(path.join(root, "file.txt"), "original");
    await nativeGit(root, ["add", "."]);
    await nativeGit(root, [...author, "commit", "-m", "original"]);
    await nativeGit(root, [
      "remote",
      "add",
      "origin",
      "https://example.com/user/repo.git",
    ]);
    await nativeGit(root, [
      "update-ref",
      "refs/remotes/origin/main",
      (await nativeGit(root, ["rev-parse", "HEAD"])).trim(),
    ]);
    await nativeGit(root, ["repack", "-ad"]);
  });
  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("preserves packed history, staged work, unstaged work, remotes and files without creating an origin", async () => {
    await fs.writeFile(path.join(root, "file.txt"), "staged");
    await nativeGit(root, ["add", "file.txt"]);
    await fs.writeFile(path.join(root, "file.txt"), "unstaged");
    await fs.writeFile(path.join(root, "private.txt"), "private draft");
    const head = await nativeGit(root, ["rev-parse", "HEAD"]);
    const refs = await nativeGit(root, ["show-ref"]);
    const index = await fs.readFile(path.join(root, ".git/index"));
    const config = await fs.readFile(path.join(root, ".git/config"));
    const resolver = async () => root;
    const remoteDirectory = path.join(temporary, "origins");
    const manager = new ProjectManager(
      new FsBackend(path.join(temporary, "internal"), resolver),
      new CheckoutRemoteBackend(resolver, new FsRemoteBackend(remoteDirectory)),
      resolver,
    );
    await manager.create(tenant, project, {
      rootPath: root,
      importExisting: true,
      initialFiles: { "seed.txt": "do not write" },
    });
    expect(await nativeGit(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(await nativeGit(root, ["show-ref"])).toBe(refs);
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(index);
    expect(await fs.readFile(path.join(root, ".git/config"))).toEqual(config);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe(
      "unstaged",
    );
    expect(await fs.readdir(root)).toEqual(
      expect.arrayContaining([".git", "file.txt", "private.txt"]),
    );
    expect(await fs.readdir(root)).toHaveLength(3);
    expect(
      await fs.access(remoteDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("resolves subfolders and linked worktrees without initializing nested repositories", async () => {
    await fs.mkdir(path.join(root, "nested"));
    expect(
      (await discoverLocalFolder({ path: path.join(root, "nested") })).path,
    ).toBe(await fs.realpath(root));
    const worktree = path.join(temporary, "parallel");
    await nativeGit(root, ["worktree", "add", "-b", "parallel", worktree]);
    const primary = await discoverLocalFolder({ path: root });
    const alternate = await discoverLocalFolder({ path: worktree });
    expect(alternate.commonDirectory).toBe(primary.commonDirectory);
    expect(alternate.path).toBe(await fs.realpath(worktree));
    expect(alternate.branch).toBe("parallel");
  });

  it("discards only the selected checkout and preserves private store files", async () => {
    const linked = path.join(temporary, "discard-worktree");
    await nativeGit(root, ["worktree", "add", "-b", "discard", linked]);
    await fs.writeFile(path.join(root, "file.txt"), "primary changes");
    await fs.writeFile(path.join(linked, "file.txt"), "discard this");
    await nativeGit(linked, ["add", "file.txt"]);
    await fs.mkdir(path.join(linked, ".work/app-data/store"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(linked, ".work/app-data/store/private.txt"),
      "keep private",
    );
    await fs.writeFile(path.join(linked, "untracked.txt"), "discard this too");
    await new NativeProjectRepo(
      project,
      linked,
      async () => {},
    ).resetWorkingTree();
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe(
      "primary changes",
    );
    expect(await fs.readFile(path.join(linked, "file.txt"), "utf8")).toBe(
      "original",
    );
    expect(
      await fs.readFile(
        path.join(linked, ".work/app-data/store/private.txt"),
        "utf8",
      ),
    ).toBe("keep private");
    expect(
      await fs.access(path.join(linked, "untracked.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("clones once and retains the actual default branch", async () => {
    const destination = path.join(temporary, "clone");
    await fs.mkdir(destination);
    await nativeGit(destination, ["init", "-b", "main"]);
    const cloned = await cloneFromRemote({
      repoPath: destination,
      native: true,
      url: root,
    });
    expect(cloned.remoteBranch).toBe("feature");
    expect((await discoverLocalFolder({ path: destination })).branch).toBe(
      "feature",
    );
    expect(await nativeGit(destination, ["remote", "get-url", "origin"])).toBe(
      `${root}\n`,
    );
    expect(
      await fs.access(path.join(destination, ".work")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("commits one selected file without consuming staged changes to other files", async () => {
    const repo = new NativeProjectRepo(project, root, async () => {});
    await fs.writeFile(path.join(root, "file.txt"), "keep staged");
    await nativeGit(root, ["add", "file.txt"]);
    await fs.writeFile(path.join(root, "chosen.txt"), "record this");
    await repo.commit(
      "Selected document",
      { name: "Test", email: "test@example.com" },
      { paths: ["chosen.txt"] },
    );
    expect(await nativeGit(root, ["show", "HEAD:file.txt"])).toBe("original");
    expect(await nativeGit(root, ["show", ":file.txt"])).toBe("keep staged");
    expect(await nativeGit(root, ["show", "HEAD:chosen.txt"])).toBe(
      "record this",
    );
  });

  it("records a rename completely without recording another staged file", async () => {
    const repo = new NativeProjectRepo(project, root, async () => {});
    await nativeGit(root, ["mv", "file.txt", "renamed.txt"]);
    const chosen = (await repo.status()).modifiedFiles;
    expect(chosen.sort()).toEqual(["file.txt", "renamed.txt"]);
    await fs.writeFile(path.join(root, "unrelated.txt"), "Keep staged");
    await nativeGit(root, ["add", "unrelated.txt"]);
    await repo.commit(
      "Rename document",
      { name: "Test", email: "test@example.com" },
      { paths: chosen },
    );
    expect(await repo.readBlobAtRef("HEAD", "file.txt")).toBeNull();
    expect(await repo.readBlobAtRef("HEAD", "renamed.txt")).toEqual(
      new TextEncoder().encode("original"),
    );
    expect(await repo.readBlobAtRef("HEAD", "unrelated.txt")).toBeNull();
    expect((await repo.status()).modifiedFiles).toEqual(["unrelated.txt"]);
  });

  it("keeps personal files outside native reads and checkpoints", async () => {
    const repo = new NativeProjectRepo(project, root, async () => {});
    const personal = ".work/personal/private.ts";
    await fs.mkdir(path.dirname(path.join(root, personal)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, personal), "defineWorkflow private");
    expect(await repo.listFiles()).not.toContain(personal);
    expect(
      await repo.findFilesContaining({
        text: "defineWorkflow",
        globs: ["*.ts"],
      }),
    ).toEqual([]);
    await fs.writeFile(path.join(root, "file.txt"), "Public change");
    await repo.commit("Public files only", {
      name: "Test",
      email: "test@example.com",
    });
    expect((await repo.status()).dirty).toBe(false);
    expect(await repo.listFilesAtRef("HEAD")).not.toContain(personal);
    await nativeGit(root, ["add", "-f", personal]);
    await expect(
      repo.commit("Do not expose private files", {
        name: "Test",
        email: "test@example.com",
      }),
    ).rejects.toThrow("Personal files are tracked");
    await nativeGit(root, [...author, "commit", "-m", "External commit"]);
    expect(await repo.listFilesAtRef("HEAD")).not.toContain(personal);
    await expect(repo.readBlobAtRef("HEAD", personal)).rejects.toThrow(
      "Personal files are local-only",
    );
  });

  it("lists ignored and deleted files accurately and narrows source discovery", async () => {
    const repo = new NativeProjectRepo(project, root, async () => {});
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, ".github"));
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(root, "ignored"));
    await fs.writeFile(path.join(root, "ignored/huge.ts"), "defineWorkflow");
    await fs.writeFile(
      path.join(root, "src/flow.ts"),
      "export const flow = defineWorkflow(() => ({}));",
    );
    await fs.writeFile(path.join(root, ".github/config.yml"), "name: CI");
    await fs.rm(path.join(root, "file.txt"));
    expect(await repo.listFiles()).toEqual([
      ".github/config.yml",
      ".gitignore",
      "src/flow.ts",
    ]);
    expect(await repo.listFiles({ prefix: "src/" })).toEqual(["src/flow.ts"]);
    expect(
      await repo.findFilesContaining({
        text: "defineWorkflow",
        globs: ["*.ts"],
      }),
    ).toEqual(["src/flow.ts"]);
  });

  it("publishes temporary authoring objects without changing the attached checkout", async () => {
    const resolver = async () => root;
    const remote = new CheckoutRemoteBackend(
      resolver,
      new FsRemoteBackend(path.join(temporary, "unused")),
    );
    const manager = new ProjectManager(
      new FsBackend(path.join(temporary, "internal"), resolver),
      remote,
      resolver,
    );
    const head = (await nativeGit(root, ["rev-parse", "HEAD"])).trim();
    await remote.withOrigin(tenant, project, (origin) =>
      origin.updateRef({ ref: "refs/heads/main", sha: head }),
    );
    await fs.writeFile(path.join(root, "file.txt"), "private draft");
    const index = await fs.readFile(path.join(root, ".git/index"));
    const ephemeral = await manager.openEphemeral({
      tenantId: tenant,
      projectId: project,
    });
    try {
      await ephemeral.writeFile("watcher.ts", "export const watcher = true;");
      const sha = await ephemeral.commit("Watcher", {
        name: "Test",
        email: "test@example.com",
      });
      await push({
        dev: ephemeral,
        remote,
        tenantId: tenant,
        projectId: project,
        remoteBranch: "watchers/test",
      });
      await remote.withOrigin(tenant, project, async (origin) => {
        expect(await origin.resolveRef("refs/heads/watchers/test")).toBe(sha);
        await origin.deleteRef({ ref: "refs/heads/watchers/test" });
        expect(await origin.resolveRef("refs/heads/watchers/test")).toBeNull();
        expect(await origin.resolveRef("refs/heads/main")).toBe(head);
      });
    } finally {
      await ephemeral.dispose();
    }
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(index);
    expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe(
      "private draft",
    );
    expect((await nativeGit(root, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  it("retains a published commit in the same object database without moving the working branch", async () => {
    const remote = new CheckoutRemoteBackend(
      async () => root,
      new FsRemoteBackend(path.join(temporary, "unused")),
    );
    const head = (await nativeGit(root, ["rev-parse", "HEAD"])).trim();
    const index = await fs.readFile(path.join(root, ".git/index"));
    await remote.withOrigin(tenant, project, async (origin) => {
      expect(await origin.resolveRef("refs/heads/main")).toBeNull();
      await origin.updateRef({
        ref: "refs/heads/main",
        sha: head,
        expected: null,
      });
      expect(await origin.hasObject(head)).toBe(true);
      expect(await origin.resolveRef("refs/heads/main")).toBe(head);
    });
    expect((await nativeGit(root, ["branch", "--show-current"])).trim()).toBe(
      "feature",
    );
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(index);
    expect((await nativeGit(root, ["rev-parse", "origin/main"])).trim()).toBe(
      head,
    );
  });
});

describe("plain local folders", () => {
  let temporary: string;
  let root: string;
  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-folder-"));
    root = path.join(temporary, "folder");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "notes.md"), "Original notes");
  });
  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it("reads and edits directly without creating Git, seed files, or an internal copy", async () => {
    const resolver = async () => root;
    const remote = new CheckoutRemoteBackend(
      resolver,
      new FsRemoteBackend(path.join(temporary, "origins")),
    );
    const manager = new ProjectManager(
      new FsBackend(path.join(temporary, "internal"), resolver),
      remote,
      resolver,
    );
    expect(await discoverLocalFolder({ path: root })).toMatchObject({
      path: await fs.realpath(root),
      commonDirectory: null,
      remoteUrl: null,
    });
    const imported = await manager.create(tenant, project, {
      rootPath: root,
      importExisting: true,
      initialFiles: { "seed.txt": "Never write this" },
    });
    await imported.dispose();
    const repo = await manager.openDraft({
      tenantId: tenant,
      projectId: project,
      externalUserId: "developer",
    });
    if (!(repo instanceof NativeProjectRepo))
      throw new Error("A local folder is its own draft");
    try {
      expect(await repo.readAllFiles()).toEqual({
        "notes.md": "Original notes",
      });
      expect(await repo.listBranches()).toEqual([]);
      expect(await repo.log()).toEqual([]);
      await repo.writeFile("notes.md", "Edited locally");
      expect(await repo.workdirDiff()).toEqual([
        {
          path: "notes.md",
          kind: "added",
          before: null,
          after: "Edited locally",
        },
      ]);
      expect(await repo.status()).toMatchObject({
        dirty: true,
        baseCommit: null,
        remoteHead: null,
      });
      await remote.withOrigin(tenant, project, async (origin) => {
        expect(await origin.resolveRef("refs/heads/main")).toBeNull();
        expect(await origin.listRefs("refs/heads/")).toEqual([]);
      });
    } finally {
      await repo.dispose();
    }
    expect(await fs.readdir(temporary)).toEqual(["folder"]);
    expect(await fs.readdir(root)).toEqual(["notes.md"]);
  });

  it("honors ignores, hidden source files, nested repositories and private files before Git exists", async () => {
    for (const directory of [
      "src",
      ".github",
      "ignored",
      ".work/personal",
      "nested/.git",
    ])
      await fs.mkdir(path.join(root, directory), { recursive: true });
    for (const file of [
      "src/flow.ts",
      ".github/flow.ts",
      "ignored/flow.ts",
      ".work/personal/flow.ts",
      "nested/flow.ts",
    ])
      await fs.writeFile(path.join(root, file), "defineWorkflow");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    const repo = new NativeProjectRepo(project, root, async () => {});
    expect(await repo.listFiles()).toEqual([
      ".github/flow.ts",
      ".gitignore",
      "notes.md",
      "src/flow.ts",
    ]);
    expect(
      await repo.findFilesContaining({
        text: "defineWorkflow",
        globs: ["*.ts", ":!.github/**"],
      }),
    ).toEqual(["src/flow.ts"]);
    expect(await repo.listFiles({ prefix: "src/" })).toEqual(["src/flow.ts"]);
  });

  it("lists a prefix exactly as the whole-tree walk would, walking only that folder", async () => {
    for (const directory of [
      "src/deep",
      "ignored/deep",
      "kept/inner",
      "nested/.git",
      "node_modules/pkg",
      ".work/personal",
      ".venv/lib",
      "outside",
    ])
      await fs.mkdir(path.join(root, directory), { recursive: true });
    for (const file of [
      "src/flow.ts",
      "src/deep/step.ts",
      "ignored/deep/flow.ts",
      "kept/inner/a.ts",
      "kept/inner/b.log",
      "nested/flow.ts",
      "node_modules/pkg/index.js",
      ".work/personal/flow.ts",
      ".venv/lib/site.py",
      "outside/real.ts",
    ])
      await fs.writeFile(path.join(root, file), "defineWorkflow");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.writeFile(path.join(root, "kept/.gitignore"), "*.log\n");
    await fs.symlink(path.join(root, "outside"), path.join(root, "link"));
    const repo = new NativeProjectRepo(project, root, async () => {});
    const all = await repo.listFiles();
    expect(all).toContain(".venv/lib/site.py");
    expect(all).not.toContain("kept/inner/b.log");
    for (const prefix of [
      "src/",
      "src/deep/",
      "src/fl",
      "ignored/",
      "ignored/deep/",
      "kept/inner/",
      "nested/",
      "node_modules/pkg/",
      ".venv/",
      "link/",
      "missing/",
      "notes.md",
    ])
      expect(await repo.listFiles({ prefix })).toEqual(
        all.filter((file) => file.startsWith(prefix)),
      );
    expect(
      (
        await repo.findFilesContaining({
          text: "defineWorkflow",
          globs: ["src/*.ts", "src/**/*.ts"],
        })
      ).sort(),
    ).toEqual(["src/deep/step.ts", "src/flow.ts"]);
  });

  it("shares walks among concurrent listings, never one that started before a caller asked", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src/flow.ts"), "flow");
    const repo = new NativeProjectRepo(project, root, async () => {});
    const original = fs.readdir.bind(fs);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const readdir = vi
      .spyOn(fs, "readdir")
      // The first walk reads `src/`, then waits before it finishes.
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const entries = await original(...args);
        if (!held && args[0] === path.join(root, "src")) {
          held = true;
          await gate;
        }
        return entries;
      });
    try {
      const first = repo.listFiles();
      await vi.waitFor(() => expect(held).toBe(true));
      // Written after that walk read `src/`: a listing asked for now must
      // see it, which the walk in progress cannot.
      await fs.writeFile(path.join(root, "src/added.ts"), "added");
      const later = Array.from({ length: 4 }, () => repo.listFiles());
      // Let them reach the walk in progress (each first checks for Git).
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      expect(await first).toEqual(["notes.md", "src/flow.ts"]);
      for (const listing of await Promise.all(later))
        expect(listing).toEqual(["notes.md", "src/added.ts", "src/flow.ts"]);
      // One walk running, one shared by the four that asked during it.
      expect(readdir.mock.calls.filter(([dir]) => dir === root)).toHaveLength(
        2,
      );
      readdir.mockClear();
      expect(await repo.listFiles({ prefix: "src/" })).toEqual([
        "src/added.ts",
        "src/flow.ts",
      ]);
      // A prefix walks its folder only.
      expect(readdir.mock.calls.map(([dir]) => dir)).toEqual([
        path.join(root, "src"),
      ]);
    } finally {
      readdir.mockRestore();
    }
  });

  it("decides negated ignores on the way down as the whole walk does", async () => {
    for (const directory of ["a/keep/inner", "a/drop", "kept/x", "other"])
      await fs.mkdir(path.join(root, directory), { recursive: true });
    for (const file of [
      "a/keep/inner/one.ts",
      "a/drop/two.ts",
      "kept/x/three.ts",
      "other/four.ts",
    ])
      await fs.writeFile(path.join(root, file), "x");
    await fs.writeFile(path.join(root, ".gitignore"), "*/\n!kept/\n!a/\n");
    await fs.writeFile(path.join(root, "a/.gitignore"), "*\n!keep/\n");
    const repo = new NativeProjectRepo(project, root, async () => {});
    const all = await repo.listFiles();
    for (const prefix of [
      "a/",
      "a/keep/",
      "a/keep/inner/",
      "a/drop/",
      "kept/x/",
      "other/",
      "a/../",
      "./",
    ])
      expect(await repo.listFiles({ prefix })).toEqual(
        all.filter((file) => file.startsWith(prefix)),
      );
  });

  it("fails as the whole walk does when a folder inside cannot be read", async () => {
    await fs.mkdir(path.join(root, "src/deep"), { recursive: true });
    await fs.writeFile(path.join(root, "src/deep/flow.ts"), "flow");
    const repo = new NativeProjectRepo(project, root, async () => {});
    const original = fs.readdir.bind(fs);
    const readdir = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        if (args[0] === path.join(root, "src/deep"))
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return original(...args);
      });
    try {
      await expect(repo.listFiles()).rejects.toThrow("gone");
      await expect(repo.listFiles({ prefix: "src/" })).rejects.toThrow("gone");
      // The folder asked for is missing: nothing, as before.
      expect(await repo.listFiles({ prefix: "missing/" })).toEqual([]);
    } finally {
      readdir.mockRestore();
    }
    await fs.rm(root, { recursive: true });
    await expect(repo.listFiles({ prefix: "src/" })).rejects.toThrow();
  });

  it("initializes Git only for an explicit commit and immediately supports external Git initialization", async () => {
    const repo = new NativeProjectRepo(project, root, async () => {});
    const sha = await repo.commit(
      "Record notes",
      { name: "Test", email: "test@example.com" },
      { paths: ["notes.md"] },
    );
    expect(await repo.resolveRef()).toBe(sha);
    expect(await repo.status()).toMatchObject({
      dirty: false,
      baseCommit: sha,
      remoteHead: null,
    });
    expect(await fs.readdir(root)).toEqual([".git", "notes.md"]);
    await fs.rm(path.join(root, ".git"), { recursive: true });
    await nativeGit(root, ["init", "-b", "custom"]);
    expect(await repo.currentBranch()).toBe("custom");
    expect(await repo.listFiles()).toEqual(["notes.md"]);
  });

  it("rejects files, bare repositories and broken checkout pointers, including from subfolders", async () => {
    await expect(
      discoverLocalFolder({ path: path.join(root, "notes.md") }),
    ).rejects.toThrow("Choose a folder");
    const bare = path.join(temporary, "bare");
    await fs.mkdir(bare);
    await nativeGit(bare, ["init", "--bare"]);
    await expect(discoverLocalFolder({ path: bare })).rejects.toThrow(
      "bare Git repository",
    );
    await fs.mkdir(path.join(root, "subfolder"));
    await fs.writeFile(path.join(root, ".git"), "gitdir: missing\n");
    await expect(
      discoverLocalFolder({ path: path.join(root, "subfolder") }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(root, ".git"), "utf8")).toBe(
      "gitdir: missing\n",
    );
  });
});
