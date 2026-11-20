import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeGit, nativeGitBytes } from "./native-git.js";
import type { DraftChange } from "./origin-draft.js";
import { isPersonalFile } from "./personal-files.js";

/**
 * Saving a sandbox's workspace (ADR 0341). The sandbox packs the files that
 * changed since the last save, with a manifest naming each path, its Git
 * mode and its blob, into one Git pack. Everything read here came from the
 * sandbox and is treated as hostile: the pack is indexed in a repository
 * of its own that is thrown away, every path is checked before anything is
 * written, and no write ever follows a link.
 */

/** A save that was refused, or whose pack or manifest could not be read. */
export class WorkspaceSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSaveError";
  }
}

/** One change of a save: a deletion, a file with its mode, or a link. */
export type SavedChange =
  | { path: string; kind: "deleted" }
  | { path: string; kind: "file"; mode: "100644" | "100755"; oid: string }
  | { path: string; kind: "link"; oid: string };

const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const RECORD =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([AMTD])$/;
const GITLINK = "160000";
/** Code points HFS+ ignores in names, so `.g‌it` opens `.git`. */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;
/** The longest link target any supported filesystem takes. */
const MAX_LINK_BYTES = 4096;
/** A manifest larger than this names more paths than a save may carry. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Whether a path segment names a Git directory on any filesystem. */
function isGitDirectoryName(segment: string): boolean {
  // NTFS drops trailing dots and spaces and reads `:stream` as the file.
  const name = (segment.split(":")[0] ?? "")
    .replace(HFS_IGNORED, "")
    .replace(/[. ]+$/, "")
    .toLowerCase();
  return name === ".git" || name === "git~1";
}

/**
 * Refuse a path a save may never name: one that is absolute, leaves the
 * checkout, or passes through a Git directory. Git writes none of these
 * into a tree, so a manifest holding one was not made by Git.
 */
export function assertSavedPath(filePath: string): void {
  const refuse = (why: string): never => {
    throw new WorkspaceSaveError(
      `the workspace names a path that ${why}: ${JSON.stringify(filePath.slice(0, 200))}`,
    );
  };
  if (filePath.length === 0 || filePath.includes("\0")) refuse("is not a path");
  if (filePath.startsWith("/")) refuse("is absolute");
  // Where a backslash separates folders, it could leave the checkout.
  if (
    path.sep === "\\" &&
    (filePath.includes("\\") || /^[A-Za-z]:/.test(filePath))
  )
    refuse("is not portable");
  for (const segment of filePath.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      refuse("leaves the checkout");
    if (isGitDirectoryName(segment)) refuse("is inside a Git directory");
  }
}

/**
 * Read a save's manifest: the NUL-separated records of
 * `git diff-tree -r --no-renames --raw --no-abbrev -z` between the last
 * saved tree and the snapshot. Throws {@link WorkspaceSaveError} for a
 * record Git would not write or a path a save may not name. Nested
 * repositories (gitlinks) have no blob and are left out.
 */
export function parseSavedChanges(manifest: Uint8Array): SavedChange[] {
  const fields = splitOnNul(manifest);
  if (fields.length % 2 !== 0)
    throw new WorkspaceSaveError("the list of changed files was cut short");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const changes: SavedChange[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    const record = RECORD.exec(
      Buffer.from(fields[index] ?? new Uint8Array()).toString("latin1"),
    );
    if (!record)
      throw new WorkspaceSaveError("the list of changed files was unreadable");
    const [, before = "", after = "", , oid = "", status = ""] = record;
    const name = decodePath(decoder, fields[index + 1] ?? new Uint8Array());
    assertSavedPath(name);
    if (seen.has(name))
      throw new WorkspaceSaveError(
        `the workspace names ${JSON.stringify(name)} twice`,
      );
    seen.add(name);
    if ((status === "D") !== (after === "000000"))
      throw new WorkspaceSaveError("the list of changed files was unreadable");
    if (after === "000000" || after === GITLINK) {
      // A nested repository that took a file's place: the file is gone.
      if (before !== GITLINK && before !== "000000")
        changes.push({ path: name, kind: "deleted" });
    } else if (after === "100644" || after === "100755") {
      changes.push({ path: name, kind: "file", mode: after, oid });
    } else if (after === "120000") {
      changes.push({ path: name, kind: "link", oid });
    } else {
      throw new WorkspaceSaveError(
        `the workspace holds ${JSON.stringify(name)} with a mode (${after}) that cannot be saved`,
      );
    }
  }
  assertNoFileIsAFolder(changes);
  return changes;
}

function splitOnNul(bytes: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length)
    throw new WorkspaceSaveError("the list of changed files was cut short");
  return fields;
}

function decodePath(decoder: TextDecoder, bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new WorkspaceSaveError(
      "the workspace holds a file whose name is not UTF-8; rename it so the workspace can be saved",
    );
  }
}

/** No written path may also be a folder of another: Git's trees never say so. */
function assertNoFileIsAFolder(changes: readonly SavedChange[]): void {
  const written = new Set(
    changes.flatMap((change) =>
      change.kind === "deleted" ? [] : [change.path],
    ),
  );
  for (const file of written) {
    const segments = file.split("/");
    for (let depth = 1; depth < segments.length; depth += 1)
      if (written.has(segments.slice(0, depth).join("/")))
        throw new WorkspaceSaveError(
          `the workspace names ${JSON.stringify(file)} inside something that is not a folder`,
        );
  }
}

/** Git with nothing inherited that could prompt or lock. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * A pack a sandbox sent, indexed in a repository of its own under the
 * host's temporary directory. Native Git verifies the pack's checksum and
 * every object's id as it indexes, so bytes damaged or cut short on the
 * way are refused, never saved. Dispose it when the save is done.
 */
export class ReceivedPack {
  private reader: BlobReader | undefined;

  private constructor(private readonly directory: string) {}

  /** Index the pack arriving as `chunks`, in order. */
  static async receive(input: {
    /** The sandbox repository's object format, by its ids' length. */
    objectFormat: "sha1" | "sha256";
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<ReceivedPack> {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "work-save-"));
    try {
      await nativeGit(directory, [
        "init",
        "--bare",
        "--quiet",
        ...(input.objectFormat === "sha256" ? ["--object-format=sha256"] : []),
      ]);
      await indexPack({ directory, chunks: input.chunks });
      return new ReceivedPack(directory);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Make sure every id names a file's content in the pack, and that
   * together they hold at most `maxBytes`, before anything is written.
   */
  async assertBlobs(input: {
    oids: readonly string[];
    maxBytes: number;
  }): Promise<void> {
    const oids = [...new Set(input.oids)];
    if (oids.length === 0) return;
    for (const oid of oids)
      if (!OBJECT_ID.test(oid))
        throw new WorkspaceSaveError("the workspace names an invalid object");
    const output = Buffer.from(
      await nativeGitBytes(
        this.directory,
        ["cat-file", "--batch-check"],
        new TextEncoder().encode(`${oids.join("\n")}\n`),
      ),
    ).toString("latin1");
    const lines = output.split("\n").filter(Boolean);
    if (lines.length !== oids.length)
      throw new WorkspaceSaveError("the saved files could not be listed");
    let total = 0;
    for (const [index, line] of lines.entries()) {
      const [oid, type, size] = line.split(" ");
      if (oid !== oids[index] || type !== "blob" || !/^\d+$/.test(size ?? ""))
        throw new WorkspaceSaveError(
          "the workspace's pack lacks a file it names",
        );
      total += Number(size);
      if (total > input.maxBytes)
        throw new WorkspaceSaveError(
          `the workspace changed more than ${Math.floor(input.maxBytes / (1024 * 1024))} MiB of files at once`,
        );
    }
  }

  /** One blob's bytes, refused when larger than `maxBytes`. */
  async read(input: { oid: string; maxBytes: number }): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    await this.stream({
      oid: input.oid,
      maxBytes: input.maxBytes,
      write: async (chunk) => {
        parts.push(Uint8Array.from(chunk));
      },
    });
    return new Uint8Array(Buffer.concat(parts));
  }

  /** Stream one blob's bytes to `write`, in order. */
  async copy(input: {
    oid: string;
    write: (chunk: Uint8Array) => Promise<void>;
  }): Promise<void> {
    await this.stream({ ...input, maxBytes: Number.MAX_SAFE_INTEGER });
  }

  private async stream(input: {
    oid: string;
    maxBytes: number;
    write: (chunk: Uint8Array) => Promise<void>;
  }): Promise<void> {
    this.reader ??= new BlobReader(this.directory);
    const reader = this.reader;
    try {
      await reader.copy(input);
    } catch (error) {
      // A read that stopped part way leaves Git's answer half consumed.
      reader.close();
      if (this.reader === reader) this.reader = undefined;
      throw error;
    }
  }

  /** The manifest blob, parsed and checked. */
  async changes(input: { manifest: string }): Promise<SavedChange[]> {
    return parseSavedChanges(
      await this.read({ oid: input.manifest, maxBytes: MAX_MANIFEST_BYTES }),
    );
  }

  async dispose(): Promise<void> {
    this.reader?.close();
    this.reader = undefined;
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}

/** Feed `chunks` to `git index-pack`, which checks the pack as it reads. */
async function indexPack(input: {
  directory: string;
  chunks: AsyncIterable<Uint8Array>;
}): Promise<void> {
  const child = spawn("git", ["-C", input.directory, "index-pack", "--stdin"], {
    env: gitEnvironment(),
    stdio: ["pipe", "ignore", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 16) stderr.push(chunk);
  });
  // Git that stopped reading reports why through its exit, not a pipe error.
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  try {
    for await (const chunk of input.chunks) {
      if (child.exitCode !== null || child.stdin.destroyed) break;
      if (!child.stdin.write(chunk))
        await new Promise<void>((resolve) => {
          const done = () => {
            child.stdin.off("drain", done);
            child.off("close", done);
            resolve();
          };
          child.stdin.once("drain", done);
          child.once("close", done);
        });
    }
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => null);
    throw error;
  }
  child.stdin.end();
  const code = await exited;
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim().split("\n")[0];
    throw new WorkspaceSaveError(
      `the workspace's files arrived damaged${detail ? ` (${detail.slice(0, 200)})` : ""}`,
    );
  }
}

/**
 * One `git cat-file --batch` over a repository, asked for one object at a
 * time. Its output is raw bytes with no conversion of any kind.
 */
class BlobReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  /** Reads are answered in order: one waits for the one before it. */
  private last: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.child = spawn("git", ["-C", directory, "cat-file", "--batch"], {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", () => {});
    this.child.stdin.on("error", () => {});
    this.child.stderr.resume();
    this.output = this.child.stdout[Symbol.asyncIterator]();
  }

  copy(input: {
    oid: string;
    maxBytes: number;
    write: (chunk: Uint8Array) => Promise<void>;
  }): Promise<void> {
    const next = this.last.then(() => this.copyNow(input));
    this.last = next.catch(() => {});
    return next;
  }

  private async copyNow(input: {
    oid: string;
    maxBytes: number;
    write: (chunk: Uint8Array) => Promise<void>;
  }): Promise<void> {
    if (!OBJECT_ID.test(input.oid))
      throw new WorkspaceSaveError("the workspace names an invalid object");
    this.child.stdin.write(`${input.oid}\n`);
    const [oid, type, size] = (await this.line()).split(" ");
    if (oid !== input.oid || type !== "blob" || !/^\d+$/.test(size ?? ""))
      throw new WorkspaceSaveError(
        "the workspace's pack lacks a file it names",
      );
    const length = Number(size);
    if (length > input.maxBytes)
      throw new WorkspaceSaveError("a saved file is larger than it may be");
    let left = length;
    while (left > 0) {
      if (this.pending.length === 0 && !(await this.fill()))
        throw new WorkspaceSaveError("a saved file was cut short");
      const part = this.pending.subarray(
        0,
        Math.min(left, this.pending.length),
      );
      this.pending = this.pending.subarray(part.length);
      left -= part.length;
      await input.write(part);
    }
    // Git ends every object with a line feed.
    while (this.pending.length === 0)
      if (!(await this.fill()))
        throw new WorkspaceSaveError("a saved file was cut short");
    this.pending = this.pending.subarray(1);
  }

  private async line(): Promise<string> {
    for (;;) {
      const end = this.pending.indexOf(10);
      if (end >= 0) {
        const line = this.pending.subarray(0, end).toString("latin1");
        this.pending = this.pending.subarray(end + 1);
        return line;
      }
      if (this.pending.length > 256 || !(await this.fill()))
        throw new WorkspaceSaveError("the saved files could not be read");
    }
  }

  private async fill(): Promise<boolean> {
    const next = await this.output.next();
    if (next.done) return false;
    this.pending =
      this.pending.length > 0
        ? Buffer.concat([this.pending, next.value])
        : next.value;
    return true;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill("SIGKILL");
  }
}

async function lstatOrNull(target: string) {
  return fs.lstat(target).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    throw error;
  });
}

/**
 * The real folder a path's parent segments name under `root`, made when
 * `create` says so. A link on the way is never followed: writing refuses
 * it, and a deletion finds nothing of the checkout's there (null).
 */
async function folderOf(input: {
  root: string;
  filePath: string;
  create: boolean;
}): Promise<string | null> {
  let current = input.root;
  for (const segment of input.filePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (!input.create) return null;
      await fs.mkdir(current);
    } else if (!stat.isDirectory()) {
      if (!input.create) return null;
      throw new WorkspaceSaveError(
        stat.isSymbolicLink()
          ? `${JSON.stringify(input.filePath)} would be written through a link, which a save never follows`
          : `${JSON.stringify(input.filePath)} needs a folder where the saved copy holds a file`,
      );
    }
  }
  return current;
}

/** Remove a folder that holds nothing but empty folders; false otherwise. */
async function removeEmptyFolder(folder: string): Promise<boolean> {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) return false;
    if (!(await removeEmptyFolder(path.join(folder, entry.name)))) return false;
  }
  await fs.rmdir(folder);
  return true;
}

/** Take away what stands where a file or link is about to be written. */
async function clearTarget(target: string, filePath: string): Promise<void> {
  const stat = await lstatOrNull(target);
  if (!stat) return;
  if (!stat.isDirectory()) {
    // Unlinking removes a link itself, never what it points at.
    await fs.unlink(target);
    return;
  }
  if (!(await removeEmptyFolder(target)))
    throw new WorkspaceSaveError(
      `${JSON.stringify(filePath)} is a file in the workspace, and a folder that still holds files in the saved copy`,
    );
}

/**
 * Refuse a change the file APIs would refuse: a personal file is never
 * written from a sandbox. Deleting one is skipped, as it always was.
 */
function withoutPersonalFiles(changes: readonly SavedChange[]): SavedChange[] {
  return changes.filter((change) => {
    if (!isPersonalFile(change.path)) return true;
    if (change.kind === "deleted") return false;
    throw new WorkspaceSaveError(
      `${JSON.stringify(change.path)} is a personal file, which is never saved from a workspace`,
    );
  });
}

/**
 * Refuse a link that could lead outside the folder it is saved in. Its
 * target must be relative: any `..` first, never above the folder, then
 * names only, so no link the save itself wrote can be climbed out of, and
 * never a Git directory.
 */
function assertLinkStaysInside(filePath: string, target: Uint8Array): void {
  const refuse = (): never => {
    throw new WorkspaceSaveError(
      `${JSON.stringify(filePath)} is a link that leads outside the project folder; a workspace's links are kept in a person's own folder only when they point inside it`,
    );
  };
  const text = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(target);
    } catch {
      return refuse();
    }
  })();
  if (text.startsWith("/") || text.includes("\\") || /^[A-Za-z]:/.test(text))
    refuse();
  const segments = text
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const climbs = segments.findIndex((segment) => segment !== "..");
  const up = climbs < 0 ? segments.length : climbs;
  const names = segments.slice(up);
  const depth = filePath.split("/").length - 1;
  if (up > depth || names.includes("..") || names.some(isGitDirectoryName))
    refuse();
}

/**
 * Apply a save to a checkout on this machine, exactly: each file's bytes
 * and executable bit, each link as a link, each deletion. Deletions go
 * first, so a file may take a folder's place and a folder a file's. Nothing
 * is written outside `repoPath`: parents are real folders or the save is
 * refused, and what stands at a path is removed, never opened, so a link
 * saved earlier cannot redirect a later write.
 */
export async function writeSavedChanges(input: {
  repoPath: string;
  changes: readonly SavedChange[];
  pack: ReceivedPack;
  /**
   * The checkout's file APIs follow links (a person's own folder): a link
   * that could lead outside it is refused, so nothing read or written
   * there later goes where the sandbox pointed.
   */
  containLinks?: boolean;
}): Promise<void> {
  const changes = withoutPersonalFiles(input.changes);
  for (const change of changes) assertSavedPath(change.path);
  for (const change of changes) {
    if (change.kind !== "deleted") continue;
    const folder = await folderOf({
      root: input.repoPath,
      filePath: change.path,
      create: false,
    });
    if (!folder) continue;
    const target = path.join(folder, path.posix.basename(change.path));
    const stat = await lstatOrNull(target);
    if (stat && !stat.isDirectory()) await fs.unlink(target);
  }
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    const folder = await folderOf({
      root: input.repoPath,
      filePath: change.path,
      create: true,
    });
    if (!folder) continue;
    const target = path.join(folder, path.posix.basename(change.path));
    if (change.kind === "link") {
      const link = Buffer.from(await readLinkTarget(input.pack, change));
      if (input.containLinks) assertLinkStaysInside(change.path, link);
      await clearTarget(target, change.path);
      await fs.symlink(link, target);
      continue;
    }
    // Written beside its place and moved in: a save that stops part way
    // leaves the file as it was, and a rename replaces a link, never
    // what the link points at.
    const partial = path.join(folder, `.work-save-${randomUUID()}`);
    try {
      const handle = await fs.open(
        partial,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        change.mode === "100755" ? 0o777 : 0o666,
      );
      try {
        await input.pack.copy({
          oid: change.oid,
          write: async (chunk) => {
            await handle.writeFile(chunk);
          },
        });
      } finally {
        await handle.close();
      }
      await clearTarget(target, change.path);
      await fs.rename(partial, target);
    } catch (error) {
      await fs.rm(partial, { force: true });
      throw error;
    }
  }
}

async function readLinkTarget(
  pack: ReceivedPack,
  change: { path: string; oid: string },
): Promise<Uint8Array> {
  const target = await pack.read({ oid: change.oid, maxBytes: MAX_LINK_BYTES });
  if (target.length === 0 || target.includes(0))
    throw new WorkspaceSaveError(
      `${JSON.stringify(change.path)} is a link with no usable target`,
    );
  return target;
}

/**
 * A save as changes to a member's draft in the origin (ADR 0191): the same
 * bytes, modes and links, written as Git objects. Pass them to
 * `OriginDraftRepo.write` with `replaceLinks`.
 */
export async function savedDraftChanges(input: {
  changes: readonly SavedChange[];
  pack: ReceivedPack;
}): Promise<DraftChange[]> {
  const changes = withoutPersonalFiles(input.changes);
  for (const change of changes) assertSavedPath(change.path);
  const draft: DraftChange[] = [];
  for (const change of changes) {
    if (change.kind === "deleted") {
      draft.push({ path: change.path, delete: true });
    } else if (change.kind === "link") {
      draft.push({
        path: change.path,
        content: await readLinkTarget(input.pack, change),
        mode: "120000",
      });
    } else {
      draft.push({
        path: change.path,
        content: await input.pack.read({
          oid: change.oid,
          maxBytes: Number.MAX_SAFE_INTEGER,
        }),
        mode: change.mode,
      });
    }
  }
  return draft;
}
