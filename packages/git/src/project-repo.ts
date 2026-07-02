import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type {
  BranchInfo,
  CommitInfo,
  DiffEntry,
  GitCredentials,
  ProjectRepo,
  RepoStatus,
} from "./types.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".turbo"]);

/**
 * Dot-directories that are project content despite the hidden-file skip
 * below. `.agents/` holds per-project agent skills (`.agents/skills/…`) that
 * must be committed, uploaded to sandboxes, and listed like any other file.
 */
const ALLOWED_DOT_DIRS = new Set([".agents"]);

function assertSafePath(filePath: string): void {
  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) {
    throw new Error("Absolute paths not allowed");
  }
  if (normalized.startsWith("..")) {
    throw new Error("Path traversal detected");
  }
  if (normalized.startsWith(".git/") || normalized === ".git") {
    throw new Error("Cannot access .git directory");
  }
}

async function walkDirectory(dir: string, base: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && !ALLOWED_DOT_DIRS.has(entry.name))
      continue;

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(base, fullPath);

    if (entry.isDirectory()) {
      const nested = await walkDirectory(fullPath, base);
      results.push(...nested);
    } else {
      results.push(relativePath);
    }
  }

  return results;
}

export class ProjectRepoImpl implements ProjectRepo {
  private credentials: GitCredentials | undefined;

  constructor(
    readonly projectId: string,
    readonly repoPath: string,
    private readonly releaseFn: () => Promise<void>,
  ) {}

  async readFile(filePath: string): Promise<string> {
    assertSafePath(filePath);
    return fs.readFile(path.join(this.repoPath, filePath), "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    assertSafePath(filePath);
    const fullPath = path.join(this.repoPath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  async deleteFile(filePath: string): Promise<void> {
    assertSafePath(filePath);
    await fs.unlink(path.join(this.repoPath, filePath));
  }

  async listFiles(): Promise<string[]> {
    return walkDirectory(this.repoPath, this.repoPath);
  }

  async readAllFiles(): Promise<Record<string, string>> {
    const files = await this.listFiles();
    const entries = await Promise.all(
      files.map(async (f) => [f, await this.readFile(f)] as const),
    );
    return Object.fromEntries(entries);
  }

  async readAllFilesAtRef(ref: string): Promise<Record<string, string>> {
    const oid = await git.resolveRef({
      fs: nodeFs,
      dir: this.repoPath,
      ref,
    });
    const result: Record<string, string> = {};
    const TextDecoderCtor = TextDecoder;
    const decoder = new TextDecoderCtor("utf-8");
    const trees = [{ tree: git.TREE({ ref: oid }) }];
    await git.walk({
      fs: nodeFs,
      dir: this.repoPath,
      trees: trees.map((t) => t.tree),
      map: async (filepath, [entry]) => {
        if (filepath === "." || !entry) return;
        const type = await entry.type();
        if (type !== "blob") return;
        const content = await entry.content();
        if (!content) return;
        result[filepath] = decoder.decode(content);
      },
    });
    return result;
  }

  async commit(
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    const files = await this.listFiles();
    for (const file of files) {
      await git.add({ fs: nodeFs, dir: this.repoPath, filepath: file });
    }

    const status = await git.statusMatrix({
      fs: nodeFs,
      dir: this.repoPath,
    });
    for (const [filepath, head, workdir, stage] of status) {
      if (head === 1 && workdir === 0 && stage === 1) {
        await git.remove({ fs: nodeFs, dir: this.repoPath, filepath });
      }
    }

    return git.commit({
      fs: nodeFs,
      dir: this.repoPath,
      message,
      author,
    });
  }

  async log(options?: {
    maxCount?: number;
    ref?: string;
  }): Promise<CommitInfo[]> {
    try {
      const commits = await git.log({
        fs: nodeFs,
        dir: this.repoPath,
        depth: options?.maxCount,
        ref: options?.ref,
      });
      return commits.map((c) => ({
        sha: c.oid,
        message: c.commit.message,
        author: {
          name: c.commit.author.name,
          email: c.commit.author.email,
        },
        timestamp: c.commit.author.timestamp,
      }));
    } catch {
      return [];
    }
  }

  async resolveRef(ref = "HEAD"): Promise<string> {
    return git.resolveRef({
      fs: nodeFs,
      dir: this.repoPath,
      ref,
    });
  }

  async setRemote(url: string, credentials?: GitCredentials): Promise<void> {
    const remotes = await git.listRemotes({
      fs: nodeFs,
      dir: this.repoPath,
    });
    const hasOrigin = remotes.some((r) => r.remote === "origin");

    if (hasOrigin) {
      await git.deleteRemote({
        fs: nodeFs,
        dir: this.repoPath,
        remote: "origin",
      });
    }

    await git.addRemote({
      fs: nodeFs,
      dir: this.repoPath,
      remote: "origin",
      url,
    });

    if (credentials) {
      this.credentials = credentials;
    }
  }

  async fetch(): Promise<void> {
    await git.fetch({
      fs: nodeFs,
      http,
      dir: this.repoPath,
      remote: "origin",
      onAuth: this.credentials
        ? () => ({
            username: this.credentials!.username,
            password: this.credentials!.password,
          })
        : undefined,
    });
  }

  async push(): Promise<void> {
    await git.push({
      fs: nodeFs,
      http,
      dir: this.repoPath,
      remote: "origin",
      onAuth: this.credentials
        ? () => ({
            username: this.credentials!.username,
            password: this.credentials!.password,
          })
        : undefined,
    });
  }

  async checkout(ref?: string): Promise<void> {
    await git.checkout({
      fs: nodeFs,
      dir: this.repoPath,
      ref: ref ?? "main",
      force: true,
    });
  }

  async status(): Promise<RepoStatus> {
    const branch = await this.currentBranch();
    const matrix = await git.statusMatrix({
      fs: nodeFs,
      dir: this.repoPath,
    });
    const modifiedFiles = matrix
      .filter(([, head, workdir]) => head !== workdir)
      .map(([filepath]) => filepath);

    const baseCommit = await this.resolveRef("HEAD").catch(() => null);
    const remoteRef = `refs/remotes/origin/main`;
    const remoteHead = await git
      .resolveRef({ fs: nodeFs, dir: this.repoPath, ref: remoteRef })
      .catch(() => null);

    const { ahead, behind } = await computeAheadBehind({
      dir: this.repoPath,
      local: baseCommit,
      remote: remoteHead,
    });

    return {
      branch,
      dirty: modifiedFiles.length > 0,
      modifiedFiles,
      ahead,
      behind,
      baseCommit,
      remoteHead,
    };
  }

  async currentBranch(): Promise<string> {
    const name = await git.currentBranch({
      fs: nodeFs,
      dir: this.repoPath,
      fullname: false,
    });
    return name ?? "main";
  }

  async listBranches(): Promise<BranchInfo[]> {
    const current = await this.currentBranch();
    const names = await git.listBranches({
      fs: nodeFs,
      dir: this.repoPath,
    });
    const entries = await Promise.all(
      names.map(async (name) => {
        const sha = await git
          .resolveRef({
            fs: nodeFs,
            dir: this.repoPath,
            ref: `refs/heads/${name}`,
          })
          .catch(() => "");
        const createdAt = await tipTimestamp(this.repoPath, sha);
        return {
          name,
          commit: sha,
          isCurrent: name === current,
          createdAt,
        };
      }),
    );
    return entries.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async createBranch(name: string, fromRef?: string): Promise<void> {
    await git.branch({
      fs: nodeFs,
      dir: this.repoPath,
      ref: name,
      object: fromRef,
      checkout: true,
    });
  }

  async deleteBranch(name: string): Promise<void> {
    await git.deleteBranch({
      fs: nodeFs,
      dir: this.repoPath,
      ref: name,
    });
  }

  async hasBranch(name: string): Promise<boolean> {
    try {
      await git.resolveRef({
        fs: nodeFs,
        dir: this.repoPath,
        ref: `refs/heads/${name}`,
      });
      return true;
    } catch {
      return false;
    }
  }

  async workdirDiff(): Promise<DiffEntry[]> {
    const matrix = await git.statusMatrix({
      fs: nodeFs,
      dir: this.repoPath,
    });
    const decoder = new TextDecoder("utf-8");
    const entries: DiffEntry[] = [];

    for (const [filepath, head, workdir] of matrix) {
      if (head === workdir) continue;

      const headContent =
        head === 1 ? await readBlobAtHead(this.repoPath, filepath) : null;
      const workdirContent =
        workdir === 0
          ? null
          : await readWorkdirFile(this.repoPath, filepath, decoder);

      if (head === 0 && workdir !== 0) {
        entries.push({
          path: filepath,
          kind: "added",
          before: null,
          after: workdirContent,
        });
      } else if (head !== 0 && workdir === 0) {
        entries.push({
          path: filepath,
          kind: "deleted",
          before: headContent,
          after: null,
        });
      } else {
        entries.push({
          path: filepath,
          kind: "modified",
          before: headContent,
          after: workdirContent,
        });
      }
    }

    return entries;
  }

  async diff(opts: { base: string; head: string }): Promise<DiffEntry[]> {
    const baseFiles = await this.readAllFilesAtRef(opts.base);
    const headFiles = await this.readAllFilesAtRef(opts.head);
    const allPaths = new Set([
      ...Object.keys(baseFiles),
      ...Object.keys(headFiles),
    ]);
    const entries: DiffEntry[] = [];
    for (const filepath of allPaths) {
      const before = baseFiles[filepath] ?? null;
      const after = headFiles[filepath] ?? null;
      if (before === after) continue;
      if (before == null && after != null) {
        entries.push({
          path: filepath,
          kind: "added",
          before: null,
          after,
        });
      } else if (before != null && after == null) {
        entries.push({
          path: filepath,
          kind: "deleted",
          before,
          after: null,
        });
      } else {
        entries.push({
          path: filepath,
          kind: "modified",
          before,
          after,
        });
      }
    }
    return entries;
  }

  async moveBranch(name: string, sha: string): Promise<void> {
    await git.writeRef({
      fs: nodeFs,
      dir: this.repoPath,
      ref: `refs/heads/${name}`,
      value: sha,
      force: true,
    });
  }

  async resetWorkingTree(): Promise<void> {
    const matrix = await git.statusMatrix({
      fs: nodeFs,
      dir: this.repoPath,
    });
    for (const [filepath, head, workdir] of matrix) {
      if (head === workdir) continue;
      if (head === 0) {
        await fs.unlink(path.join(this.repoPath, filepath)).catch(() => {});
      } else {
        await git.checkout({
          fs: nodeFs,
          dir: this.repoPath,
          filepaths: [filepath],
          force: true,
        });
      }
    }
  }

  async dispose(): Promise<void> {
    await this.releaseFn();
  }
}

async function readBlobAtHead(
  dir: string,
  filepath: string,
): Promise<string | null> {
  try {
    const headOid = await git.resolveRef({ fs: nodeFs, dir, ref: "HEAD" });
    const { blob } = await git.readBlob({
      fs: nodeFs,
      dir,
      oid: headOid,
      filepath,
    });
    return new TextDecoder("utf-8").decode(blob);
  } catch {
    return null;
  }
}

async function readWorkdirFile(
  dir: string,
  filepath: string,
  decoder: TextDecoder,
): Promise<string | null> {
  try {
    const buf = await fs.readFile(path.join(dir, filepath));
    return decoder.decode(buf);
  } catch {
    return null;
  }
}

async function tipTimestamp(dir: string, sha: string): Promise<number | null> {
  if (!sha) return null;
  try {
    const [commit] = await git.log({
      fs: nodeFs,
      dir,
      ref: sha,
      depth: 1,
    });
    return commit?.commit.author.timestamp ?? null;
  } catch {
    return null;
  }
}

async function computeAheadBehind(opts: {
  dir: string;
  local: string | null;
  remote: string | null;
}): Promise<{ ahead: number; behind: number }> {
  if (!opts.local || !opts.remote) return { ahead: 0, behind: 0 };
  if (opts.local === opts.remote) return { ahead: 0, behind: 0 };

  const localAncestry = await commitSet(opts.dir, opts.local);
  const remoteAncestry = await commitSet(opts.dir, opts.remote);

  let ahead = 0;
  for (const sha of localAncestry) {
    if (!remoteAncestry.has(sha)) ahead += 1;
  }
  let behind = 0;
  for (const sha of remoteAncestry) {
    if (!localAncestry.has(sha)) behind += 1;
  }
  return { ahead, behind };
}

async function commitSet(dir: string, ref: string): Promise<Set<string>> {
  try {
    const commits = await git.log({ fs: nodeFs, dir, ref, depth: 500 });
    return new Set(commits.map((c) => c.oid));
  } catch {
    return new Set();
  }
}
