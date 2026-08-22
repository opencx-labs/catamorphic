import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReservedProject } from "./project-path.js";

const temporaryDirs: string[] = [];

const temporaryDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-path-"));
  temporaryDirs.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const create = (rootPath: string) => Promise.resolve({ rootPath });
const provision = () => Promise.resolve();
const rollback = () => Promise.resolve();
const cleanup = () => Promise.resolve();

describe("createReservedProject", () => {
  it("gives concurrent initializers distinct folders", async () => {
    const parentDir = temporaryDir();
    const projects = await Promise.all([
      createReservedProject({
        parentDir,
        slug: "default-project",
        create,
        provision,
        rollback,
        cleanup,
      }),
      createReservedProject({
        parentDir,
        slug: "default-project",
        create,
        provision,
        rollback,
        cleanup,
      }),
    ]);
    const roots = projects.map((project) => project.rootPath);

    expect(roots[0]).not.toBe(roots[1]);
    expect(roots.map((root) => path.basename(root)).sort()).toEqual([
      "default-project",
      "default-project-2",
    ]);
  });

  it("removes its reservation when creation fails", async () => {
    const parentDir = temporaryDir();
    const attemptedRoots: string[] = [];

    await expect(
      createReservedProject({
        parentDir,
        slug: "default-project",
        create: async (rootPath) => {
          attemptedRoots.push(rootPath);
          fs.writeFileSync(path.join(rootPath, "partial"), "unfinished");
          throw new Error("creation failed");
        },
        provision,
        rollback,
        cleanup,
      }),
    ).rejects.toThrow("creation failed");

    expect(attemptedRoots).toHaveLength(1);
    expect(fs.existsSync(attemptedRoots[0] ?? "")).toBe(false);
  });

  it("rolls back the project and folder when provisioning fails", async () => {
    const parentDir = temporaryDir();
    const rolledBack: string[] = [];

    await expect(
      createReservedProject({
        parentDir,
        slug: "default-project",
        create,
        provision: () => Promise.reject(new Error("profile claim failed")),
        rollback: async ({ rootPath }) => {
          rolledBack.push(rootPath);
        },
        cleanup,
      }),
    ).rejects.toThrow("profile claim failed");

    expect(rolledBack).toHaveLength(1);
    expect(fs.existsSync(rolledBack[0] ?? "")).toBe(false);
  });

  it("keeps the folder when rollback fails", async () => {
    const parentDir = temporaryDir();
    const attemptedRoots: string[] = [];

    await expect(
      createReservedProject({
        parentDir,
        slug: "default-project",
        create: async (rootPath) => {
          attemptedRoots.push(rootPath);
          return { rootPath };
        },
        provision: () => Promise.reject(new Error("profile claim failed")),
        rollback: () => Promise.reject(new Error("database rollback failed")),
        cleanup,
      }),
    ).rejects.toThrow("Project setup failed and could not be rolled back");

    expect(fs.existsSync(attemptedRoots[0] ?? "")).toBe(true);
  });

  it("removes the folder before reporting metadata cleanup failure", async () => {
    const parentDir = temporaryDir();
    const attemptedRoots: string[] = [];

    await expect(
      createReservedProject({
        parentDir,
        slug: "default-project",
        create: async (rootPath) => {
          attemptedRoots.push(rootPath);
          return { rootPath };
        },
        provision: () => Promise.reject(new Error("profile claim failed")),
        rollback,
        cleanup: () => Promise.reject(new Error("metadata cleanup failed")),
      }),
    ).rejects.toThrow(
      "Project setup failed and metadata cleanup was incomplete",
    );

    expect(fs.existsSync(attemptedRoots[0] ?? "")).toBe(false);
  });
});
