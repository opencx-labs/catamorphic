export interface CommitInfo {
  sha: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}

export interface GitCredentials {
  username: string;
  password: string;
}

export interface StorageBackend {
  acquireProject(
    tenantId: string,
    projectId: string,
  ): Promise<{ repoPath: string; release: () => Promise<void> }>;
  initProject(tenantId: string, projectId: string): Promise<string>;
  deleteProject(tenantId: string, projectId: string): Promise<void>;
  exists(tenantId: string, projectId: string): Promise<boolean>;
}

export interface ProjectRepo {
  readonly projectId: string;
  readonly repoPath: string;

  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  listFiles(): Promise<string[]>;
  readAllFiles(): Promise<Record<string, string>>;

  commit(
    message: string,
    author: { name: string; email: string },
  ): Promise<string>;
  log(options?: { maxCount?: number }): Promise<CommitInfo[]>;
  resolveRef(ref?: string): Promise<string>;

  setRemote(url: string, credentials?: GitCredentials): Promise<void>;
  fetch(): Promise<void>;
  push(): Promise<void>;

  checkout(ref?: string): Promise<void>;
  dispose(): Promise<void>;
}
