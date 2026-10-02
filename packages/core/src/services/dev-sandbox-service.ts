import type {
  CloneSource,
  ProjectDraft,
  ProjectManager,
} from "@catamorphic/git";
import type {
  SandboxProvider,
  SandboxResources,
  SignInHarness,
} from "@catamorphic/sandbox";
import {
  resolveWorkflowPackageFallback,
  SandboxManagerImpl,
  uploadPluginPayloads,
} from "@catamorphic/sandbox";
import {
  PROJECT_LOCKFILE_PATHS,
  PROJECT_WORKFLOWS_PACKAGE_PATH,
  PROJECT_WORKSPACE_ROOT,
  publishedRef,
} from "@catamorphic/workflow/project-layout";
import type { Identity } from "../identity.js";
import type { DbSandboxStore } from "./db-sandbox-store.js";
import {
  SandboxSyncError,
  type SyncedFileChange,
  syncSandboxChanges,
} from "./sandbox-sync.js";

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
      sessionId?: string;
      resources?: SandboxResources;
      /** The owner's sign-ins a new sandbox mounts (ADR 0199). */
      signIns?: ReadonlyArray<{ harness: SignInHarness; member: string }>;
    },
  ) {
    this.manager = new SandboxManagerImpl({
      provider: deps.provider,
      store: deps.store,
      resources: {
        cpuMillis: deps.resources?.cpuMillis,
        memoryMb: deps.resources?.memoryMb,
        storageMb: deps.resources?.storageMb,
        gpu: deps.resources?.gpu,
      },
      ...(deps.signIns ? { signIns: deps.signIns } : {}),
    });
  }

  async ensure(opts: {
    identity: Identity;
    projectId: string;
    refresh: boolean;
  }): Promise<PreparedDevSandbox> {
    const repo = this.deps.sessionId
      ? await this.deps.projectManager.openSession({
          tenantId: opts.identity.tenantId,
          projectId: opts.projectId,
          sessionId: this.deps.sessionId,
          refresh: opts.refresh,
        })
      : await this.deps.projectManager.openDraft({
          tenantId: opts.identity.tenantId,
          projectId: opts.projectId,
          externalUserId: opts.identity.externalUserId,
        });
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
        hasLockfile: await Promise.all(
          PROJECT_LOCKFILE_PATHS.map((file) =>
            repo.readFile(file).then(
              () => true,
              () => false,
            ),
          ),
        ).then((present) => present.some(Boolean)),
        packageJson: await repo
          .readFile(PROJECT_WORKFLOWS_PACKAGE_PATH)
          .catch(() => undefined),
      });
      await uploadPluginPayloads({
        provider: this.deps.provider,
        sandboxId: handle.providerId,
        projectDir: `${this.projectDirectory}/${PROJECT_WORKSPACE_ROOT}`,
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
   * Mirror the caller's dev-sandbox changes into the caller's draft right
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
    // A build goes on with the dev tree as it is; the turn's own sync
    // reports the failure on its reply.
    return syncSandboxChanges({
      provider: this.deps.provider,
      projectManager: this.deps.projectManager,
      identity: opts.identity,
      projectId: opts.projectId,
      sandboxProviderId: existing.providerId,
      projectDir: this.projectDirectory,
    }).catch((error: unknown) => {
      if (!(error instanceof SandboxSyncError)) throw error;
      console.warn(`[catamorphic] ${error.message}`);
      return [];
    });
  }

  private async cloneSourceIfInSync(opts: {
    identity: Identity;
    projectId: string;
    repo: ProjectDraft;
  }): Promise<CloneSource | undefined> {
    const remoteBackend = this.deps.projectManager.remoteBackend;
    if (!remoteBackend?.getCloneSource) return undefined;
    const status = await opts.repo.status().catch(() => null);
    if (!status || status.dirty) return undefined;
    const head = await opts.repo.resolveRef("HEAD").catch(() => null);
    const remoteSha = await opts.repo
      .resolveRef(publishedRef())
      .catch(() => null);
    if (!head || head !== remoteSha) return undefined;
    return remoteBackend.getCloneSource(
      opts.identity.tenantId,
      opts.projectId,
      { scope: "read" },
    );
  }
}
