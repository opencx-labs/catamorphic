import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckoutRemoteBackend } from "../checkout-remote-backend.js";
import { FsBackend } from "../fs-backend.js";
import { FsRemoteBackend } from "../fs-remote-backend.js";
import { push } from "../git-sync.js";
import { discoverCheckout, nativeGit } from "../native-git.js";
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
      (await discoverCheckout({ path: path.join(root, "nested") })).path,
    ).toBe(await fs.realpath(root));
    const worktree = path.join(temporary, "parallel");
    await nativeGit(root, ["worktree", "add", "-b", "parallel", worktree]);
    const primary = await discoverCheckout({ path: root });
    const alternate = await discoverCheckout({ path: worktree });
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
    await fs.mkdir(path.join(linked, "store"));
    await fs.writeFile(path.join(linked, "store/private.txt"), "keep private");
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
      await fs.readFile(path.join(linked, "store/private.txt"), "utf8"),
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
    expect((await discoverCheckout({ path: destination })).branch).toBe(
      "feature",
    );
    expect(await nativeGit(destination, ["remote", "get-url", "origin"])).toBe(
      `${root}\n`,
    );
    expect(
      await fs.access(path.join(destination, ".catamorphic")).then(
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
    const personal = ".catamorphic/personal/private.ts";
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
