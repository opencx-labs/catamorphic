import fs from "node:fs/promises";
import path from "node:path";
import { ProjectRepoImpl } from "./project-repo.js";
import type { ProjectRepo, StorageBackend } from "./types.js";

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

export class ProjectManager {
  constructor(private readonly storage: StorageBackend) {}

  async open(tenantId: string, projectId: string): Promise<ProjectRepo> {
    const { repoPath, release } = await this.storage.acquireProject(
      tenantId,
      projectId,
    );
    return new ProjectRepoImpl(projectId, repoPath, release);
  }

  async create(
    tenantId: string,
    projectId: string,
    opts?: { name?: string; initialFiles?: Record<string, string> },
  ): Promise<ProjectRepo> {
    const repoPath = await this.storage.initProject(tenantId, projectId);
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

    const { release } = await this.storage.acquireProject(tenantId, projectId);
    const repo = new ProjectRepoImpl(projectId, repoPath, release);

    await repo.commit("Initial commit", {
      name: "Catamorphic",
      email: "system@catamorphic.dev",
    });

    return repo;
  }

  async delete(tenantId: string, projectId: string): Promise<void> {
    await this.storage.deleteProject(tenantId, projectId);
  }

  async exists(tenantId: string, projectId: string): Promise<boolean> {
    return this.storage.exists(tenantId, projectId);
  }
}
