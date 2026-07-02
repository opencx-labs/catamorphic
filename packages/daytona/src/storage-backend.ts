import type { StorageBackend } from "@catamorphic/git";
import { Daytona } from "@daytonaio/sdk";

const PROJECT_DIR = "project";

export class DaytonaBackend implements StorageBackend {
  private client: Daytona;
  private sandboxIds = new Map<string, string>();

  constructor(config?: { apiKey?: string; apiUrl?: string; target?: string }) {
    this.client = new Daytona(config);
  }

  private key(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): string {
    return externalUserId
      ? `${tenantId}/${projectId}/${externalUserId}`
      : `${tenantId}/${projectId}`;
  }

  async initProject(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<string> {
    const sandbox = await this.client.create({
      language: "typescript",
      autoStopInterval: 15,
      labels: {
        tenantId,
        projectId,
        purpose: "dev",
        ...(externalUserId ? { externalUserId } : {}),
      },
    });

    await sandbox.process.executeCommand(
      `git init --initial-branch=main ${PROJECT_DIR}`,
    );

    this.sandboxIds.set(
      this.key(tenantId, projectId, externalUserId),
      sandbox.id,
    );
    return PROJECT_DIR;
  }

  async acquireProject(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<{ repoPath: string; release: () => Promise<void> }> {
    const sandboxId = this.sandboxIds.get(
      this.key(tenantId, projectId, externalUserId),
    );
    if (!sandboxId) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const sandbox = await this.client.get(sandboxId);
    if (sandbox.state === "stopped") {
      await sandbox.start();
    }

    return {
      repoPath: PROJECT_DIR,
      release: async () => {},
    };
  }

  async deleteProject(tenantId: string, projectId: string): Promise<void> {
    const prefix = `${tenantId}/${projectId}`;
    const matchingKeys = [...this.sandboxIds.keys()].filter(
      (k) => k === prefix || k.startsWith(`${prefix}/`),
    );
    for (const key of matchingKeys) {
      const sandboxId = this.sandboxIds.get(key);
      if (!sandboxId) continue;
      const sandbox = await this.client.get(sandboxId);
      await this.client.delete(sandbox);
      this.sandboxIds.delete(key);
    }
  }

  async exists(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<boolean> {
    return this.sandboxIds.has(this.key(tenantId, projectId, externalUserId));
  }

  getSandboxId(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): string | undefined {
    return this.sandboxIds.get(this.key(tenantId, projectId, externalUserId));
  }
}
