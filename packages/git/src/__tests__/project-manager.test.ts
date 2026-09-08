import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
import { InMemoryObjectStore } from "../in-memory-object-store.js";
import { nativeGit } from "../native-git.js";
import { ObjectRemoteBackend } from "../object-remote-backend.js";
import { ProjectManager } from "../project-manager.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";

describe("ProjectManager", () => {
  let tmpDir: string;
  let manager: ProjectManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-pm-"));
    manager = new ProjectManager(new FsBackend(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("create initializes a repo with only the manifest and an initial commit (ADR 0043)", async () => {
    const repo = await manager.create(TENANT, PROJECT, {
      name: "test-project",
    });

    const files = await repo.listFiles();
    expect(files).toContain(".catamorphic/project.json");
    // No eager workspace scaffold: the workflow workspace arrives on demand.
    expect(files).not.toContain("package.json");
    expect(files).not.toContain("contracts/package.json");
    expect(files).not.toContain("workflows/package.json");

    const manifest = JSON.parse(
      await repo.readFile(".catamorphic/project.json"),
    );
    expect(manifest.name).toBe("test-project");
    expect(manifest.defaultEnvironment).toBe("local");
    expect(manifest.environments).toEqual({
      local: {
        binding: "local",
        description: "Run on this machine",
        workloads: ["agent", "workflow"],
      },
    });

    const commits = await repo.log();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message.trim()).toBe("Initial commit");

    await repo.dispose();
  });

  it("discards temporary work without touching a host-mapped project folder", async () => {
    const rootPath = path.join(tmpDir, "user-project");
    const remote = new ObjectRemoteBackend({
      store: new InMemoryObjectStore(),
    });
    manager = new ProjectManager(new FsBackend(tmpDir), remote);
    const project = await manager.create(TENANT, PROJECT, {
      name: "P",
      rootPath,
    });
    const head = await project.resolveRef();
    await project.writeFile("draft.txt", "User's uncommitted work");
    const isolated = await manager.openEphemeral({
      tenantId: TENANT,
      projectId: PROJECT,
    });
    const isolatedPath = isolated.repoPath;
    try {
      expect(isolatedPath).not.toBe(rootPath);
      await isolated.writeFile("watcher.ts", "Temporary source");
      await isolated.commit("Watcher", {
        name: "Test",
        email: "test@example.com",
      });
      expect(await project.resolveRef()).toBe(head);
      expect(await project.readFile("draft.txt")).toBe(
        "User's uncommitted work",
      );
      expect(await project.listFiles()).not.toContain("watcher.ts");
    } finally {
      await isolated.dispose();
      await project.dispose();
    }
    await expect(fs.access(isolatedPath)).rejects.toThrow();
  });

  it("importExisting opens a Git checkout without writing a manifest", async () => {
    const rootPath = path.join(tmpDir, "existing");
    await fs.mkdir(rootPath, { recursive: true });
    await fs.writeFile(path.join(rootPath, "notes.md"), "# Notes\n");
    await nativeGit(rootPath, ["init", "-b", "feature"]);
    await expect(
      manager.create(TENANT, PROJECT, { rootPath, importExisting: true }),
    ).rejects.toThrow("Register the checkout");
    manager = new ProjectManager(
      new FsBackend(tmpDir, async () => rootPath),
      undefined,
      async () => rootPath,
    );

    const repo = await manager.create(TENANT, PROJECT, {
      name: "adopted",
      rootPath,
      importExisting: true,
    });

    const files = await repo.listFiles();
    expect(files).toContain("notes.md");
    expect(files).not.toContain(".catamorphic/project.json");
    expect(await repo.readFile("notes.md")).toBe("# Notes\n");

    await repo.dispose();
  });

  it("create with initialFiles includes them in the repo", async () => {
    const repo = await manager.create(TENANT, PROJECT, {
      name: "my-proj",
      initialFiles: {
        "src/main.ts": 'console.log("hello");',
      },
    });

    const content = await repo.readFile("src/main.ts");
    expect(content).toBe('console.log("hello");');

    await repo.dispose();
  });

  it("open returns a repo for an existing project", async () => {
    const created = await manager.create(TENANT, PROJECT);
    await created.dispose();

    const opened = await manager.open(TENANT, PROJECT);
    const files = await opened.listFiles();
    expect(files).toContain(".catamorphic/project.json");

    await opened.dispose();
  });

  it("open throws for non-existent project", async () => {
    await expect(manager.open(TENANT, PROJECT)).rejects.toThrow();
  });

  it("delete removes the project", async () => {
    const repo = await manager.create(TENANT, PROJECT);
    await repo.dispose();

    expect(await manager.exists(TENANT, PROJECT)).toBe(true);
    await manager.delete(TENANT, PROJECT);
    expect(await manager.exists(TENANT, PROJECT)).toBe(false);
  });
});

it("moves session checkpoints between machine caches without publishing or mixing sessions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cat-session-work-"));
  const remote = new ObjectRemoteBackend({ store: new InMemoryObjectStore() });
  const a = new ProjectManager(new FsBackend(path.join(dir, "a")), remote);
  const b = new ProjectManager(new FsBackend(path.join(dir, "b")), remote);
  const args = {
    tenantId: TENANT,
    projectId: PROJECT,
    sessionId: "session-one",
  };
  const author = { name: "Agent", email: "agent@example.test" };
  try {
    const main = await a.create(TENANT, PROJECT, {
      initialFiles: { "notes.md": "original" },
    });
    await main.dispose();
    const first = await a.openSession(args);
    await first.writeFile("notes.md", "first turn");
    await first.dispose();
    await a.checkpointSession({ ...args, message: "First turn", author });
    const next = await b.openSession(args);
    expect(await next.readFile("notes.md")).toBe("first turn");
    await next.writeFile("notes.md", "second turn");
    await next.dispose();
    await b.checkpointSession({ ...args, message: "Second turn", author });
    const returned = await a.openSession({ ...args, refresh: true });
    expect(await returned.readFile("notes.md")).toBe("second turn");
    await returned.dispose();
    const other = await b.openSession({ ...args, sessionId: "session-two" });
    expect(await other.readFile("notes.md")).toBe("original");
    await other.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
