import fs from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_APP_DATA_DIR,
  PROJECT_PERSONAL_DIR,
  publishedRef,
} from "@catamorphic/workflow/project-layout";
import ignore, { type Ignore } from "ignore";
import { type FileReadOptions, readFileSnapshot } from "./file-reads.js";
import { hasLocalGit, nativeGit, nativeGitBytes } from "./native-git.js";
import {
  ensurePersonalFilesExcluded,
  isPersonalFile,
} from "./personal-files.js";
import {
  assertSafePath,
  ProjectRepoImpl,
  WALK_SKIPPED_DIRS,
  walkDirectory,
} from "./project-repo.js";
import type { BranchInfo, CommitInfo, DiffEntry, RepoStatus } from "./types.js";

/**
 * Walks of folders without Git, in flight, by root and folder. A new chat
 * asks for the same listing from several services at once (agents, skills,
 * apps, workflows); they share one walk instead of each walking the tree.
 */
const unversionedWalks = new Map<string, Promise<string[]>>();

/**
 * Every file under `folder` (relative, `""` for the whole tree, else ending
 * in `/`) of a folder without Git, as a whole-tree walk would list them:
 * nothing under an ignored directory or a nested repository on the way.
 */
function walkUnversioned(root: string, folder: string): Promise<string[]> {
  const key = `${root}\0${folder}`;
  const inFlight = unversionedWalks.get(key);
  if (inFlight) return inFlight;
  const walk = (async () => {
    // What the whole-tree walk would decide on the way down to `folder`:
    // its ignore rules, ignored and private directories, nested repositories.
    const rules: Array<{ base: string; matcher: Ignore }> = [];
    let current = root;
    for (const segment of folder.split("/").filter(Boolean)) {
      const content = await fs
        .readFile(path.join(current, ".gitignore"), "utf8")
        .catch(() => "");
      if (content)
        rules.push({ base: current, matcher: ignore().add(content) });
      const next = path.join(current, segment);
      if (
        WALK_SKIPPED_DIRS.has(segment) ||
        isPersonalFile(path.relative(root, next)) ||
        isIgnoredDirectory(rules, next)
      )
        return [];
      // The whole-tree walk lists a linked folder as an entry, never its files.
      const stat = await fs.lstat(next).catch(() => undefined);
      if (!stat?.isDirectory()) return [];
      current = next;
      if (
        await fs.stat(path.join(current, ".git")).then(
          () => true,
          () => false,
        )
      )
        return [];
    }
    try {
      return await walkDirectory(current, root, {
        includeHidden: true,
        excludeNestedRepositories: true,
        tracked: new Set(),
        trackedDirectories: new Set(),
        rules,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return [];
      throw error;
    }
  })().finally(() => unversionedWalks.delete(key));
  unversionedWalks.set(key, walk);
  return walk;
}

function isIgnoredDirectory(
  rules: ReadonlyArray<{ base: string; matcher: Ignore }>,
  directory: string,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    const result = rule.matcher.test(`${path.relative(rule.base, directory)}/`);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

/** The deepest folder a path prefix names entirely: `a/b/` for `a/b/c`. */
function folderOf(prefix: string): string {
  const cut = prefix.lastIndexOf("/");
  return cut < 0 ? "" : prefix.slice(0, cut + 1);
}

/** The folder every glob starts in before its first wildcard, or `""`. */
function literalFolder(globs: readonly string[]): string {
  const folders = globs.map((glob) => {
    const wild = glob.search(/[*?[{]/);
    return folderOf(wild < 0 ? glob : glob.slice(0, wild));
  });
  if (folders.length === 0) return "";
  return folders.reduce((common, folder) => {
    let end = 0;
    for (let i = 0; i < Math.min(common.length, folder.length); i++) {
      if (common[i] !== folder[i]) break;
      if (common[i] === "/") end = i + 1;
    }
    return common.slice(0, end);
  });
}

/** Local-checkout adapter. File IO stays shared; Git honors the user's repository format and tools. */
export class NativeProjectRepo extends ProjectRepoImpl {
  protected override readonly followsSymlinks = true;

  override async readFileBytes(filePath: string): Promise<Uint8Array | null> {
    assertSafePath(filePath);
    const target = path.join(this.repoPath, filePath);
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
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
    return this.readSnapshotBytes(filePath, 64 * 1024 * 1024);
  }

  override async readAllFiles(
    options: FileReadOptions = {},
  ): Promise<Record<string, string>> {
    return this.readSnapshot(await this.listFiles(), options);
  }

  private readSnapshot(
    paths: string[],
    options: FileReadOptions,
  ): Promise<Record<string, string>> {
    return readFileSnapshot({
      paths,
      options: { maxFileBytes: 2 * 1024 * 1024, ...options },
      read: async (file, maxBytes) => {
        const stat = await fs.lstat(path.join(this.repoPath, file));
        if (!stat.isFile() || stat.size > maxBytes) return null;
        const bytes = await this.readSnapshotBytes(file, maxBytes);
        if (bytes.includes(0)) return null;
        try {
          return new TextDecoder("utf8", { fatal: true }).decode(bytes);
        } catch {
          return null;
        }
      },
    });
  }

  override async listFiles(opts?: { prefix?: string }): Promise<string[]> {
    if (!(await hasLocalGit({ path: this.repoPath }))) {
      if (opts?.prefix) assertSafePath(opts.prefix);
      const prefix = opts?.prefix ?? "";
      const files = await walkUnversioned(this.repoPath, folderOf(prefix));
      return files.filter((file) => file.startsWith(prefix)).sort();
    }
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
      if (!isPersonalFile(file) && !deleted.has(file)) files.add(file);
    }
    return [...files].sort();
  }

  async findFilesContaining(input: {
    text: string;
    ref?: string;
    globs: readonly string[];
  }): Promise<string[]> {
    if (!input.ref && !(await hasLocalGit({ path: this.repoPath }))) {
      const matches = (file: string, glob: string) =>
        path.matchesGlob(file, glob) ||
        (!glob.includes("/") && path.matchesGlob(path.basename(file), glob));
      const includes = input.globs.filter((glob) => !glob.startsWith(":!"));
      const excludes = input.globs
        .filter((glob) => glob.startsWith(":!"))
        .map((glob) => glob.slice(2));
      const files = await this.readSnapshot(
        await this.listFiles({ prefix: literalFolder(includes) }),
        {
          filter: (file) =>
            includes.some((glob) => matches(file, glob)) &&
            !excludes.some((glob) => matches(file, glob)),
        },
      );
      return Object.entries(files)
        .filter(([, content]) => content.includes(input.text))
        .map(([file]) => file);
    }
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
    if (!(await hasLocalGit({ path: this.repoPath }))) return "main";
    return (
      (await nativeGit(this.repoPath, ["branch", "--show-current"])).trim() ||
      "HEAD"
    );
  }

  override async status(): Promise<RepoStatus> {
    if (!(await hasLocalGit({ path: this.repoPath }))) {
      const modifiedFiles = await this.listFiles();
      return {
        branch: "main",
        dirty: modifiedFiles.length > 0,
        modifiedFiles,
        baseCommit: null,
        remoteHead: null,
        ahead: 0,
        behind: 0,
      };
    }
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
    const remoteHead = await this.resolveRef(publishedRef()).catch(() => null);
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
    opts?: { paths?: readonly string[]; allowEmpty?: boolean },
  ): Promise<string> {
    const paths = opts?.paths;
    for (const file of paths ?? []) assertSafePath(file);
    if (paths?.length === 0) return this.resolveRef();
    if (!(await hasLocalGit({ path: this.repoPath })))
      await nativeGit(this.repoPath, ["init", "--initial-branch=main"]);
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
      ...(opts?.allowEmpty ? ["--allow-empty"] : []),
      ...(paths ? ["--only", "--", ...paths] : []),
    ]);
    return this.resolveRef();
  }

  override async workdirDiff(): Promise<DiffEntry[]> {
    const status = await this.status();
    const entries: DiffEntry[] = [];
    let retainedBytes = 0;
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
      const entry: DiffEntry = {
        path: file,
        kind: !beforeBytes ? "added" : !afterBytes ? "deleted" : "modified",
        before: decode(beforeBytes),
        after: decode(afterBytes),
      };
      retainedBytes += Buffer.byteLength(JSON.stringify(entry));
      if (retainedBytes > 64 * 1024 * 1024)
        throw new Error("Working diff exceeds the 64 MiB snapshot limit");
      entries.push(entry);
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
      `:!${PROJECT_PERSONAL_DIR}/`,
    ]);
    await nativeGit(this.repoPath, [
      "clean",
      "-fd",
      "-e",
      `${PROJECT_APP_DATA_DIR}/`,
      "-e",
      `${PROJECT_PERSONAL_DIR}/`,
      "--",
      ".",
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
    if (!(await hasLocalGit({ path: this.repoPath }))) return [];
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
    options?: { maxBytes?: number },
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
    if (options?.maxBytes !== undefined && size > options.maxBytes)
      throw new Error(
        `Project file '${filePath}' exceeds the ${options.maxBytes}-byte snapshot limit`,
      );
    if (size > 64 * 1024 * 1024)
      throw new Error(
        "This file exceeds the 64 MB document limit. Open it from its folder.",
      );
    return nativeGitBytes(this.repoPath, ["show", `${sha}:${filePath}`]);
  }
  override async readAllFilesAtRef(
    ref: string,
    options?: FileReadOptions,
  ): Promise<Record<string, string>> {
    return this.readTextSnapshotAtRef(ref, { prefix: "" }, options);
  }
  override async readFilesAtRef(
    ref: string,
    opts: { prefix: string },
  ): Promise<Record<string, string>> {
    return this.readTextSnapshotAtRef(ref, opts);
  }
  private async readTextSnapshotAtRef(
    ref: string,
    opts: { prefix: string },
    options?: FileReadOptions,
  ): Promise<Record<string, string>> {
    const sha = await this.resolveRef(ref);
    const blobs = await this.listBlobsAtRef(sha, opts);
    const byPath = new Map(blobs.map((entry) => [entry.path, entry.oid]));
    return readFileSnapshot({
      paths: blobs.map((entry) => entry.path),
      options: { maxFileBytes: 2 * 1024 * 1024, ...options },
      read: async (file, maxBytes) => {
        const oid = byPath.get(file);
        if (!oid) return null;
        const size = Number(
          (await nativeGit(this.repoPath, ["cat-file", "-s", oid])).trim(),
        );
        if (size > maxBytes) return null;
        const bytes = await this.readBlobAtRef(sha, file, { maxBytes });
        if (!bytes || bytes.includes(0)) return null;
        try {
          return new TextDecoder("utf8", { fatal: true }).decode(bytes);
        } catch {
          return null;
        }
      },
    });
  }
}
