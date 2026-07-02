import type {
  CloneSource,
  SandboxHandle,
  SandboxManager,
  SandboxProvider,
  SandboxType,
} from "./types.js";

interface SandboxRecord {
  id: string;
  providerId: string;
  projectId: string;
  sandboxType: SandboxType;
  commitSha: string | null;
  userId: string | null;
  status: string;
}

export interface SandboxStore {
  findSandbox(opts: {
    projectId: string;
    sandboxType: SandboxType;
    commitSha?: string;
    userId?: string;
  }): Promise<SandboxRecord | null>;

  insertSandbox(record: {
    projectId: string;
    providerId: string;
    sandboxType: SandboxType;
    commitSha: string | null;
    userId: string | null;
    status: string;
  }): Promise<SandboxRecord>;

  updateStatus(id: string, status: string): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
}

interface SandboxManagerOpts {
  provider: SandboxProvider;
  store: SandboxStore;
  defaultSnapshotName?: string;
}

export class SandboxManagerImpl implements SandboxManager {
  private readonly provider: SandboxProvider;
  private readonly store: SandboxStore;
  private readonly defaultSnapshotName: string | undefined;

  constructor(opts: SandboxManagerOpts) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.defaultSnapshotName = opts.defaultSnapshotName;
  }

  async ensureExecSandbox(opts: {
    projectId: string;
    commitSha: string;
    cloneSource?: CloneSource;
  }): Promise<SandboxHandle> {
    const existing = await this.store.findSandbox({
      projectId: opts.projectId,
      sandboxType: "execution",
      commitSha: opts.commitSha,
    });

    if (existing) {
      return this.ensureRunning(existing);
    }

    return this.createSandbox({
      projectId: opts.projectId,
      sandboxType: "execution",
      commitSha: opts.commitSha,
      userId: null,
      cloneSource: opts.cloneSource
        ? { ...opts.cloneSource, commitSha: opts.commitSha }
        : undefined,
      labels: {
        projectId: opts.projectId,
        commitSha: opts.commitSha,
        purpose: "execution",
      },
    });
  }

  async ensureDevSandbox(opts: {
    projectId: string;
    userId: string;
    cloneSource?: CloneSource;
  }): Promise<SandboxHandle> {
    const existing = await this.store.findSandbox({
      projectId: opts.projectId,
      sandboxType: "dev",
      userId: opts.userId,
    });

    if (existing) {
      return this.ensureRunning(existing);
    }

    return this.createSandbox({
      projectId: opts.projectId,
      sandboxType: "dev",
      commitSha: null,
      userId: opts.userId,
      cloneSource: opts.cloneSource,
      labels: {
        projectId: opts.projectId,
        userId: opts.userId,
        purpose: "dev",
      },
    });
  }

  async releaseSandbox(sandboxId: string): Promise<void> {
    await this.provider.stopSandbox(sandboxId);
  }

  private async ensureRunning(record: SandboxRecord): Promise<SandboxHandle> {
    const status = await this.provider.getSandboxStatus(record.providerId);

    if (status === "stopped" || status === "archived") {
      await this.provider.startSandbox(record.providerId);
      await this.store.updateStatus(record.id, "started");
    }

    await this.store.updateLastUsed(record.id);

    return {
      id: record.id,
      providerId: record.providerId,
      sandboxType: record.sandboxType,
      status: "started",
    };
  }

  private async createSandbox(opts: {
    projectId: string;
    sandboxType: SandboxType;
    commitSha: string | null;
    userId: string | null;
    cloneSource?: CloneSource;
    labels: Record<string, string>;
  }): Promise<SandboxHandle> {
    const handle = await this.provider.createSandbox({
      snapshotName: this.defaultSnapshotName,
      language: "typescript",
      autoStopInterval: opts.sandboxType === "dev" ? 30 : 15,
      labels: opts.labels,
    });

    if (opts.cloneSource) {
      await this.provider.gitClone(
        handle.providerId,
        opts.cloneSource.url,
        `${this.provider.workspaceRoot}/project`,
        {
          branch: opts.cloneSource.branch,
          commitId: opts.cloneSource.commitSha,
          username: opts.cloneSource.username,
          password: opts.cloneSource.password,
        },
      );
    }

    const record = await this.store.insertSandbox({
      projectId: opts.projectId,
      providerId: handle.providerId,
      sandboxType: opts.sandboxType,
      commitSha: opts.commitSha,
      userId: opts.userId,
      status: "started",
    });

    return {
      id: record.id,
      providerId: handle.providerId,
      sandboxType: opts.sandboxType,
      status: "started",
    };
  }
}
