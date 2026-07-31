import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import type {
  InitProjectOptions,
  ProjectPathResolver,
  StorageBackend,
} from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

/**
 * Filesystem-backed project storage. When a `pathResolver` maps a project to
 * an explicit root directory (a user-visible folder), that folder IS the
 * working copy — shared by all users of this single-machine backend.
 * Otherwise dev working copies live under the internal layout:
 *   <basePath>/<tenantId>/<projectId>/dev/<externalUserId>/
 * When `externalUserId` is omitted, falls back to the legacy layout
 *   <basePath>/<tenantId>/<projectId>/
 * so older tests and single-user usage remain compatible.
 */
export class FsBackend implements StorageBackend {
  constructor(
    private readonly basePath: string,
    private readonly pathResolver?: ProjectPathResolver,
  ) {}

  private resolveInternalPath(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): string {
    assertUuid(tenantId);
    assertUuid(projectId);
    const base = path.join(this.basePath, tenantId, projectId);
    const dir = externalUserId
      ? path.join(base, "dev", sanitizeUserId(externalUserId))
      : base;
    if (!path.resolve(dir).startsWith(path.resolve(this.basePath))) {
      throw new Error("Path traversal detected");
    }
    return dir;
  }

  private async resolveProjectPath(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<string> {
    const rootPath = await this.pathResolver?.(tenantId, projectId);
    if (rootPath) return rootPath;
    return this.resolveInternalPath(tenantId, projectId, externalUserId);
  }

  async acquireProject(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<{ repoPath: string; release: () => Promise<void> }> {
    const projectPath = await this.resolveProjectPath(
      tenantId,
      projectId,
      externalUserId,
    );
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

  async initProject(
    tenantId: string,
    projectId: string,
    opts?: InitProjectOptions,
  ): Promise<string> {
    const projectPath =
      opts?.rootPath ??
      (await this.resolveProjectPath(
        tenantId,
        projectId,
        opts?.externalUserId,
      ));
    await fs.mkdir(projectPath, { recursive: true });
    const gitDir = path.join(projectPath, ".git");
    const hasRepo = await fs.access(gitDir).then(
      () => true,
      () => false,
    );
    if (!hasRepo) {
      await git.init({ fs: nodeFs, dir: projectPath, defaultBranch: "main" });
    }
    return projectPath;
  }

  async deleteProject(tenantId: string, projectId: string): Promise<void> {
    // Only internal storage is removed. Explicitly-rooted folders belong to
    // the user; the host decides separately whether to trash them.
    const projectRoot = path.join(this.basePath, tenantId, projectId);
    await fs.rm(projectRoot, { recursive: true, force: true });
  }

  async exists(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<boolean> {
    const projectPath = await this.resolveProjectPath(
      tenantId,
      projectId,
      externalUserId,
    );
    try {
      await fs.access(projectPath);
      return true;
    } catch {
      return false;
    }
  }
}

function sanitizeUserId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid externalUserId: ${value}`);
  }
  return value;
}
