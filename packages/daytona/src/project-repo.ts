import type {
  BranchInfo,
  CommitInfo,
  DiffEntry,
  GitCredentials,
  ProjectRepo,
  RepoStatus,
} from "@catamorphic/git";
import { Daytona } from "@daytonaio/sdk";

interface DaytonaProjectRepoOpts {
  sandboxId: string;
  projectId: string;
  repoPath: string;
  client?: Daytona;
  config?: { apiKey?: string; apiUrl?: string; target?: string };
}

export class DaytonaProjectRepo implements ProjectRepo {
  readonly projectId: string;
  readonly repoPath: string;
  private readonly sandboxId: string;
  private readonly client: Daytona;
  private credentials: GitCredentials | undefined;

  constructor(opts: DaytonaProjectRepoOpts) {
    this.projectId = opts.projectId;
    this.repoPath = opts.repoPath;
    this.sandboxId = opts.sandboxId;
    this.client = opts.client ?? new Daytona(opts.config);
  }

  private async getSandbox() {
    return this.client.get(this.sandboxId);
  }

  async readFile(filePath: string): Promise<string> {
    const sandbox = await this.getSandbox();
    const buffer = await sandbox.fs.downloadFile(
      `${this.repoPath}/${filePath}`,
    );
    return buffer.toString("utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.fs.uploadFile(
      Buffer.from(content),
      `${this.repoPath}/${filePath}`,
    );
  }

  async deleteFile(filePath: string): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.process.executeCommand(`rm -f ${this.repoPath}/${filePath}`);
  }

  async listFiles(): Promise<string[]> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      `find ${this.repoPath} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.turbo/*'`,
    );
    const prefix = `${this.repoPath}/`;
    return result.result
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
      .filter(Boolean);
  }

  async readAllFiles(): Promise<Record<string, string>> {
    const files = await this.listFiles();
    const entries = await Promise.all(
      files.map(async (f) => [f, await this.readFile(f)] as const),
    );
    return Object.fromEntries(entries);
  }

  async readAllFilesAtRef(ref: string): Promise<Record<string, string>> {
    return this.readTreeAtRef(ref);
  }

  async readFilesAtRef(
    ref: string,
    opts: { prefix: string },
  ): Promise<Record<string, string>> {
    return this.readTreeAtRef(ref, opts.prefix);
  }

  async listFilesAtRef(
    ref: string,
    opts?: { prefix?: string },
  ): Promise<string[]> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      `git ls-tree -r --name-only ${ref}${opts?.prefix ? ` -- ${shellQuote(opts.prefix)}` : ""}`,
      this.repoPath,
    );
    return result.result.split("\n").filter(Boolean).sort();
  }

  private async readTreeAtRef(
    ref: string,
    prefix?: string,
  ): Promise<Record<string, string>> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      `git ls-tree -r --name-only ${ref}${prefix ? ` -- ${shellQuote(prefix)}` : ""}`,
      this.repoPath,
    );
    const paths = result.result.split("\n").filter(Boolean);
    const entries = await Promise.all(
      paths.map(async (p) => {
        const content = await sandbox.process.executeCommand(
          `git show ${ref}:${shellQuote(p)}`,
          this.repoPath,
        );
        return [p, content.result] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async commit(
    message: string,
    author: { name: string; email: string },
  ): Promise<string> {
    const sandbox = await this.getSandbox();
    await sandbox.git.add(this.repoPath, ["."]);
    const commitResult = await sandbox.git.commit(
      this.repoPath,
      message,
      author.name,
      author.email,
    );
    return commitResult.sha;
  }

  async log(options?: {
    maxCount?: number;
    ref?: string;
  }): Promise<CommitInfo[]> {
    const sandbox = await this.getSandbox();
    const limit = options?.maxCount ?? 50;
    const ref = options?.ref ?? "HEAD";
    const result = await sandbox.process.executeCommand(
      `git log -${limit} --format='%H|%s|%an|%ae|%at' ${shellQuote(ref)}`,
      this.repoPath,
    );
    return result.result
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, message, name, email, timestamp] = line.split("|") as [
          string,
          string,
          string,
          string,
          string,
        ];
        return {
          sha,
          message,
          author: { name, email },
          timestamp: Number.parseInt(timestamp, 10),
        };
      });
  }

  async resolveRef(ref = "HEAD"): Promise<string> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      `git rev-parse ${ref}`,
      this.repoPath,
    );
    return result.result.trim();
  }

  async setRemote(url: string, credentials?: GitCredentials): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.process.executeCommand(
      "git remote remove origin 2>/dev/null; true",
      this.repoPath,
    );
    await sandbox.process.executeCommand(
      `git remote add origin ${url}`,
      this.repoPath,
    );
    if (credentials) {
      this.credentials = credentials;
    }
  }

  async fetch(): Promise<void> {
    const sandbox = await this.getSandbox();
    const creds = this.credentials;
    if (creds) {
      await sandbox.process.executeCommand(
        `git -c credential.helper='!f() { echo username=${creds.username}; echo password=${creds.password}; }; f' fetch origin`,
        this.repoPath,
      );
    } else {
      await sandbox.process.executeCommand("git fetch origin", this.repoPath);
    }
  }

  async push(): Promise<void> {
    const sandbox = await this.getSandbox();
    const creds = this.credentials;
    if (creds) {
      await sandbox.process.executeCommand(
        `git -c credential.helper='!f() { echo username=${creds.username}; echo password=${creds.password}; }; f' push origin`,
        this.repoPath,
      );
    } else {
      await sandbox.process.executeCommand("git push origin", this.repoPath);
    }
  }

  async checkout(ref?: string): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.process.executeCommand(
      `git checkout --force ${ref ?? "main"}`,
      this.repoPath,
    );
  }

  async status(): Promise<RepoStatus> {
    const sandbox = await this.getSandbox();
    const branch = await this.currentBranch();
    const statusOut = await sandbox.process.executeCommand(
      "git status --porcelain=v1",
      this.repoPath,
    );
    const modifiedFiles = statusOut.result
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    const baseCommit = await this.resolveRef("HEAD").catch(() => null);
    const remoteHead = await this.resolveRef("refs/remotes/origin/main").catch(
      () => null,
    );

    const aheadBehind = await sandbox.process.executeCommand(
      "git rev-list --left-right --count HEAD...refs/remotes/origin/main 2>/dev/null || echo '0\t0'",
      this.repoPath,
    );
    const [aheadStr, behindStr] = aheadBehind.result.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadStr ?? "0", 10);
    const behind = Number.parseInt(behindStr ?? "0", 10);

    return {
      branch,
      dirty: modifiedFiles.length > 0,
      modifiedFiles,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      baseCommit,
      remoteHead,
    };
  }

  async currentBranch(): Promise<string> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      "git rev-parse --abbrev-ref HEAD",
      this.repoPath,
    );
    return result.result.trim() || "main";
  }

  async listBranches(): Promise<BranchInfo[]> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      "git for-each-ref --format='%(refname:short)|%(objectname)|%(committerdate:unix)' refs/heads",
      this.repoPath,
    );
    const current = await this.currentBranch();
    return result.result
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, commit, ts] = line.split("|") as [string, string, string];
        return {
          name,
          commit,
          isCurrent: name === current,
          createdAt: Number.parseInt(ts ?? "0", 10) || null,
        };
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async createBranch(name: string, fromRef?: string): Promise<void> {
    const sandbox = await this.getSandbox();
    const args = fromRef
      ? `checkout -b ${shellQuote(name)} ${shellQuote(fromRef)}`
      : `checkout -b ${shellQuote(name)}`;
    await sandbox.process.executeCommand(`git ${args}`, this.repoPath);
  }

  async deleteBranch(name: string): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.process.executeCommand(
      `git branch -D ${shellQuote(name)}`,
      this.repoPath,
    );
  }

  async hasBranch(name: string): Promise<boolean> {
    const sandbox = await this.getSandbox();
    const result = await sandbox.process.executeCommand(
      `git show-ref --verify --quiet refs/heads/${shellQuote(name)} && echo yes || echo no`,
      this.repoPath,
    );
    return result.result.trim() === "yes";
  }

  async workdirDiff(): Promise<DiffEntry[]> {
    const sandbox = await this.getSandbox();
    const statusOut = await sandbox.process.executeCommand(
      "git status --porcelain=v1",
      this.repoPath,
    );
    const entries: DiffEntry[] = [];
    for (const line of statusOut.result.split("\n").filter(Boolean)) {
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (code.includes("?")) {
        const after = await this.readFile(path).catch(() => "");
        entries.push({ path, kind: "added", before: null, after });
      } else if (code.includes("D")) {
        const before = await sandbox.process
          .executeCommand(`git show HEAD:${shellQuote(path)}`, this.repoPath)
          .then((r) => r.result)
          .catch(() => "");
        entries.push({ path, kind: "deleted", before, after: null });
      } else {
        const before = await sandbox.process
          .executeCommand(`git show HEAD:${shellQuote(path)}`, this.repoPath)
          .then((r) => r.result)
          .catch(() => "");
        const after = await this.readFile(path).catch(() => "");
        entries.push({ path, kind: "modified", before, after });
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
        entries.push({ path: filepath, kind: "added", before: null, after });
      } else if (before != null && after == null) {
        entries.push({
          path: filepath,
          kind: "deleted",
          before,
          after: null,
        });
      } else {
        entries.push({ path: filepath, kind: "modified", before, after });
      }
    }
    return entries;
  }

  async moveBranch(name: string, sha: string): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.process.executeCommand(
      `git update-ref refs/heads/${shellQuote(name)} ${shellQuote(sha)}`,
      this.repoPath,
    );
  }

  async resetWorkingTree(): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.process.executeCommand(
      "git reset --hard HEAD && git clean -fd",
      this.repoPath,
    );
  }

  async dispose(): Promise<void> {
    // Dev sandboxes are long-lived; no cleanup on dispose
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
