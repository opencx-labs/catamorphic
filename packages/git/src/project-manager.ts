import fs from "node:fs/promises";
import path from "node:path";
import { push } from "./git-sync.js";
import { ProjectRepoImpl } from "./project-repo.js";
import type { ProjectRepo, RemoteBackend, StorageBackend } from "./types.js";

const DEFAULT_PKG = (name: string) =>
  JSON.stringify({ name, version: "0.1.0", private: true }, null, 2);

const DEFAULT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src"],
  },
  null,
  2,
);

const SYSTEM_AUTHOR = {
  name: "Catamorphic",
  email: "system@catamorphic.dev",
};

/**
 * Pattern used for auto-generated draft branches. Format is
 * `work/YYYY-MM-DD_HH-mm[-N]` where `-N` suffix is appended on collision.
 */
export const WORK_BRANCH_PREFIX = "work/";

export class ProjectManager {
  constructor(
    private readonly storage: StorageBackend,
    private readonly remote?: RemoteBackend,
  ) {}

  async open(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<ProjectRepo> {
    const { repoPath, release } = await this.storage.acquireProject(
      tenantId,
      projectId,
      externalUserId,
    );
    return new ProjectRepoImpl(projectId, repoPath, release);
  }

  /**
   * Open (creating if needed) the dev working copy for a specific user. When
   * the underlying storage has no clone for this user yet, we initialize one
   * and pull from origin so the user starts in sync with main.
   */
  async openDev(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ): Promise<ProjectRepo> {
    const existed = await this.storage.exists(
      tenantId,
      projectId,
      externalUserId,
    );
    if (existed) {
      return this.open(tenantId, projectId, externalUserId);
    }

    const repoPath = await this.storage.initProject(
      tenantId,
      projectId,
      externalUserId,
    );
    const { release } = await this.storage.acquireProject(
      tenantId,
      projectId,
      externalUserId,
    );
    const repo = new ProjectRepoImpl(projectId, repoPath, release);

    if (this.remote) {
      await seedFromOrigin({
        remote: this.remote,
        tenantId,
        projectId,
        dev: repo,
      });
    }

    return repo;
  }

  async create(
    tenantId: string,
    projectId: string,
    opts?: {
      name?: string;
      initialFiles?: Record<string, string>;
      externalUserId?: string;
    },
  ): Promise<ProjectRepo> {
    const repoPath = await this.storage.initProject(
      tenantId,
      projectId,
      opts?.externalUserId,
    );
    const projectName = opts?.name ?? "my-project";

    await fs.writeFile(
      path.join(repoPath, "package.json"),
      DEFAULT_PKG(projectName),
    );
    await fs.writeFile(path.join(repoPath, "tsconfig.json"), DEFAULT_TSCONFIG);
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });

    if (opts?.initialFiles) {
      for (const [filePath, content] of Object.entries(opts.initialFiles)) {
        const fullPath = path.join(repoPath, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
      }
    }

    const { release } = await this.storage.acquireProject(
      tenantId,
      projectId,
      opts?.externalUserId,
    );
    const repo = new ProjectRepoImpl(projectId, repoPath, release);

    await repo.commit("Initial commit", SYSTEM_AUTHOR);

    if (this.remote) {
      await this.remote.initRemote(tenantId, projectId);
      await push({
        dev: repo,
        remote: this.remote,
        tenantId,
        projectId,
        remoteBranch: "main",
      });
    }

    return repo;
  }

  async delete(tenantId: string, projectId: string): Promise<void> {
    await this.storage.deleteProject(tenantId, projectId);
    if (this.remote) {
      await this.remote.deleteRemote(tenantId, projectId).catch(() => {});
    }
  }

  async exists(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<boolean> {
    return this.storage.exists(tenantId, projectId, externalUserId);
  }

  get remoteBackend(): RemoteBackend | undefined {
    return this.remote;
  }
}

async function seedFromOrigin(opts: {
  remote: RemoteBackend;
  tenantId: string;
  projectId: string;
  dev: ProjectRepo;
}): Promise<void> {
  const { fetchRemote } = await import("./git-sync.js");
  const fetched = await fetchRemote({
    dev: opts.dev,
    remote: opts.remote,
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    remoteBranch: "main",
  });
  if (fetched.sha) {
    const nodeFs = (await import("node:fs")).default;
    const git = (await import("isomorphic-git")).default;
    await git.writeRef({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ref: "refs/heads/main",
      value: fetched.sha,
      force: true,
    });
    await git.checkout({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ref: "main",
      force: true,
    });
  }
}

/**
 * Generate a fresh work-branch name of the form `work/YYYY-MM-DD_HH-mm[-N]`.
 * `isTaken` is consulted so callers can suffix `-N` when the bare name is
 * already used.
 */
export async function generateWorkBranchName(opts: {
  now?: Date;
  isTaken: (name: string) => Promise<boolean>;
}): Promise<string> {
  const now = opts.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${WORK_BRANCH_PREFIX}${now.getUTCFullYear()}-${pad(
    now.getUTCMonth() + 1,
  )}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(
    now.getUTCMinutes(),
  )}`;
  if (!(await opts.isTaken(base))) return base;
  let suffix = 2;
  while (await opts.isTaken(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
