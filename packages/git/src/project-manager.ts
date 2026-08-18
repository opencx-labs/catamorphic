import fs from "node:fs/promises";
import path from "node:path";
import { push } from "./git-sync.js";
import { cloneFromRemote } from "./network.js";
import { ProjectRepoImpl } from "./project-repo.js";
import type {
  GitCredentials,
  ProjectRepo,
  RemoteBackend,
  StorageBackend,
} from "./types.js";

/**
 * Where the project manifest lives. `.catamorphic/` is the project-owned
 * metadata directory (ADR 0043): the manifest marks a folder as a
 * Catamorphic project and is the future home of project-scoped config.
 * Deliberately NOT written when cloning a network remote — imported history
 * stays pristine until project-scoped config is actually needed.
 */
export const PROJECT_MANIFEST_PATH = ".catamorphic/project.json";

/**
 * Seeded into every new project (unless one exists): mirrors the
 * checkpoint walker's IGNORED_DIRS so git status and the walker agree on
 * what a project's history never contains.
 */
export const PROJECT_GITIGNORE = `node_modules/
dist/
.turbo/
.DS_Store
# The project store (ADR 0055): data made by using the project, versioned on
# the server per write, never in git.
store/
.catamorphic/remote-sync.json
`;

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

    const repoPath = await this.storage.initProject(tenantId, projectId, {
      externalUserId,
    });
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
      /** Explicit directory for the working copy (user-visible folder). */
      rootPath?: string;
      /**
       * Adopt the folder's existing contents instead of scaffolding a blank
       * workspace. Existing files are never overwritten; a git repo is
       * initialized only when the folder is not already one.
       */
      importExisting?: boolean;
      /**
       * Populate the working copy by cloning a network git remote (e.g. a
       * GitHub repo) instead of scaffolding. Mutually exclusive with
       * `importExisting`; `initialFiles` are skipped so the imported history
       * stays pristine.
       */
      cloneFrom?: {
        url: string;
        credentials?: GitCredentials;
        branch?: string;
      };
    },
  ): Promise<ProjectRepo> {
    const repoPath = await this.storage.initProject(tenantId, projectId, {
      externalUserId: opts?.externalUserId,
      rootPath: opts?.rootPath,
    });
    const projectName = opts?.name ?? "my-project";

    if (opts?.cloneFrom) {
      await cloneFromRemote({
        repoPath,
        url: opts.cloneFrom.url,
        credentials: opts.cloneFrom.credentials,
        branch: opts.cloneFrom.branch,
      });
      const repo = new ProjectRepoImpl(projectId, repoPath, async () => {});
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

    // No eager workspace scaffold (ADR 0043): a blank project is a git repo,
    // a manifest, and whatever `initialFiles` (seed skills or a template's
    // file map) provide. The workflow workspace arrives on demand.
    const manifestPath = path.join(repoPath, PROJECT_MANIFEST_PATH);
    const manifestExists = await fs.access(manifestPath).then(
      () => true,
      () => false,
    );
    if (!manifestExists) {
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.writeFile(
        manifestPath,
        `${JSON.stringify({ name: projectName }, null, 2)}\n`,
      );
    }

    // Every project gets ignore rules from birth: without them the first
    // `bun install` floods git status (and every changes UI) with the
    // whole node_modules tree. Never overwrite one the user already has.
    const gitignorePath = path.join(repoPath, ".gitignore");
    const gitignoreExists = await fs.access(gitignorePath).then(
      () => true,
      () => false,
    );
    if (!gitignoreExists) {
      await fs.writeFile(gitignorePath, PROJECT_GITIGNORE);
    }

    if (opts?.initialFiles) {
      for (const [filePath, content] of Object.entries(opts.initialFiles)) {
        const fullPath = path.join(repoPath, filePath);
        if (opts.importExisting) {
          const exists = await fs.access(fullPath).then(
            () => true,
            () => false,
          );
          if (exists) continue;
        }
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
      }
    }

    // Use the path initProject returned rather than re-acquiring: when the
    // host maps this project to an explicit rootPath, its resolver may not
    // know the id yet (hosts record the mapping after create returns).
    const repo = new ProjectRepoImpl(projectId, repoPath, async () => {});

    const hasHead = await repo.resolveRef("HEAD").then(
      () => true,
      () => false,
    );
    if (!hasHead) {
      await repo.commit(
        opts?.importExisting ? "Import project" : "Initial commit",
        SYSTEM_AUTHOR,
      );
    } else if (opts?.importExisting) {
      const status = await repo.status();
      if (status.dirty) {
        await repo.commit("Import project into Catamorphic", SYSTEM_AUTHOR);
      }
    }

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
