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

/**
 * Host-provided lookup for projects whose working copy lives at an explicit
 * filesystem location (e.g. a user-visible folder chosen in a desktop app).
 * Returning `null` falls back to the backend's own internal layout.
 */
export type ProjectPathResolver = (
  tenantId: string,
  projectId: string,
) => Promise<string | null>;

export interface InitProjectOptions {
  externalUserId?: string;
  /** Explicit absolute directory to initialize the project in. */
  rootPath?: string;
}

export interface StorageBackend {
  acquireProject(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<{ repoPath: string; release: () => Promise<void> }>;
  initProject(
    tenantId: string,
    projectId: string,
    opts?: InitProjectOptions,
  ): Promise<string>;
  deleteProject(tenantId: string, projectId: string): Promise<void>;
  exists(
    tenantId: string,
    projectId: string,
    externalUserId?: string,
  ): Promise<boolean>;
}

export type FileChange =
  | { kind: "added"; path: string; content: string }
  | { kind: "modified"; path: string; before: string; after: string }
  | { kind: "deleted"; path: string; before: string };

export interface RepoStatus {
  branch: string;
  dirty: boolean;
  modifiedFiles: string[];
  ahead: number;
  behind: number;
  baseCommit: string | null;
  remoteHead: string | null;
}

export interface BranchInfo {
  name: string;
  commit: string;
  isCurrent: boolean;
  createdAt: number | null;
}

export interface DiffEntry {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: string | null;
  after: string | null;
}

export interface MergeResult {
  status: "clean" | "conflict" | "up-to-date";
  mergeCommit: string | null;
  conflicts: ConflictEntry[];
}

export interface ConflictEntry {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface ProjectRepo {
  readonly projectId: string;
  readonly repoPath: string;

  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  listFiles(): Promise<string[]>;
  readAllFiles(): Promise<Record<string, string>>;
  readAllFilesAtRef(ref: string): Promise<Record<string, string>>;
  /**
   * The files under one directory prefix at a ref (e.g. `roles/`), without
   * materializing the whole tree. `prefix` is a directory path with its
   * trailing slash; results are keyed by full path.
   */
  readFilesAtRef(
    ref: string,
    opts: { prefix: string },
  ): Promise<Record<string, string>>;
  /** File paths at a ref, optionally under one directory prefix; no content. */
  listFilesAtRef(ref: string, opts?: { prefix?: string }): Promise<string[]>;
  /** File paths + blob ids at a ref (content-addressed digests, no content). */
  listBlobsAtRef(
    ref: string,
    opts?: { prefix?: string },
  ): Promise<Array<{ path: string; oid: string }>>;

  commit(
    message: string,
    author: { name: string; email: string },
  ): Promise<string>;
  log(options?: { maxCount?: number; ref?: string }): Promise<CommitInfo[]>;
  resolveRef(ref?: string): Promise<string>;

  setRemote(url: string, credentials?: GitCredentials): Promise<void>;
  fetch(): Promise<void>;
  push(): Promise<void>;

  checkout(ref?: string): Promise<void>;

  status(): Promise<RepoStatus>;
  currentBranch(): Promise<string>;
  listBranches(): Promise<BranchInfo[]>;
  createBranch(name: string, fromRef?: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  hasBranch(name: string): Promise<boolean>;

  workdirDiff(): Promise<DiffEntry[]>;
  diff(opts: { base: string; head: string }): Promise<DiffEntry[]>;
  resetWorkingTree(): Promise<void>;

  /**
   * Point a branch ref at `sha`, creating it if missing. Unlike
   * {@link createBranch} this does not switch HEAD; use {@link checkout} after
   * if needed.
   */
  moveBranch(name: string, sha: string): Promise<void>;

  dispose(): Promise<void>;
}

/**
 * Everything a git client (sandbox, CI job, local checkout) needs to clone a
 * project directly from the remote backend. Credentials are typically
 * short-lived scoped tokens — treat the value as ephemeral and request a
 * fresh one per operation.
 */
export interface CloneSource {
  url: string;
  username?: string;
  password?: string;
  branch?: string;
}

/**
 * A backend that stores the canonical (shared) bare repository for a project.
 * The "origin" in git terminology — contents are never checked out; only git
 * objects + refs live here. Push/pull is orchestrated by the server using
 * {@link RemoteBackend.withOrigin}.
 */
export interface RemoteBackend {
  initRemote(tenantId: string, projectId: string): Promise<void>;
  deleteRemote(tenantId: string, projectId: string): Promise<void>;
  exists(tenantId: string, projectId: string): Promise<boolean>;
  /**
   * Invoke `fn` with an {@link OriginRepo} scoped to the project's bare repo.
   * Implementations decide whether this is a local FS path or a synced mirror
   * of a network remote (e.g. Cloudflare Artifacts); the interface is always
   * the same.
   */
  withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T>;
  /**
   * Optional capability: backends whose origin is a real network git remote
   * (Cloudflare Artifacts) can hand out a URL + short-lived credentials so
   * sandboxes `git clone` the project directly instead of receiving file
   * uploads from the host. FS-backed origins do not implement this.
   */
  getCloneSource?(
    tenantId: string,
    projectId: string,
    opts?: { scope?: "read" | "write" },
  ): Promise<CloneSource>;
}

/**
 * Thin git-object-level interface over a bare repo used by {@link git-sync}.
 * Only the primitives needed for server-orchestrated push/fetch are exposed.
 */
export interface OriginRepo {
  readonly gitdir: string;
  /** Resolve a ref (e.g. `refs/heads/main`) to a SHA, or null if missing. */
  resolveRef(ref: string): Promise<string | null>;
  /** List refs under a prefix (e.g. `refs/heads/`) with their SHAs. */
  listRefs(prefix: string): Promise<{ ref: string; sha: string }[]>;
  /** Update a ref to a new SHA; no-op if `expected` is provided and mismatches. */
  updateRef(opts: {
    ref: string;
    sha: string;
    expected?: string | null;
  }): Promise<void>;
  /** Whether the object is present locally. */
  hasObject(sha: string): Promise<boolean>;
  /** Read the raw git object (returns { type, data }). */
  readObject(sha: string): Promise<{
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }>;
  /** Write a git object with a known type; returns the resolved SHA. */
  writeObject(opts: {
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }): Promise<string>;
  log(ref: string, maxCount?: number): Promise<CommitInfo[]>;
}
