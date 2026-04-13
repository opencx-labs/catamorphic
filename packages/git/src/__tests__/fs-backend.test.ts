import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBackend } from "../fs-backend.js";

const TENANT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const PROJECT = "f1e2d3c4-b5a6-7890-dcba-fedcba987654";

describe("FsBackend", () => {
  let tmpDir: string;
  let backend: FsBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-test-"));
    backend = new FsBackend(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("initProject creates a directory with a .git folder", async () => {
    const repoPath = await backend.initProject(TENANT, PROJECT);

    expect(repoPath).toContain(TENANT);
    expect(repoPath).toContain(PROJECT);

    const gitDir = path.join(repoPath, ".git");
    const stat = await fs.stat(gitDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("exists returns false for non-existent project", async () => {
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
  });

  it("exists returns true after initProject", async () => {
    await backend.initProject(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(true);
  });

  it("acquireProject returns repoPath and release for existing project", async () => {
    await backend.initProject(TENANT, PROJECT);

    const { repoPath, release } = await backend.acquireProject(TENANT, PROJECT);
    expect(repoPath).toContain(PROJECT);
    expect(typeof release).toBe("function");
    await release();
  });

  it("acquireProject throws for non-existent project", async () => {
    await expect(backend.acquireProject(TENANT, PROJECT)).rejects.toThrow(
      "Project not found",
    );
  });

  it("deleteProject removes the directory", async () => {
    await backend.initProject(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(true);

    await backend.deleteProject(TENANT, PROJECT);
    expect(await backend.exists(TENANT, PROJECT)).toBe(false);
  });

  it("rejects invalid UUIDs", async () => {
    await expect(backend.initProject("not-a-uuid", PROJECT)).rejects.toThrow(
      "Invalid UUID",
    );

    await expect(backend.initProject(TENANT, "../traversal")).rejects.toThrow(
      "Invalid UUID",
    );
  });
});
