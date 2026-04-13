import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { CommitInfo, GitCredentials, ProjectRepo } from "./types.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".turbo"]);

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
    if (entry.name.startsWith(".")) continue;

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

  async log(options?: { maxCount?: number }): Promise<CommitInfo[]> {
    const commits = await git.log({
      fs: nodeFs,
      dir: this.repoPath,
      depth: options?.maxCount,
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
    });
  }

  async dispose(): Promise<void> {
    await this.releaseFn();
  }
}
