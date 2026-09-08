import fs from "node:fs/promises";
import path from "node:path";
import {
  INTERNAL_REMOTE_PREFIX,
  nativeGit,
  nativeGitBytes,
} from "./native-git.js";
import {
  ensurePersonalFilesExcluded,
  isPersonalFile,
} from "./personal-files.js";
import { assertSafePath, ProjectRepoImpl } from "./project-repo.js";
import type {
  BranchInfo,
  CommitInfo,
  DiffEntry,
  GitCredentials,
  RepoStatus,
} from "./types.js";

/** Local-checkout adapter. File IO stays shared; Git honors the user's repository format and tools. */
export class NativeProjectRepo extends ProjectRepoImpl {
  private nativeRemote:
    | { url: string; credentials?: GitCredentials }
    | undefined;

  override async setRemote(
    url: string,
    credentials?: GitCredentials,
  ): Promise<void> {
    const exists = await nativeGit(this.repoPath, [
      "remote",
      "get-url",
      "origin",
    ]).then(
      () => true,
      () => false,
    );
    await nativeGit(this.repoPath, [
      "remote",
      exists ? "set-url" : "add",
      "origin",
      url,
    ]);
    this.nativeRemote = { url, credentials };
  }
  override async fetch(): Promise<void> {
    const remote = this.nativeRemote;
    await nativeGit(
      this.repoPath,
      ["fetch", "origin"],
      remote?.credentials
        ? { ...remote.credentials, url: remote.url }
        : undefined,
    );
  }
  override async push(): Promise<void> {
    const remote = this.nativeRemote;
    await nativeGit(
      this.repoPath,
      ["push"],
      remote?.credentials
        ? { ...remote.credentials, url: remote.url }
        : undefined,
    );
  }

  override async readFileBytes(filePath: string): Promise<Uint8Array | null> {
    assertSafePath(filePath);
    const target = path.join(this.repoPath, filePath);
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!stat) return null;
    if (stat.isSymbolicLink())
      return new TextEncoder().encode(await fs.readlink(target));
    if (!stat.isFile()) return null;
    if (stat.size > 64 * 1024 * 1024)
      throw new Error(
        "This file exceeds the 64 MB document limit. Open it from its folder.",
      );
    return new Uint8Array(await fs.readFile(target));
  }

  override async listFiles(opts?: { prefix?: string }): Promise<string[]> {
    const pathspec = opts?.prefix ? ["--", opts.prefix] : [];
    const [output, removed] = await Promise.all([
      nativeGit(this.repoPath, [
        "ls-files",
        "--stage",
        "--others",
        "--exclude-standard",
        "-z",
        ...pathspec,
      ]),
      nativeGit(this.repoPath, ["ls-files", "--deleted", "-z", ...pathspec]),
    ]);
    const deleted = new Set(removed.split("\0"));
    const files = new Set<string>();
    for (const record of output.split("\0").filter(Boolean)) {
      const tracked = /^(\d{6}) [a-f0-9]+ [0-3]\t(.*)$/s.exec(record);
      if (tracked?.[1] === "160000") continue;
      const file = tracked?.[2] ?? record;
      if (
        !isPersonalFile(file) &&
        !deleted.has(file) &&
        !file.startsWith(".catamorphic/worktrees/")
      )
        files.add(file);
    }
    return [...files].sort();
  }

  async findFilesContaining(input: {
    text: string;
    ref?: string;
    globs: readonly string[];
  }): Promise<string[]> {
    const ref = input.ref ? await this.resolveRef(input.ref) : undefined;
    try {
      const output = await nativeGit(this.repoPath, [
        "grep",
        "-l",
        "-I",
        "-z",
        "-F",
        ...(ref ? [] : ["--untracked", "--exclude-standard"]),
        "-e",
        input.text,
        ...(ref ? [ref] : []),
        "--",
        ...input.globs,
      ]);
      return output
        .split("\0")
        .filter(Boolean)
        .map((file) => (ref ? file.slice(ref.length + 1) : file))
        .filter((file) => !isPersonalFile(file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 1)
        return [];
      throw error;
    }
  }

  override async resolveRef(ref = "HEAD"): Promise<string> {
    return (
      await nativeGit(this.repoPath, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        ref,
      ])
    ).trim();
  }

  override async currentBranch(): Promise<string> {
    return (
      (await nativeGit(this.repoPath, ["branch", "--show-current"])).trim() ||
      "HEAD"
    );
  }

  override async status(): Promise<RepoStatus> {
    const output = await nativeGit(this.repoPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const records = output.split("\0");
    const modifiedFiles: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      modifiedFiles.push(record.slice(3));
      if (/[RC]/.test(record.slice(0, 2))) {
        const previous = records[++i];
        if (record.slice(0, 2).includes("R") && previous)
          modifiedFiles.push(previous);
      }
    }
    const baseCommit = await this.resolveRef().catch(() => null);
    const remoteHead = await this.resolveRef(
      `${INTERNAL_REMOTE_PREFIX}/main`,
    ).catch(() => null);
    const counts =
      baseCommit && remoteHead
        ? (
            await nativeGit(this.repoPath, [
              "rev-list",
              "--left-right",
              "--count",
              `${baseCommit}...${remoteHead}`,
            ])
          )
            .trim()
            .split(/\s+/)
            .map(Number)
        : [0, 0];
    return {
      branch: await this.currentBranch(),
      dirty: modifiedFiles.length > 0,
      modifiedFiles,
      baseCommit,
      remoteHead,
      ahead: counts[0] ?? 0,
      behind: counts[1] ?? 0,
    };
  }

  override async commit(
    message: string,
    author: { name: string; email: string },
    opts?: { paths?: readonly string[] },
  ): Promise<string> {
    const paths = opts?.paths;
    for (const file of paths ?? []) assertSafePath(file);
    if (paths?.length === 0) return this.resolveRef();
    const allIndexed = (
      await nativeGit(this.repoPath, ["ls-files", "-z"])
    ).split("\0");
    if (allIndexed.some(isPersonalFile))
      throw new Error(
        "Personal files are tracked. Remove them from the git index before checkpointing or sharing this project.",
      );
    await ensurePersonalFilesExcluded({ repoPath: this.repoPath });
    // --only commits the requested working-tree paths without sweeping the user's existing index.
    if (!paths) await nativeGit(this.repoPath, ["add", "-A"]);
    else {
      const indexed = new Set(
        (
          await nativeGit(this.repoPath, [
            "--literal-pathspecs",
            "ls-files",
            "-z",
            "--",
            ...paths,
          ])
        ).split("\0"),
      );
      const untracked: string[] = [];
      for (const file of paths) {
        if (
          !indexed.has(file) &&
          (await fs.lstat(path.join(this.repoPath, file)).then(
            () => true,
            () => false,
          ))
        )
          untracked.push(file);
      }
      if (untracked.length)
        await nativeGit(this.repoPath, [
          "--literal-pathspecs",
          "add",
          "--intent-to-add",
          "--",
          ...untracked,
        ]);
    }
    await nativeGit(this.repoPath, [
      "--literal-pathspecs",
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      message,
      ...(paths ? ["--only", "--", ...paths] : []),
    ]);
    return this.resolveRef();
  }

  override async workdirDiff(): Promise<DiffEntry[]> {
    const status = await this.status();
    const entries: DiffEntry[] = [];
    for (const file of status.modifiedFiles) {
      const beforeBytes = status.baseCommit
        ? await this.readBlobAtRef(status.baseCommit, file)
        : null;
      const afterBytes = await this.readFileBytes(file);
      const decode = (bytes: Uint8Array | null): string | null => {
        if (!bytes) return null;
        if (bytes.length > 1024 * 1024 || bytes.includes(0))
          return "Binary or large file. Open from its folder to inspect.";
        return new TextDecoder().decode(bytes);
      };
      entries.push({
        path: file,
        kind: !beforeBytes ? "added" : !afterBytes ? "deleted" : "modified",
        before: decode(beforeBytes),
        after: decode(afterBytes),
      });
    }
    return entries;
  }

  override async resetWorkingTree(): Promise<void> {
    await nativeGit(this.repoPath, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ".",
      ":!.catamorphic/personal/",
    ]);
    await nativeGit(this.repoPath, [
      "clean",
      "-fd",
      "--",
      ".",
      ":!store/",
      ":!.catamorphic/worktrees/",
      ":!.catamorphic/personal/",
    ]);
  }

  override async checkout(ref?: string): Promise<void> {
    await nativeGit(this.repoPath, ["checkout", ref ?? "main"]);
  }
  override async createBranch(name: string, fromRef?: string): Promise<void> {
    await nativeGit(this.repoPath, [
      "checkout",
      "-b",
      name,
      ...(fromRef ? [fromRef] : []),
    ]);
  }
  override async deleteBranch(name: string): Promise<void> {
    await nativeGit(this.repoPath, ["branch", "-D", name]);
  }
  override async hasBranch(name: string): Promise<boolean> {
    return this.resolveRef(`refs/heads/${name}`).then(
      () => true,
      () => false,
    );
  }
  override async moveBranch(name: string, sha: string): Promise<void> {
    await nativeGit(this.repoPath, ["update-ref", `refs/heads/${name}`, sha]);
  }
  override async listBranches(): Promise<BranchInfo[]> {
    const current = await this.currentBranch();
    return (
      await nativeGit(this.repoPath, [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)",
        "refs/heads/",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", commit = "", timestamp] = line.split("\t");
        return {
          name,
          commit,
          isCurrent: current === name,
          createdAt: Number(timestamp) || null,
        };
      });
  }
  override async log(options?: {
    maxCount?: number;
    ref?: string;
  }): Promise<CommitInfo[]> {
    const output = await nativeGit(this.repoPath, [
      "log",
      `--max-count=${options?.maxCount ?? 50}`,
      "--format=%H%x00%an%x00%ae%x00%at%x00%B%x00",
      options?.ref ?? "HEAD",
      "--",
    ]).catch(() => "");
    const parts = output.split("\0");
    const commits: CommitInfo[] = [];
    for (let i = 0; i + 4 < parts.length; i += 5) {
      const [sha = "", name = "", email = "", timestamp = "0", message = ""] =
        parts.slice(i, i + 5);
      commits.push({
        sha: sha.trim(),
        author: { name, email },
        timestamp: Number(timestamp),
        message,
      });
    }
    return commits;
  }
  override async listFilesAtRef(
    ref: string,
    opts?: { prefix?: string },
  ): Promise<string[]> {
    return (await this.listBlobsAtRef(ref, opts)).map((entry) => entry.path);
  }
  override async listBlobsAtRef(
    ref: string,
    opts?: { prefix?: string },
  ): Promise<Array<{ path: string; oid: string }>> {
    const sha = await this.resolveRef(ref);
    const output = await nativeGit(this.repoPath, [
      "ls-tree",
      "-r",
      "-z",
      sha,
      ...(opts?.prefix ? ["--", opts.prefix] : []),
    ]);
    return output
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const tab = entry.indexOf("\t");
        const [, type, oid] = entry.slice(0, tab).split(" ");
        return type === "blob" && oid && !isPersonalFile(entry.slice(tab + 1))
          ? [{ path: entry.slice(tab + 1), oid }]
          : [];
      });
  }
  override async readBlobAtRef(
    ref: string,
    filePath: string,
  ): Promise<Uint8Array | null> {
    assertSafePath(filePath);
    const sha = await this.resolveRef(ref);
    const size = await nativeGit(this.repoPath, [
      "cat-file",
      "-s",
      `${sha}:${filePath}`,
    ]).then(
      (value) => Number(value.trim()),
      () => null,
    );
    if (size === null) return null;
    if (size > 64 * 1024 * 1024)
      throw new Error(
        "This file exceeds the 64 MB document limit. Open it from its folder.",
      );
    return nativeGitBytes(this.repoPath, ["show", `${sha}:${filePath}`]);
  }
  override async readAllFilesAtRef(
    ref: string,
  ): Promise<Record<string, string>> {
    return this.readFilesAtRef(ref, { prefix: "" });
  }
  override async readFilesAtRef(
    ref: string,
    opts: { prefix: string },
  ): Promise<Record<string, string>> {
    const sha = await this.resolveRef(ref);
    const files: Record<string, string> = {};
    for (const entry of await this.listBlobsAtRef(sha, opts)) {
      const size = Number(
        (await nativeGit(this.repoPath, ["cat-file", "-s", entry.oid])).trim(),
      );
      if (size > 2 * 1024 * 1024) continue;
      const bytes = await this.readBlobAtRef(sha, entry.path);
      if (bytes && bytes.byteLength <= 2 * 1024 * 1024 && !bytes.includes(0)) {
        try {
          files[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
        } catch {
          /* Binary files are read through readBlobAtRef. */
        }
      }
    }
    return files;
  }
  override async diff(opts: {
    base: string;
    head: string;
  }): Promise<DiffEntry[]> {
    const files = (
      await nativeGit(this.repoPath, [
        "diff",
        "--name-only",
        "-z",
        opts.base,
        opts.head,
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const result: DiffEntry[] = [];
    for (const file of files) {
      const beforeBytes = await this.readBlobAtRef(opts.base, file);
      const afterBytes = await this.readBlobAtRef(opts.head, file);
      const before = beforeBytes ? new TextDecoder().decode(beforeBytes) : null;
      const after = afterBytes ? new TextDecoder().decode(afterBytes) : null;
      result.push({
        path: file,
        kind:
          before === null ? "added" : after === null ? "deleted" : "modified",
        before,
        after,
      });
    }
    return result;
  }
}
