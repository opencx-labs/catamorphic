import type {
  CloneSource,
  ProjectManager,
  ProjectRepo,
} from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { SandboxManagerImpl } from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";
import type { DbSandboxStore } from "./db-sandbox-store.js";

export interface PreparedDevSandbox {
  id: string;
  providerId: string;
  projectDirectory: string;
  baseCommitSha: string | null;
}

export class DevSandboxService {
  private readonly manager: SandboxManagerImpl;

  constructor(
    private readonly deps: {
      projectManager: ProjectManager;
      provider: SandboxProvider;
      store: DbSandboxStore;
    },
  ) {
    this.manager = new SandboxManagerImpl({
      provider: deps.provider,
      store: deps.store,
    });
  }

  async ensure(opts: {
    identity: Identity;
    projectId: string;
    refresh: boolean;
  }): Promise<PreparedDevSandbox> {
    const repo = await this.deps.projectManager.openDev(
      opts.identity.tenantId,
      opts.projectId,
      opts.identity.externalUserId,
    );
    try {
      const baseCommitSha = await repo.resolveRef("HEAD").catch(() => null);
      const existing = await this.deps.store.findSandbox({
        projectId: opts.projectId,
        sandboxType: "dev",
        userId: opts.identity.externalUserId,
      });
      const cloneSource = existing
        ? undefined
        : await this.cloneSourceIfInSync({
            identity: opts.identity,
            projectId: opts.projectId,
            repo,
          });
      const handle = await this.manager.ensureDevSandbox({
        projectId: opts.projectId,
        userId: opts.identity.externalUserId,
        cloneSource,
      });
      if (!cloneSource && (!existing || opts.refresh)) {
        await this.deps.provider.uploadFiles(
          handle.providerId,
          await repo.readAllFiles(),
          this.projectDirectory,
        );
      }
      return {
        id: handle.id,
        providerId: handle.providerId,
        projectDirectory: this.projectDirectory,
        baseCommitSha,
      };
    } finally {
      await repo.dispose();
    }
  }

  get projectDirectory(): string {
    return `${this.deps.provider.workspaceRoot}/project`;
  }

  private async cloneSourceIfInSync(opts: {
    identity: Identity;
    projectId: string;
    repo: ProjectRepo;
  }): Promise<CloneSource | undefined> {
    const remoteBackend = this.deps.projectManager.remoteBackend;
    if (!remoteBackend?.getCloneSource) return undefined;
    const status = await opts.repo.status().catch(() => null);
    if (!status || status.dirty) return undefined;
    const head = await opts.repo.resolveRef("HEAD").catch(() => null);
    const remoteSha = await opts.repo
      .resolveRef("refs/remotes/origin/main")
      .catch(() => null);
    if (!head || head !== remoteSha) return undefined;
    return remoteBackend.getCloneSource(
      opts.identity.tenantId,
      opts.projectId,
      { scope: "read" },
    );
  }
}
