import {
  type GitObjectType,
  type ParsedCommit,
  parseCommit,
} from "./git-object-codec.js";
import { isPersonalFile } from "./personal-files.js";
import type { OriginRepo } from "./types.js";

/**
 * Object-level reads and writes against a project's origin, with no working
 * copy (ADR 0191): trees are walked and rebuilt in memory, and new blobs,
 * trees, and commits are written straight to the origin. Git objects are
 * immutable, so every read may go through a process-wide cache keyed by
 * origin and object id, which is safe to lose.
 */

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** A file in a tree: its blob id and mode (`100644`, `100755`, `120000`). */
export interface TreeFile {
  oid: string;
  mode: string;
}

/** One change to apply to a tree: new content, or `null` to delete. */
export type TreeChange = Uint8Array | null;

export const EMPTY_TREE_ID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FILE_MODE = "100644";
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

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
    entries.push({
      mode: decoder.decode(data.slice(i, space)),
      name: decoder.decode(data.slice(space + 1, nul)),
      oid,
    });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, a tree sorting as if named `name/`. */
function treeSortKey(entry: TreeEntry): Uint8Array {
  return new TextEncoder().encode(
    isTreeMode(entry.mode) ? `${entry.name}/` : entry.name,
  );
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
    parts.push(new TextEncoder().encode(`${mode} ${entry.name}\0`));
    const oid = new Uint8Array(20);
    for (let i = 0; i < 20; i++)
      oid[i] = Number.parseInt(entry.oid.slice(i * 2, i * 2 + 2), 16);
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
   * `treeOid` with `changes` applied (path to content, or `null` to
   * delete), written to the origin. Returns the new tree id.
   */
  async writeTree(
    treeOid: string | null,
    changes: ReadonlyMap<string, TreeChange>,
  ): Promise<string> {
    return (await this.rewrite(treeOid, changes, "")) ?? this.emptyTree();
  }

  private async emptyTree(): Promise<string> {
    return this.write({ type: "tree", data: new Uint8Array() });
  }

  private async rewrite(
    treeOid: string | null,
    changes: ReadonlyMap<string, TreeChange>,
    base: string,
  ): Promise<string | null> {
    const entries = new Map(
      (treeOid ? await this.tree(treeOid) : []).map((entry) => [
        entry.name,
        entry,
      ]),
    );
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
      const existing = entries.get(filePath);
      const fullPath = `${base}${filePath}`;
      if (existing && isTreeMode(existing.mode))
        throw new DraftPathError({ code: "EISDIR", path: fullPath });
      if (existing?.mode === SYMLINK_MODE)
        throw new DraftPathError({ code: "ELOOP", path: fullPath });
      if (change === null) {
        if (!existing)
          throw new DraftPathError({ code: "ENOENT", path: fullPath });
        entries.delete(filePath);
        continue;
      }
      const oid = await this.write({ type: "blob", data: change });
      entries.set(filePath, {
        name: filePath,
        mode: existing?.mode ?? FILE_MODE,
        oid,
      });
    }
    for (const [directory, inner] of nested) {
      const existing = entries.get(directory);
      const fullPath = `${base}${directory}`;
      if (existing?.mode === SYMLINK_MODE)
        throw new DraftPathError({ code: "ELOOP", path: fullPath });
      if (existing && !isTreeMode(existing.mode)) {
        const deleting = [...inner.values()].every((change) => change === null);
        throw new DraftPathError({
          code: deleting ? "ENOENT" : "ENOTDIR",
          path: `${fullPath}/${[...inner.keys()][0] ?? ""}`,
        });
      }
      const child = await this.rewrite(
        existing?.oid ?? null,
        inner,
        `${fullPath}/`,
      );
      if (child === null) entries.delete(directory);
      else
        entries.set(directory, { name: directory, mode: "40000", oid: child });
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

  /** Paths whose blob differs between two trees; equal subtrees are skipped. */
  async diffTrees(
    before: string | null,
    after: string | null,
  ): Promise<
    Array<{ path: string; before: string | null; after: string | null }>
  > {
    const changes: Array<{
      path: string;
      before: string | null;
      after: string | null;
    }> = [];
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
          const lFile =
            l && !isTreeMode(l.mode) && l.mode !== SUBMODULE_MODE
              ? l.oid
              : null;
          const rFile =
            r && !isTreeMode(r.mode) && r.mode !== SUBMODULE_MODE
              ? r.oid
              : null;
          if (lFile !== rFile)
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
   * project's age.
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
    const queue: string[] = [];
    const push = async (oid: string, flag: number) => {
      const current = flags.get(oid) ?? 0;
      const next = current | flag;
      if (next === current) return;
      flags.set(oid, next);
      if (!times.has(oid))
        times.set(oid, (await this.commit(oid)).author.timestamp);
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
      for (const parent of (await this.commit(oid)).parents)
        await push(parent, flag);
    }
    let base: string | null = null;
    let ahead = 0;
    let behind = 0;
    for (const [oid, flag] of flags) {
      if (flag === LEFT) ahead++;
      else if (flag === RIGHT) behind++;
      else if (
        flag === BOTH &&
        (base === null || (times.get(oid) ?? 0) > (times.get(base) ?? 0))
      )
        base = oid;
    }
    return { base, ahead, behind };
  }

  /** Commits reachable from `tip`, newest first. */
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
