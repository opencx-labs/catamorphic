import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";
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

    const commits = await repo.log();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message.trim()).toBe("Initial commit");

    await repo.dispose();
  });

  it("importExisting adopts files and adds a manifest without overwriting", async () => {
    const rootPath = path.join(tmpDir, "existing");
    await fs.mkdir(rootPath, { recursive: true });
    await fs.writeFile(path.join(rootPath, "notes.md"), "# Notes\n");

    const repo = await manager.create(TENANT, PROJECT, {
      name: "adopted",
      rootPath,
      importExisting: true,
    });

    const files = await repo.listFiles();
    expect(files).toContain("notes.md");
    expect(files).toContain(".catamorphic/project.json");
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
