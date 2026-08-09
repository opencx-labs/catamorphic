import type {
  CloneSource,
  ProjectManager,
  ProjectRepo,
} from "@catamorphic/git";
import { WORKFLOW_SOURCE_ROOT } from "@catamorphic/parser";
import type { SandboxProvider } from "@catamorphic/sandbox";
import {
  resolveWorkflowPackageFallback,
  SandboxManagerImpl,
  uploadPluginPayloads,
} from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";
import type { DbSandboxStore } from "./db-sandbox-store.js";
import { type SyncedFileChange, syncSandboxChanges } from "./sandbox-sync.js";

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
      const workflowPackage = await resolveWorkflowPackageFallback({
        packageJson:
          (await repo
            .readFile(`${WORKFLOW_SOURCE_ROOT}/package.json`)
            .catch(() => undefined)) ??
          (await repo.readFile("package.json").catch(() => undefined)),
      });
      await uploadPluginPayloads({
        provider: this.deps.provider,
        sandboxId: handle.providerId,
        projectDir: this.projectDirectory,
        plugins: workflowPackage ? [workflowPackage] : undefined,
      });
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

  /**
   * Mirror the caller's dev-sandbox changes into the dev working copy right
   * now, without waiting for the current agent turn to finish. No-op when
   * the caller has no dev sandbox (host-execution agents edit the dev tree
   * directly). Used by builds that must see the agent's in-flight work.
   */
  async syncBack(opts: {
    identity: Identity;
    projectId: string;
  }): Promise<SyncedFileChange[]> {
    const existing = await this.deps.store.findSandbox({
      projectId: opts.projectId,
      sandboxType: "dev",
      userId: opts.identity.externalUserId,
    });
    if (!existing) return [];
    const status = await this.deps.provider.getSandboxStatus(
      existing.providerId,
    );
    if (status === "stopped" || status === "archived") {
      await this.deps.provider.startSandbox(existing.providerId);
    }
    return syncSandboxChanges({
      provider: this.deps.provider,
      projectManager: this.deps.projectManager,
      identity: opts.identity,
      projectId: opts.projectId,
      sandboxProviderId: existing.providerId,
      projectDir: this.projectDirectory,
    });
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
