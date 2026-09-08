import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { ProjectManager } from "../project-manager.js";
import type { ProjectRepo } from "../types.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";

describe("ProjectRepo", () => {
  let tmpDir: string;
  let manager: ProjectManager;
  let repo: ProjectRepo;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-repo-"));
    manager = new ProjectManager(new FsBackend(tmpDir));
    repo = await manager.create(TENANT, PROJECT, { name: "test-proj" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await repo.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("file operations", () => {
    it("writeFile and readFile round-trip", async () => {
      await repo.writeFile("src/hello.ts", "export const x = 1;");
      const content = await repo.readFile("src/hello.ts");
      expect(content).toBe("export const x = 1;");
    });

    it("writeFile creates nested directories", async () => {
      await repo.writeFile("src/deep/nested/file.ts", "content");
      const content = await repo.readFile("src/deep/nested/file.ts");
      expect(content).toBe("content");
    });

    it("deleteFile removes a file", async () => {
      await repo.writeFile("temp.ts", "data");
      await repo.deleteFile("temp.ts");
      await expect(repo.readFile("temp.ts")).rejects.toThrow();
    });

    it("listFiles returns all non-hidden, non-ignored files", async () => {
      await repo.writeFile("src/a.ts", "a");
      await repo.writeFile("src/b.ts", "b");

      const files = await repo.listFiles();
      expect(files).toContain("src/a.ts");
      expect(files).toContain("src/b.ts");
      expect(files).toContain(".catamorphic/project.json");
      // The seeded ignore rules are project content…
      expect(files).toContain(".gitignore");
      // …but the .git directory itself never lists.
      expect(files.some((f) => f === ".git" || f.startsWith(".git/"))).toBe(
        false,
      );
    });

    it("readAllFiles returns a map of path -> content", async () => {
      await repo.writeFile("src/x.ts", "x-content");

      const allFiles = await repo.readAllFiles();
      expect(allFiles["src/x.ts"]).toBe("x-content");
      expect(allFiles[".catamorphic/project.json"]).toBeDefined();
    });

    it("rejects paths with ..", async () => {
      await expect(repo.readFile("../escape.ts")).rejects.toThrow(
        "Path traversal",
      );
    });

    it("rejects .git paths", async () => {
      await expect(repo.readFile(".git/config")).rejects.toThrow(
        "Cannot access .git",
      );
    });

    it("rejects absolute paths", async () => {
      await expect(repo.readFile("/etc/passwd")).rejects.toThrow(
        "Absolute paths not allowed",
      );
    });
  });

  describe("git operations", () => {
    it.each([1, 128, 512])(
      "bounds index IO when committing %i files",
      async (fileCount) => {
        const files = Object.fromEntries(
          Array.from({ length: fileCount }, (_, index) => [
            `src/file-${index}.ts`,
            `export const value = ${index};`,
          ]),
        );
        await Promise.all(
          Object.entries(files).map(([file, content]) =>
            repo.writeFile(file, content),
          ),
        );
        const indexPath = path.join(repo.repoPath, ".git", "index");
        const contentPaths = new Set(
          Object.keys(files).map((file) => path.join(repo.repoPath, file)),
        );
        const readFile = fs.readFile;
        let activeReads = 0;
        let peakReads = 0;
        const reads = vi
          .spyOn(fs, "readFile")
          .mockImplementation(async (...args) => {
            const isContent =
              typeof args[0] === "string" && contentPaths.has(args[0]);
            if (isContent) {
              activeReads += 1;
              peakReads = Math.max(peakReads, activeReads);
            }
            try {
              return await readFile(...args);
            } finally {
              if (isContent) activeReads -= 1;
            }
          });
        const writes = vi.spyOn(fs, "writeFile");
        const sha = await repo.commit("Save project files", {
          name: "Test",
          email: "test@test.com",
        });
        const indexReads = reads.mock.calls.filter(
          ([file]) => file === indexPath,
        ).length;
        const indexWrites = writes.mock.calls.filter(
          ([file]) => file === indexPath,
        ).length;
        reads.mockRestore();
        writes.mockRestore();

        expect(await repo.readAllFilesAtRef(sha)).toMatchObject(files);
        // Actual disk IO, not git.add call counts or a timing threshold:
        // staging must not parse/rewrite the full index once per file.
        expect(indexReads).toBeGreaterThan(0);
        expect(indexReads).toBeLessThanOrEqual(4);
        expect(indexWrites).toBeGreaterThan(0);
        expect(indexWrites).toBeLessThanOrEqual(6);
        expect(peakReads).toBeGreaterThan(0);
        expect(peakReads).toBeLessThanOrEqual(128);
      },
    );

    it("preserves executable-bit changes even when file content is unchanged", async () => {
      const author = { name: "Test", email: "test@test.com" };
      await repo.writeFile("script.sh", "#!/bin/sh\necho hello\n");
      await fs.chmod(path.join(repo.repoPath, "script.sh"), 0o644);
      await repo.commit("Baseline", author);
      await fs.chmod(path.join(repo.repoPath, "script.sh"), 0o755);
      const sha = await repo.commit("Make executable", author);
      const { tree } = await git.readTree({
        fs: nodeFs,
        dir: repo.repoPath,
        oid: sha,
      });
      expect(tree.find((entry) => entry.path === "script.sh")?.mode).toBe(
        "100755",
      );
    });

    it("stages content across nested repositories without their metadata or ignored dependencies", async () => {
      for (const name of ["one", "two"]) {
        await git.init({
          fs: nodeFs,
          dir: path.join(repo.repoPath, name),
          defaultBranch: "main",
        });
        await repo.writeFile(`${name}/.gitignore`, "cache/\n");
        await repo.writeFile(`${name}/src/index.ts`, name);
        await repo.writeFile(`${name}/cache/generated.txt`, "ignored");
        await repo.writeFile(`${name}/node_modules/dependency.js`, "ignored");
      }
      const sha = await repo.commit("Save parent project", {
        name: "Test",
        email: "test@test.com",
      });
      const files = await repo.readAllFilesAtRef(sha);
      for (const name of ["one", "two"]) {
        expect(files[`${name}/src/index.ts`]).toBe(name);
        expect(files[`${name}/.gitignore`]).toBe("cache/\n");
        expect(files).not.toHaveProperty(`${name}/cache/generated.txt`);
        expect(files).not.toHaveProperty(`${name}/node_modules/dependency.js`);
        expect(
          Object.keys(files).some((file) => file.startsWith(`${name}/.git/`)),
        ).toBe(false);
      }
    });

    it("commits additions, modifications, and deletions while excluding ignored files", async () => {
      const author = { name: "Test", email: "test@test.com" };
      await repo.writeFile("src/changed.ts", "before");
      await repo.writeFile("src/deleted.ts", "delete me");
      await repo.commit("Baseline", author);
      const ignore = await repo.readFile(".gitignore");
      await repo.writeFile(".gitignore", `${ignore}\n*.log\n`);
      await repo.writeFile("src/changed.ts", "after");
      await repo.writeFile("src/added.ts", "new");
      await repo.deleteFile("src/deleted.ts");
      await repo.writeFile("src/debug.log", "ignored");
      await repo.writeFile("node_modules/dependency/index.js", "ignored");
      await repo.writeFile(".hidden/file.ts", "hidden");

      const sha = await repo.commit("Save changes", author);
      const files = await repo.readAllFilesAtRef(sha);
      expect(files).toMatchObject({
        "src/changed.ts": "after",
        "src/added.ts": "new",
      });
      for (const excluded of [
        "src/deleted.ts",
        "src/debug.log",
        "node_modules/dependency/index.js",
        ".hidden/file.ts",
      ]) {
        expect(files).not.toHaveProperty(excluded);
      }
    });

    it("limits staging to requested paths and preserves other staged changes", async () => {
      const author = { name: "Test", email: "test@test.com" };
      for (const file of ["selected.ts", "deleted.ts", "outside.ts", "kept.ts"])
        await repo.writeFile(file, "before");
      await repo.commit("Baseline", author);
      await repo.writeFile("selected.ts", "after");
      await repo.writeFile("added.ts", "new");
      await repo.writeFile("outside.ts", "unstaged");
      await repo.writeFile("staged.ts", "already staged");
      await git.add({ fs: nodeFs, dir: repo.repoPath, filepath: "staged.ts" });
      await repo.deleteFile("deleted.ts");
      await repo.deleteFile("kept.ts");

      const sha = await repo.commit("Selected changes", author, {
        paths: ["selected.ts", "added.ts", "deleted.ts"],
      });
      const files = await repo.readAllFilesAtRef(sha);
      expect(files).toMatchObject({
        "selected.ts": "after",
        "added.ts": "new",
        "outside.ts": "before",
        "kept.ts": "before",
        "staged.ts": "already staged",
      });
      expect(files).not.toHaveProperty("deleted.ts");
      expect(await repo.readFile("outside.ts")).toBe("unstaged");
      expect((await repo.status()).dirty).toBe(true);
    });

    it("supports deletion-only and empty path selections", async () => {
      const author = { name: "Test", email: "test@test.com" };
      await repo.writeFile("deleted.ts", "before");
      await repo.commit("Baseline", author);
      await repo.deleteFile("deleted.ts");
      await repo.writeFile("outside.ts", "unstaged");
      const empty = await repo.commit("No selected changes", author, {
        paths: [],
      });
      expect(await repo.readAllFilesAtRef(empty)).toMatchObject({
        "deleted.ts": "before",
      });
      const sha = await repo.commit("Delete selected file", author, {
        paths: ["deleted.ts"],
      });
      const files = await repo.readAllFilesAtRef(sha);
      expect(files).not.toHaveProperty("deleted.ts");
      expect(files).not.toHaveProperty("outside.ts");
    });

    it("commit stages all files and returns a SHA", async () => {
      await repo.writeFile("src/new.ts", "new file");

      const sha = await repo.commit("Add new file", {
        name: "Test",
        email: "test@test.com",
      });

      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it("log returns commit history", async () => {
      await repo.writeFile("src/change.ts", "v1");
      await repo.commit("First change", {
        name: "Test",
        email: "test@test.com",
      });

      await repo.writeFile("src/change.ts", "v2");
      await repo.commit("Second change", {
        name: "Test",
        email: "test@test.com",
      });

      const commits = await repo.log();
      expect(commits.length).toBeGreaterThanOrEqual(3); // initial + 2
      expect(commits[0]?.message.trim()).toBe("Second change");
      expect(commits[1]?.message.trim()).toBe("First change");
    });

    it("log respects maxCount", async () => {
      await repo.writeFile("src/a.ts", "a");
      await repo.commit("commit a", {
        name: "Test",
        email: "test@test.com",
      });

      const commits = await repo.log({ maxCount: 1 });
      expect(commits).toHaveLength(1);
    });

    it("resolveRef returns a 40-char SHA for HEAD", async () => {
      const sha = await repo.resolveRef("HEAD");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it("resolveRef returns same SHA as latest commit", async () => {
      await repo.writeFile("src/test.ts", "test");
      const commitSha = await repo.commit("test commit", {
        name: "Test",
        email: "test@test.com",
      });

      const headSha = await repo.resolveRef();
      expect(headSha).toBe(commitSha);
    });
  });
});

describe("personal workflow files", () => {
  let directory: string;
  let repo: ProjectRepo;
  const privatePath = ".catamorphic/personal/profile-one/workflows/private.ts";

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-workflows-"));
    repo = await new ProjectManager(new FsBackend(directory)).create(
      TENANT,
      PROJECT,
      { name: "private-files" },
    );
    await fs.mkdir(path.dirname(path.join(repo.repoPath, privatePath)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repo.repoPath, privatePath),
      "export const privateValue = 'not project content';",
    );
  });
  afterEach(async () => {
    await repo.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("excludes personal files from discovery, sandbox source snapshots, and checkpoints", async () => {
    expect(await repo.listFiles()).not.toContain(privatePath);
    expect(await repo.readAllFiles()).not.toHaveProperty(privatePath);
    await repo.writeFile(
      "workflows/src/shared.ts",
      "export const shared = true;",
    );
    const commit = await repo.commit("Save shared work", {
      name: "Test",
      email: "test@example.com",
    });
    const files = await repo.readAllFilesAtRef(commit);
    expect(files["workflows/src/shared.ts"]).toBeDefined();
    expect(files[privatePath]).toBeUndefined();
    expect(
      await fs.readFile(path.join(repo.repoPath, privatePath), "utf8"),
    ).toContain("not project content");
    expect((await repo.status()).dirty).toBe(false);
  });

  it("refuses indexed private files and hides private blobs from historical program reads", async () => {
    await git.add({
      fs: nodeFs,
      dir: repo.repoPath,
      filepath: privatePath,
      force: true,
    });
    await expect(
      repo.commit("Checkpoint", { name: "Test", email: "test@example.com" }),
    ).rejects.toThrow("Personal files are tracked");
    // Simulate a pre-existing accidental commit made outside the framework.
    const sha = await git.commit({
      fs: nodeFs,
      dir: repo.repoPath,
      message: "Legacy accidental commit",
      author: { name: "Test", email: "test@example.com" },
    });
    expect(await repo.listFilesAtRef(sha)).not.toContain(privatePath);
    expect(await repo.readAllFilesAtRef(sha)).not.toHaveProperty(privatePath);
    await expect(repo.readBlobAtRef(sha, privatePath)).rejects.toThrow(
      "local-only",
    );
  });

  it("rejects direct project API access, including normalized aliases", async () => {
    for (const candidate of [privatePath, `workflows/../${privatePath}`]) {
      await expect(repo.readFile(candidate)).rejects.toThrow("local-only");
      await expect(repo.writeFile(candidate, "replacement")).rejects.toThrow(
        "local-only",
      );
      await expect(repo.readFileBytes(candidate)).rejects.toThrow("local-only");
    }
  });
});
