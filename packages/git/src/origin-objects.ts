import diff3Merge from "diff3";
import ignore, { type Ignore } from "ignore";
import {
  type GitObjectType,
  type ParsedCommit,
  parseCommit,
} from "./git-object-codec.js";
import { isPersonalFile } from "./personal-files.js";
import type { ConflictEntry, OriginRepo } from "./types.js";

/**
 * Object-level reads and writes against a project's origin, with no working
 * copy (ADR 0191): trees are walked, rebuilt, and merged in memory, and new
 * blobs, trees, and commits are written straight to the origin. Git objects
 * are immutable, so every read may go through a process-wide cache keyed by
 * origin and object id, which is safe to lose.
 */

export interface TreeEntry {
  mode: string;
  /** The name as text, for matching paths. */
  name: string;
  /** The name exactly as stored, so names that are not UTF-8 survive. */
  nameBytes: Uint8Array;
  oid: string;
}

/** A file in a tree: its blob id and mode (`100644`, `100755`, `120000`). */
export interface TreeFile {
  oid: string;
  mode: string;
}

/**
 * One change to apply to a tree: a blob already written (keeping the old
 * entry's mode unless one is given), or `null` to delete.
 */
export type TreeChange = { oid: string; mode?: string } | null;

export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FILE_MODE = "100644";
export const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";
/** Folders a project's history never contains, as the checkout walker skips them. */
const ALWAYS_IGNORED = new Set(["node_modules", ".git", "dist", ".turbo"]);
/** Object writes in flight at once. */
const WRITE_CONCURRENCY = 16;

export function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

/** An error with a Node-style `code`, as filesystem-backed repos throw. */
export class DraftPathError extends Error {
  readonly code: "ENOENT" | "ENOTDIR" | "EISDIR" | "ELOOP";
  constructor(input: {
    code: "ENOENT" | "ENOTDIR" | "EISDIR" | "ELOOP";
    path: string;
  }) {
    super(
      input.code === "ENOENT"
        ? `No such file: ${input.path}`
        : input.code === "EISDIR"
          ? `${input.path} is a folder`
          : input.code === "ENOTDIR"
            ? `A parent of ${input.path} is a file`
            : "Symbolic links cannot be read or written here",
    );
    this.name = "DraftPathError";
    this.code = input.code;
  }
}

/** Paths the project's ignore rules keep out of its history. */
export class DraftIgnoredPathError extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(
      `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} ignored by the project's .gitignore and never become part of the program.`,
    );
    this.name = "DraftIgnoredPathError";
    this.paths = paths;
  }
}

/** A text resolution offered for a file that is not text. */
export class DraftBinaryResolutionError extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(
      `${paths.join(", ")} ${paths.length === 1 ? "is not a text file" : "are not text files"}, so text cannot resolve ${paths.length === 1 ? "it" : "them"}. Discard your draft's change or publish it again after taking the published version.`,
    );
    this.name = "DraftBinaryResolutionError";
    this.paths = paths;
  }
}

/**
 * Immutable objects read from origins, bounded by bytes and evicted least
 * recently used. One per process is plenty; losing it only costs re-reads.
 */
export class GitObjectCache {
  private readonly entries = new Map<
    string,
    { type: GitObjectType; data: Uint8Array }
  >();
  private bytes = 0;

  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  get(key: string): { type: GitObjectType; data: Uint8Array } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: { type: GitObjectType; data: Uint8Array }): void {
    if (this.entries.has(key) || value.data.byteLength > this.maxBytes / 16)
      return;
    this.entries.set(key, value);
    this.bytes += value.data.byteLength;
    for (const [oldest, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= entry.data.byteLength;
    }
  }
}

/** Map with at most `limit` calls in flight, keeping input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const decoder = new TextDecoder("utf-8");
  let i = 0;
  while (i < data.length) {
    let space = i;
    while (space < data.length && data[space] !== 0x20) space++;
    let nul = space + 1;
    while (nul < data.length && data[nul] !== 0x00) nul++;
    const oid = Array.from(data.slice(nul + 1, nul + 21))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const nameBytes = data.slice(space + 1, nul);
    entries.push({
      mode: decoder.decode(data.slice(i, space)),
      name: decoder.decode(nameBytes),
      nameBytes,
      oid,
    });
    i = nul + 21;
  }
  return entries;
}

/** A map key for a stored name: its bytes, not their UTF-8 reading. */
function nameKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** A new entry named by text. */
function entryNamed(name: string, mode: string, oid: string): TreeEntry {
  return { name, nameBytes: new TextEncoder().encode(name), mode, oid };
}

/** Git's tree order: bytewise by name, a tree sorting as if named `name/`. */
function treeSortKey(entry: TreeEntry): Uint8Array {
  if (!isTreeMode(entry.mode)) return entry.nameBytes;
  const key = new Uint8Array(entry.nameBytes.length + 1);
  key.set(entry.nameBytes);
  key[entry.nameBytes.length] = 0x2f;
  return key;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

export function serializeTree(entries: readonly TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) =>
    compareBytes(treeSortKey(a), treeSortKey(b)),
  );
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    const mode = isTreeMode(entry.mode) ? "40000" : entry.mode;
    parts.push(new TextEncoder().encode(`${mode} `));
    parts.push(entry.nameBytes);
    const oid = new Uint8Array(21);
    for (let i = 0; i < 20; i++)
      oid[i + 1] = Number.parseInt(entry.oid.slice(i * 2, i * 2 + 2), 16);
    parts.push(oid);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function signature(author: { name: string; email: string }): string {
  const clean = (value: string) => value.replace(/[<>\n]/g, "").trim();
  return `${clean(author.name)} <${clean(author.email)}> ${Math.floor(Date.now() / 1000)} +0000`;
}

export function serializeCommit(input: {
  tree: string;
  parents: readonly string[];
  author: { name: string; email: string };
  message: string;
}): Uint8Array {
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((parent) => `parent ${parent}`),
    `author ${signature(input.author)}`,
    `committer ${signature(input.author)}`,
  ];
  const message = input.message.endsWith("\n")
    ? input.message
    : `${input.message}\n`;
  return new TextEncoder().encode(`${lines.join("\n")}\n\n${message}`);
}

/** `.gitignore` matchers by directory, read once per operation. */
export type IgnoreRules = Map<string, Ignore | null>;

/** One path's difference between two trees. */
export interface TreeDifference {
  path: string;
  before: TreeFile | null;
  after: TreeFile | null;
}

/** Reads and writes of one origin's objects through a shared cache. */
export class OriginObjects {
  constructor(
    readonly origin: OriginRepo,
    private readonly cache: GitObjectCache,
  ) {}

  async read(oid: string): Promise<{ type: GitObjectType; data: Uint8Array }> {
    const key = `${this.origin.gitdir}\0${oid}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const object = await this.origin.readObject(oid);
    this.cache.set(key, object);
    return object;
  }

  async write(input: {
    type: GitObjectType;
    data: Uint8Array;
  }): Promise<string> {
    const oid = await this.origin.writeObject(input);
    this.cache.set(`${this.origin.gitdir}\0${oid}`, input);
    return oid;
  }

  /** Write file contents as blobs, several at once; ids in input order. */
  writeBlobs(contents: readonly Uint8Array[]): Promise<string[]> {
    return mapLimit(contents, WRITE_CONCURRENCY, (data) =>
      this.write({ type: "blob", data }),
    );
  }

  async commit(oid: string): Promise<ParsedCommit> {
    const object = await this.read(oid);
    if (object.type !== "commit") throw new Error(`${oid} is not a commit`);
    return parseCommit(object.data);
  }

  async tree(oid: string): Promise<TreeEntry[]> {
    if (oid === EMPTY_TREE_ID) return [];
    const object = await this.read(oid);
    if (object.type !== "tree") throw new Error(`${oid} is not a tree`);
    return parseTree(object.data);
  }

  async blob(oid: string): Promise<Uint8Array> {
    const object = await this.read(oid);
    if (object.type !== "blob") throw new Error(`${oid} is not a file`);
    return object.data;
  }

  /**
   * Every file of a tree, keyed by path, optionally only under `prefix`
   * (a directory with its trailing slash, or one file's path). Personal
   * files and submodules are never part of the result.
   */
  async files(
    treeOid: string,
    prefix?: string,
  ): Promise<Map<string, TreeFile>> {
    const files = new Map<string, TreeFile>();
    const walk = async (oid: string, base: string): Promise<void> => {
      const entries = await this.tree(oid);
      await Promise.all(
        entries.map(async (entry) => {
          const filePath = `${base}${entry.name}`;
          if (isPersonalFile(filePath) || entry.mode === SUBMODULE_MODE) return;
          if (prefix !== undefined) {
            const inside = filePath.startsWith(prefix);
            const onTheWay = prefix.startsWith(`${filePath}/`);
            if (!inside && !onTheWay) return;
          }
          if (isTreeMode(entry.mode)) await walk(entry.oid, `${filePath}/`);
          else if (prefix === undefined || filePath.startsWith(prefix))
            files.set(filePath, { oid: entry.oid, mode: entry.mode });
        }),
      );
    };
    await walk(treeOid, "");
    return files;
  }

  /** One path's entry in a tree, or null when absent. */
  async entry(treeOid: string, filePath: string): Promise<TreeEntry | null> {
    const segments = filePath.split("/").filter(Boolean);
    let current = treeOid;
    for (const [index, segment] of segments.entries()) {
      const found = (await this.tree(current)).find(
        (entry) => entry.name === segment,
      );
      if (!found) return null;
      if (index === segments.length - 1) return found;
      if (found.mode === SYMLINK_MODE)
        throw new DraftPathError({ code: "ELOOP", path: filePath });
      if (!isTreeMode(found.mode)) return null;
      current = found.oid;
    }
    return null;
  }

  /**
   * Whether a path the tree does not track is ignored: under a folder no
   * project history contains, or matched by the `.gitignore` files of the
   * tree along its way, as a checkout's commit would skip it.
   */
  async isIgnored(
    treeOid: string | null,
    filePath: string,
    rules: IgnoreRules = new Map(),
  ): Promise<boolean> {
    const segments = filePath.split("/");
    if (segments.slice(0, -1).some((segment) => ALWAYS_IGNORED.has(segment)))
      return true;
    if (!treeOid) return false;
    if (await this.entry(treeOid, filePath)) return false;
    let ignored = false;
    for (let depth = 0; depth < segments.length; depth++) {
      const directory = segments.slice(0, depth).join("/");
      const base = directory ? `${directory}/` : "";
      let matcher = rules.get(directory);
      if (matcher === undefined) {
        const entry = await this.entry(treeOid, `${base}.gitignore`).catch(
          () => null,
        );
        matcher =
          entry && !isTreeMode(entry.mode)
            ? ignore().add(new TextDecoder().decode(await this.blob(entry.oid)))
            : null;
        rules.set(directory, matcher);
      }
      if (!matcher) continue;
      const result = matcher.test(filePath.slice(base.length));
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  }

  /**
   * `treeOid` with `changes` applied (path to an existing blob, or `null`
   * to delete), written to the origin. Returns the new tree id. With
   * `skipMissingDeletes`, deleting a path the tree lacks is not an error.
   */
  async writeTree(
    treeOid: string | null,
    changes: ReadonlyMap<string, TreeChange>,
    options?: { skipMissingDeletes?: boolean },
  ): Promise<string> {
    return (
      (await this.rewrite(treeOid, changes, "", options?.skipMissingDeletes)) ??
      this.write({ type: "tree", data: new Uint8Array() })
    );
  }

  private async rewrite(
    treeOid: string | null,
    changes: ReadonlyMap<string, TreeChange>,
    base: string,
    skipMissingDeletes = false,
  ): Promise<string | null> {
    // Keyed by the stored bytes, so names that are not UTF-8 (and would
    // decode alike) stay distinct entries.
    const entries = new Map(
      (treeOid ? await this.tree(treeOid) : []).map((entry) => [
        nameKey(entry.nameBytes),
        entry,
      ]),
    );
    const keyed = (name: string) => nameKey(new TextEncoder().encode(name));
    const nested = new Map<string, Map<string, TreeChange>>();
    for (const [filePath, change] of changes) {
      const slash = filePath.indexOf("/");
      if (slash >= 0) {
        const directory = filePath.slice(0, slash);
        const inner = nested.get(directory) ?? new Map<string, TreeChange>();
        inner.set(filePath.slice(slash + 1), change);
        nested.set(directory, inner);
        continue;
      }
      const existing = entries.get(keyed(filePath));
      const fullPath = `${base}${filePath}`;
      if (existing && isTreeMode(existing.mode))
        throw new DraftPathError({ code: "EISDIR", path: fullPath });
      if (existing?.mode === SYMLINK_MODE)
        throw new DraftPathError({ code: "ELOOP", path: fullPath });
      if (change === null) {
        if (!existing) {
          if (skipMissingDeletes) continue;
          throw new DraftPathError({ code: "ENOENT", path: fullPath });
        }
        entries.delete(keyed(filePath));
        continue;
      }
      entries.set(
        keyed(filePath),
        existing
          ? { ...existing, oid: change.oid, mode: change.mode ?? existing.mode }
          : entryNamed(filePath, change.mode ?? FILE_MODE, change.oid),
      );
    }
    const children = await Promise.all(
      [...nested].map(async ([directory, inner]) => {
        const existing = entries.get(keyed(directory));
        const fullPath = `${base}${directory}`;
        if (existing?.mode === SYMLINK_MODE)
          throw new DraftPathError({ code: "ELOOP", path: fullPath });
        if (existing && !isTreeMode(existing.mode)) {
          const deleting = [...inner.values()].every(
            (change) => change === null,
          );
          if (deleting && skipMissingDeletes)
            return { directory, oid: existing.oid, keep: true };
          throw new DraftPathError({
            code: deleting ? "ENOENT" : "ENOTDIR",
            path: `${fullPath}/${[...inner.keys()][0] ?? ""}`,
          });
        }
        const oid = await this.rewrite(
          existing?.oid ?? null,
          inner,
          `${fullPath}/`,
          skipMissingDeletes,
        );
        return { directory, oid, keep: false };
      }),
    );
    for (const child of children) {
      if (child.keep) continue;
      const existing = entries.get(keyed(child.directory));
      if (child.oid === null) entries.delete(keyed(child.directory));
      else
        entries.set(
          keyed(child.directory),
          existing
            ? { ...existing, mode: "40000", oid: child.oid }
            : entryNamed(child.directory, "40000", child.oid),
        );
    }
    if (entries.size === 0) return null;
    return this.write({
      type: "tree",
      data: serializeTree([...entries.values()]),
    });
  }

  async writeCommit(input: {
    tree: string;
    parents: readonly string[];
    author: { name: string; email: string };
    message: string;
  }): Promise<string> {
    return this.write({ type: "commit", data: serializeCommit(input) });
  }

  /** Paths whose file differs between two trees; equal subtrees are skipped. */
  async diffTrees(
    before: string | null,
    after: string | null,
  ): Promise<TreeDifference[]> {
    const changes: TreeDifference[] = [];
    const fileOf = (entry: TreeEntry | undefined): TreeFile | null =>
      entry && !isTreeMode(entry.mode) && entry.mode !== SUBMODULE_MODE
        ? { oid: entry.oid, mode: entry.mode }
        : null;
    const walk = async (
      a: string | null,
      b: string | null,
      base: string,
    ): Promise<void> => {
      if (a === b) return;
      const left = new Map(
        (a ? await this.tree(a) : []).map((entry) => [entry.name, entry]),
      );
      const right = new Map(
        (b ? await this.tree(b) : []).map((entry) => [entry.name, entry]),
      );
      const names = [...new Set([...left.keys(), ...right.keys()])];
      await Promise.all(
        names.map(async (name) => {
          const filePath = `${base}${name}`;
          if (isPersonalFile(filePath)) return;
          const l = left.get(name);
          const r = right.get(name);
          if (l?.oid === r?.oid && l?.mode === r?.mode) return;
          const lTree = l && isTreeMode(l.mode) ? l.oid : null;
          const rTree = r && isTreeMode(r.mode) ? r.oid : null;
          if (lTree || rTree) await walk(lTree, rTree, `${filePath}/`);
          const lFile = fileOf(l);
          const rFile = fileOf(r);
          if (lFile?.oid !== rFile?.oid || lFile?.mode !== rFile?.mode)
            changes.push({ path: filePath, before: lFile, after: rFile });
        }),
      );
    };
    await walk(before, after, "");
    return changes.sort((x, y) => x.path.localeCompare(y.path));
  }

  /**
   * Where two commits' histories meet, and how many commits each has that
   * the other lacks. Walks newest first from both tips and stops once only
   * shared history is left, so the cost follows the divergence, not the
   * project's age. The meeting point is a common ancestor that no other
   * common ancestor descends from (the best merge base), chosen by the
   * commit graph.
   */
  async compare(
    left: string,
    right: string,
  ): Promise<{ base: string | null; ahead: number; behind: number }> {
    if (left === right) return { base: left, ahead: 0, behind: 0 };
    const LEFT = 1;
    const RIGHT = 2;
    const BOTH = 3;
    const flags = new Map<string, number>();
    const times = new Map<string, number>();
    const parents = new Map<string, string[]>();
    const queue: string[] = [];
    const push = async (oid: string, flag: number) => {
      const current = flags.get(oid) ?? 0;
      const next = current | flag;
      if (next === current) return;
      flags.set(oid, next);
      if (!times.has(oid)) {
        const commit = await this.commit(oid);
        times.set(oid, commit.author.timestamp);
        parents.set(oid, commit.parents);
      }
      queue.push(oid);
    };
    await push(left, LEFT);
    await push(right, RIGHT);
    let steps = 0;
    while (queue.some((oid) => flags.get(oid) !== BOTH)) {
      if (++steps > 100_000)
        throw new Error("Histories too far apart to compare");
      queue.sort((a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0));
      const oid = queue.pop();
      if (!oid) break;
      const flag = flags.get(oid) ?? 0;
      for (const parent of parents.get(oid) ?? []) await push(parent, flag);
    }
    let ahead = 0;
    let behind = 0;
    const common: string[] = [];
    for (const [oid, flag] of flags) {
      if (flag === LEFT) ahead++;
      else if (flag === RIGHT) behind++;
      else if (flag === BOTH) common.push(oid);
    }
    // A common commit is not the best base when another common commit
    // descends from it.
    const beneath = new Set<string>();
    for (const oid of common) {
      const stack = [...(parents.get(oid) ?? [])];
      while (stack.length > 0) {
        const ancestor = stack.pop();
        if (!ancestor || beneath.has(ancestor) || !flags.has(ancestor))
          continue;
        beneath.add(ancestor);
        stack.push(...(parents.get(ancestor) ?? []));
      }
    }
    const best = common
      .filter((oid) => !beneath.has(oid))
      .sort(
        (a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0) || (a < b ? -1 : 1),
      );
    return { base: best[0] ?? null, ahead, behind };
  }

  /** Commits reachable from `tip`, newest first. */
  /**
   * Whether commit `sha` is one of `tips` or reachable from them. Walks
   * newest first and stops at commits clearly older than `sha` (a day of
   * clock skew allowed) or after `limit` commits, so a lookup costs the
   * history since that commit, not the project's age. Anything it cannot
   * prove reachable answers false.
   */
  async isReachable(input: {
    sha: string;
    tips: readonly string[];
    limit?: number;
  }): Promise<boolean> {
    const object = await this.read(input.sha).catch(() => null);
    if (object?.type !== "commit") return false;
    const floor = parseCommit(object.data).author.timestamp - 86_400;
    const limit = input.limit ?? 20_000;
    const seen = new Set<string>();
    const queue: Array<{ sha: string; time: number }> = [];
    const enqueue = async (sha: string) => {
      if (seen.has(sha)) return;
      seen.add(sha);
      const commit = await this.commit(sha).catch(() => null);
      if (commit) queue.push({ sha, time: commit.author.timestamp });
    };
    for (const tip of input.tips) await enqueue(tip);
    while (queue.length > 0 && seen.size <= limit) {
      queue.sort((a, b) => a.time - b.time);
      const next = queue.pop();
      if (!next) break;
      if (next.sha === input.sha) return true;
      if (next.time < floor) continue;
      for (const parent of (await this.commit(next.sha)).parents)
        await enqueue(parent);
    }
    return false;
  }

  async log(
    tip: string,
    maxCount: number,
  ): Promise<
    Array<{
      sha: string;
      message: string;
      author: { name: string; email: string };
      timestamp: number;
    }>
  > {
    const seen = new Set<string>();
    const queue: Array<{ sha: string; commit: ParsedCommit }> = [];
    const out: Array<{
      sha: string;
      message: string;
      author: { name: string; email: string };
      timestamp: number;
    }> = [];
    const enqueue = async (sha: string) => {
      if (seen.has(sha)) return;
      seen.add(sha);
      queue.push({ sha, commit: await this.commit(sha) });
    };
    await enqueue(tip);
    while (queue.length > 0 && out.length < maxCount) {
      queue.sort(
        (a, b) => a.commit.author.timestamp - b.commit.author.timestamp,
      );
      const next = queue.pop();
      if (!next) break;
      out.push({
        sha: next.sha,
        message: next.commit.message,
        author: {
          name: next.commit.author.name,
          email: next.commit.author.email,
        },
        timestamp: next.commit.author.timestamp,
      });
      for (const parent of next.commit.parents) await enqueue(parent);
    }
    return out;
  }
}

/**
 * A three-way merge of trees in memory: every path only one side changed
 * takes that side, a text file both changed merges line by line, and
 * anything else both changed differently is a conflict. `resolutions`
 * settle conflicted paths with the member's content. Ours is the member's
 * side and theirs the published program, as in every conflict a member
 * resolves.
 */
export async function mergeTrees(input: {
  objects: OriginObjects;
  base: string | null;
  ours: string;
  theirs: string;
  resolutions?: Record<string, string>;
}): Promise<
  | { status: "merged"; tree: string }
  | { status: "conflict"; conflicts: ConflictEntry[] }
> {
  const { objects } = input;
  const [oursChanges, theirsChanges] = await Promise.all([
    objects.diffTrees(input.base, input.ours),
    objects.diffTrees(input.base, input.theirs),
  ]);
  const theirsByPath = new Map(
    theirsChanges.map((change) => [change.path, change]),
  );
  const blobOf = async (file: TreeFile | null) =>
    file ? objects.blob(file.oid) : null;
  const changes = new Map<string, TreeChange>();
  const conflicts: ConflictEntry[] = [];
  /** Modes a resolution keeps: from the side each conflicted file came from. */
  const modes = new Map<string, string>();
  const conflict = async (entry: {
    path: string;
    base: TreeFile | null;
    ours: TreeFile | null;
    theirs: TreeFile | null;
  }) => {
    const [base, ours, theirs] = await Promise.all([
      blobOf(entry.base),
      blobOf(entry.ours),
      blobOf(entry.theirs),
    ]);
    const mode = entry.ours?.mode ?? entry.theirs?.mode ?? entry.base?.mode;
    if (mode) modes.set(entry.path, mode);
    // Binary contents are never decoded as text: the member sees which
    // file clashed, not a corrupted rendering of it.
    const binary = [base, ours, theirs].some((bytes) => bytes?.includes(0));
    const text = (bytes: Uint8Array | null) =>
      bytes && !binary ? new TextDecoder().decode(bytes) : null;
    conflicts.push({
      path: entry.path,
      base: text(base),
      ours: text(ours),
      theirs: text(theirs),
      ...(binary ? { binary: true } : {}),
    });
  };
  for (const ours of oursChanges) {
    const theirs = theirsByPath.get(ours.path);
    if (!theirs) {
      // A file on one side where the other made a folder, or the reverse.
      if (
        ours.after &&
        (await clashesWithTree(objects, input.theirs, ours.path))
      ) {
        await conflict({
          path: ours.path,
          base: ours.before,
          ours: ours.after,
          theirs: null,
        });
        continue;
      }
      changes.set(
        ours.path,
        ours.after ? { oid: ours.after.oid, mode: ours.after.mode } : null,
      );
      continue;
    }
    if (
      ours.after?.oid === theirs.after?.oid &&
      ours.after?.mode === theirs.after?.mode
    )
      continue;
    const merged = await mergeText({
      objects,
      base: ours.before,
      ours: ours.after,
      theirs: theirs.after,
    });
    if (merged !== null && ours.after) {
      const [oid] = await objects.writeBlobs([merged]);
      if (oid) changes.set(ours.path, { oid, mode: ours.after.mode });
      continue;
    }
    await conflict({
      path: ours.path,
      base: ours.before,
      ours: ours.after,
      theirs: theirs.after,
    });
  }
  const resolved = Object.entries(input.resolutions ?? {});
  if (resolved.length > 0) {
    const binary = resolved
      .map(([file]) => file)
      .filter((file) =>
        conflicts.some((entry) => entry.path === file && entry.binary),
      );
    if (binary.length > 0) throw new DraftBinaryResolutionError(binary);
    const rules: IgnoreRules = new Map();
    const ignored: string[] = [];
    for (const [file] of resolved)
      if (
        !modes.has(file) &&
        (await objects.isIgnored(input.theirs, file, rules))
      )
        ignored.push(file);
    if (ignored.length > 0) throw new DraftIgnoredPathError(ignored);
    const oids = await objects.writeBlobs(
      resolved.map(([, content]) => new TextEncoder().encode(content)),
    );
    resolved.forEach(([file], index) => {
      const oid = oids[index];
      const mode = modes.get(file);
      if (oid) changes.set(file, mode ? { oid, mode } : { oid });
    });
  }
  const unresolved = conflicts.filter(
    (conflict) => input.resolutions?.[conflict.path] === undefined,
  );
  if (unresolved.length > 0)
    return { status: "conflict", conflicts: unresolved };
  return {
    status: "merged",
    tree: await objects.writeTree(input.theirs, changes, {
      skipMissingDeletes: true,
    }),
  };
}

/**
 * Whether writing a file at `filePath` would clash with `treeOid`: the
 * path is a folder there, or one of its parents is a file.
 */
async function clashesWithTree(
  objects: OriginObjects,
  treeOid: string,
  filePath: string,
): Promise<boolean> {
  const at = await objects.entry(treeOid, filePath).catch(() => null);
  if (at && isTreeMode(at.mode)) return true;
  const segments = filePath.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    const parent = await objects
      .entry(treeOid, segments.slice(0, depth).join("/"))
      .catch(() => null);
    if (!parent) return false;
    if (!isTreeMode(parent.mode)) return true;
  }
  return false;
}

/** Both sides' edits to one text file, merged line by line, or null. */
async function mergeText(input: {
  objects: OriginObjects;
  base: TreeFile | null;
  ours: TreeFile | null;
  theirs: TreeFile | null;
}): Promise<Uint8Array | null> {
  if (!input.base || !input.ours || !input.theirs) return null;
  if (input.ours.mode !== input.theirs.mode) return null;
  const [base, ours, theirs] = await Promise.all(
    [input.base, input.ours, input.theirs].map((file) =>
      input.objects.blob(file.oid),
    ),
  );
  if (!base || !ours || !theirs) return null;
  if ([base, ours, theirs].some((bytes) => bytes.includes(0))) return null;
  const lines = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks = diff3Merge(lines(ours), lines(base), lines(theirs));
  const merged: string[] = [];
  for (const block of blocks) {
    if (!("ok" in block)) return null;
    merged.push(...block.ok);
  }
  return new TextEncoder().encode(merged.join(""));
}
