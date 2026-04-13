import { Daytona } from "@daytonaio/sdk";
import type { CommitInfo, GitCredentials, ProjectRepo } from "./types.js";

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

  async log(options?: { maxCount?: number }): Promise<CommitInfo[]> {
    const sandbox = await this.getSandbox();
    const limit = options?.maxCount ?? 50;
    const result = await sandbox.process.executeCommand(
      `git log -${limit} --format='%H|%s|%an|%ae|%at'`,
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
      `git checkout ${ref ?? "main"}`,
      this.repoPath,
    );
  }

  async dispose(): Promise<void> {
    // Dev sandboxes are long-lived; no cleanup on dispose
  }
}
