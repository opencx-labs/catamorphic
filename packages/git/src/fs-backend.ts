import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import type { StorageBackend } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

export class FsBackend implements StorageBackend {
  constructor(private readonly basePath: string) {}

  private resolveProjectPath(tenantId: string, projectId: string): string {
    assertUuid(tenantId);
    assertUuid(projectId);
    const projectPath = path.join(this.basePath, tenantId, projectId);
    if (!path.resolve(projectPath).startsWith(path.resolve(this.basePath))) {
      throw new Error("Path traversal detected");
    }
    return projectPath;
  }

  async acquireProject(
    tenantId: string,
    projectId: string,
  ): Promise<{ repoPath: string; release: () => Promise<void> }> {
    const projectPath = this.resolveProjectPath(tenantId, projectId);
    try {
      await fs.access(projectPath);
    } catch {
      throw new Error(`Project not found: ${projectId}`);
    }
    return {
      repoPath: projectPath,
      release: async () => {},
    };
  }

  async initProject(tenantId: string, projectId: string): Promise<string> {
    const projectPath = this.resolveProjectPath(tenantId, projectId);
    await fs.mkdir(projectPath, { recursive: true });
    await git.init({ fs: nodeFs, dir: projectPath, defaultBranch: "main" });
    return projectPath;
  }

  async deleteProject(tenantId: string, projectId: string): Promise<void> {
    const projectPath = this.resolveProjectPath(tenantId, projectId);
    await fs.rm(projectPath, { recursive: true, force: true });
  }

  async exists(tenantId: string, projectId: string): Promise<boolean> {
    const projectPath = this.resolveProjectPath(tenantId, projectId);
    try {
      await fs.access(projectPath);
      return true;
    } catch {
      return false;
    }
  }
}
