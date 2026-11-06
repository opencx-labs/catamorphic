import path from "node:path";
import {
  DRAFT_REF_PREFIX,
  draftRef,
  PUBLISHED_REF_PREFIX,
  publishedRef,
  SYSTEM_COMMIT_AUTHOR,
} from "@catamorphic/workflow/project-layout";
import { type FileReadOptions, readFileSnapshot } from "./file-reads.js";
import { fetchRemote } from "./git-sync.js";
import {
  DraftIgnoredPathError,
  DraftPathError,
  type GitObjectCache,
  type IgnoreRules,
  isTreeMode,
  mergeTrees,
  OriginObjects,
  SYMLINK_MODE,
  type TreeChange,
} from "./origin-objects.js";
import { assertSafePath } from "./project-repo.js";
import { RefMovedError } from "./ref-moved-error.js";
import { assertValidRefName } from "./ref-names.js";
import type {
  CommitInfo,
  ConflictEntry,
  DiffEntry,
  MergeResult,
  ProjectRepo,
  RemoteBackend,
  RepoStatus,
} from "./types.js";

const MAIN = "refs/heads/main";
const BRANCHES = "refs/heads/";
/** Branches that hold one session's work, private to it. */
const SESSION_BRANCHES = `${BRANCHES}sessions/`;
const SHA_RE = /^[0-9a-f]{40}$/;
/** Lost compare-and-swap races before a write gives up. */
const MAX_ATTEMPTS = 8;

/**
 * A member's draft as {@link ProjectManager.openDraft} returns it: a local
 * folder's checkout, or a draft ref in a server-hosted project's origin.
 */
export type ProjectDraft = ProjectRepo | OriginDraftRepo;

/** One change to a draft: new content, or `delete: true`. */
export type DraftChange =
  | { path: string; content: string | Uint8Array }
  | { path: string; delete: true };

export type DraftPublishResult =
  | {
      status: "deployed";
      commitSha: string;
      remoteSha: string;
      conflicts: ConflictEntry[];
    }
  | {
      status: "nothing-to-deploy";
      commitSha: null;
      remoteSha: string | null;
      conflicts: ConflictEntry[];
    }
  | {
      status: "conflict";
      commitSha: string;
      remoteSha: string;
      conflicts: ConflictEntry[];
    };

/** Every attempt to move a ref lost its race to another writer. */
export class DraftBusyError extends Error {
  constructor() {
    super("The project changed while saving. Try again.");
    this.name = "DraftBusyError";
  }
}

/** A file no longer holds the content a write expected. */
export class DraftContentChangedError extends Error {
  constructor(path: string) {
    super(`${path} changed since it was read`);
    this.name = "DraftContentChangedError";
  }
}

/** A ref that a member's draft may not read (another member's draft). */
export class DraftRefNotAllowedError extends Error {
  constructor(ref: string) {
    super(`Unknown ref: ${ref}`);
    this.name = "DraftRefNotAllowedError";
  }
}

/** A `base` that is not a commit of the published program. */
export class InvalidBaseError extends Error {
  constructor(base: string) {
    super(`${base} is not a commit of the published program`);
    this.name = "InvalidBaseError";
  }
}

/** A read-only view (no member) asked to change a draft. */
export class NoDraftError extends Error {
  constructor() {
    super("This view of the program has no draft to change");
    this.name = "NoDraftError";
  }
}

/** The conflicts a merge left without a resolution. */
export class DraftUnresolvedError extends Error {
  readonly conflicts: ConflictEntry[];
  constructor(conflicts: ConflictEntry[]) {
    super(
      `Resolve ${conflicts.map((conflict) => conflict.path).join(", ")} too.`,
    );
    this.name = "DraftUnresolvedError";
    this.conflicts = conflicts;
  }
}

/** An origin that cannot keep drafts safely (ADR 0191). */
export class DraftsUnsupportedError extends Error {
  constructor(reason: string) {
    super(`Member drafts are unavailable on this project storage: ${reason}`);
    this.name = "DraftsUnsupportedError";
  }
}

type PublishPlan =
  | { kind: "done"; done: DraftPublishResult }
  | { kind: "publish"; draft: string; main: string | null; tree: string };

type MergePlan =
  | { kind: "done"; result: MergeResult }
  | { kind: "merged"; draft: string; main: string; tree: string };

/**
 * A member's draft of a server-hosted project's program (ADR 0191): the ref
 * `refs/work/drafts/<member>` in the project's origin, read and written as
 * objects with no working copy on any machine. Without that ref the draft
 * is the published `main`. Every write is a draft commit moved in with a
 * compare-and-swap, so any replica sees every earlier write and nothing is
 * lost when one restarts. Publishing squashes the draft into one commit on
 * `main`, merging in memory with a `main` that moved since the draft began.
 *
 * Reads of `HEAD` within one open see one commit (the one the first read
 * found, or the latest write through this instance), so several files read
 * together always come from the same snapshot. Reads accept `HEAD`, `main`
 * and published refs, other published branches, and commit ids reachable
 * from those or from the member's own draft; never another member's draft
 * or a session branch, by any spelling or case.
 *
 * Without a member (`externalUserId: null`) it is a read-only view of the
 * published program.
 */
export class OriginDraftRepo {
  readonly projectId: string;
  /** The draft's ref in the origin, or null for a read-only view. */
  readonly ref: string | null;
  private readonly tenantId: string;
  private readonly remote: RemoteBackend;
  private readonly cache: GitObjectCache;
  private readonly author: { name: string; email: string };
  /** The commit `HEAD` reads see; resolved on first use. */
  private head: { sha: string | null } | undefined;
  /** Commit ids this instance proved readable. */
  private readonly readable = new Set<string>();

  constructor(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string | null;
    remote: RemoteBackend;
    cache: GitObjectCache;
    /** Author of draft commits; publishing records the publisher. */
    author?: { name: string; email: string };
  }) {
    this.tenantId = args.tenantId;
    this.projectId = args.projectId;
    this.ref =
      args.externalUserId === null ? null : draftRef(args.externalUserId);
    this.remote = args.remote;
    this.cache = args.cache;
    this.author = args.author ?? SYSTEM_COMMIT_AUTHOR;
  }

  private withObjects<T>(fn: (objects: OriginObjects) => Promise<T>) {
    return this.remote.withOrigin(this.tenantId, this.projectId, (origin) =>
      fn(new OriginObjects(origin, this.cache)),
    );
  }

  /**
   * Run one compare-and-swap attempt; a lost race (inside the attempt, or
   * reported by the origin when it publishes the ref) yields null.
   */
  private async attempt<T>(
    fn: (objects: OriginObjects) => Promise<T | null>,
  ): Promise<T | null> {
    try {
      return await this.withObjects(async (objects) => {
        try {
          return await fn(objects);
        } catch (error) {
          if (error instanceof RefMovedError) return null;
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof RefMovedError) return null;
      throw error;
    }
  }

  private async tips(
    objects: OriginObjects,
  ): Promise<{ draft: string | null; main: string | null }> {
    const [draft, main] = await Promise.all([
      this.ref ? objects.origin.resolveRef(this.ref) : null,
      objects.origin.resolveRef(MAIN),
    ]);
    return { draft, main };
  }

  /** This member's draft ref; a read-only view has none to change. */
  private draftRefOrThrow(): string {
    if (!this.ref) throw new NoDraftError();
    return this.ref;
  }

  /**
   * Whether a commit id may be read here: reachable from `main`, from this
   * member's draft, or from a published branch this member may name. Ids
   * of other members' drafts or of sessions are not capabilities.
   */
  private async mayReadCommit(
    objects: OriginObjects,
    sha: string,
  ): Promise<boolean> {
    if (this.readable.has(sha)) return true;
    const { draft, main } = await this.tips(objects);
    const own = [draft, main].filter((tip): tip is string => tip !== null);
    let reachable = await objects.isReachable({ sha, tips: own });
    if (!reachable) {
      const branches = (await objects.origin.listRefs(BRANCHES))
        .filter((entry) => !isPrivateRef(entry.ref) && entry.ref !== MAIN)
        .map((entry) => entry.sha);
      reachable =
        branches.length > 0 &&
        (await objects.isReachable({ sha, tips: branches }));
    }
    if (reachable) this.readable.add(sha);
    return reachable;
  }

  /**
   * The commit a ref names, as this member may read it. Every name is
   * checked against git's ref rules first, then the full ref it maps to
   * against the private namespaces, so no spelling reaches another
   * member's draft or a session's branch.
   */
  private async resolveIn(
    objects: OriginObjects,
    ref: string,
  ): Promise<string | null> {
    if (ref === "HEAD" || ref === this.ref) {
      if (!this.head) {
        const { draft, main } = await this.tips(objects);
        this.head = { sha: draft ?? main };
      }
      return this.head.sha;
    }
    if (SHA_RE.test(ref))
      return (await this.mayReadCommit(objects, ref)) ? ref : null;
    assertValidRefName(ref);
    const full = ref.startsWith(`${PUBLISHED_REF_PREFIX}/`)
      ? `${BRANCHES}${ref.slice(PUBLISHED_REF_PREFIX.length + 1)}`
      : ref.startsWith("refs/")
        ? ref
        : `${BRANCHES}${ref}`;
    assertValidRefName(full);
    if (!full.startsWith(BRANCHES) || isPrivateRef(full))
      throw new DraftRefNotAllowedError(ref);
    return objects.origin.resolveRef(full);
  }

  private async treeAt(objects: OriginObjects, ref: string): Promise<string> {
    const sha = await this.resolveIn(objects, ref);
    if (!sha) throw new Error(`Unknown ref: ${ref}`);
    return (await objects.commit(sha)).tree;
  }

  async resolveRef(ref = "HEAD"): Promise<string> {
    const sha = await this.withObjects((objects) =>
      this.resolveIn(objects, ref),
    );
    if (!sha) throw new Error(`Unknown ref: ${ref}`);
    return sha;
  }

  async readFileBytes(filePath: string): Promise<Uint8Array | null> {
    const normalized = normalizePath(filePath);
    return this.withObjects(async (objects) => {
      const head = await this.resolveIn(objects, "HEAD");
      if (!head) return null;
      const entry = await objects.entry(
        (await objects.commit(head)).tree,
        normalized,
      );
      if (!entry || isTreeMode(entry.mode)) return null;
      if (entry.mode === SYMLINK_MODE)
        throw new DraftPathError({ code: "ELOOP", path: normalized });
      return objects.blob(entry.oid);
    });
  }

  async readFile(filePath: string): Promise<string> {
    const bytes = await this.readFileBytes(filePath);
    if (!bytes)
      throw new DraftPathError({
        code: "ENOENT",
        path: normalizePath(filePath),
      });
    return new TextDecoder().decode(bytes);
  }

  async listFiles(opts?: { prefix?: string }): Promise<string[]> {
    const prefix = opts?.prefix
      ? `${normalizePath(opts.prefix).replace(/\/+$/, "")}/`
      : undefined;
    return this.listFilesAtRef("HEAD", prefix ? { prefix } : undefined);
  }

  async readAllFiles(
    options?: FileReadOptions,
  ): Promise<Record<string, string>> {
    return this.readAllFilesAtRef("HEAD", options);
  }

  async listBlobsAtRef(
    ref: string,
    opts?: { prefix?: string },
  ): Promise<Array<{ path: string; oid: string }>> {
    return this.withObjects(async (objects) => {
      const sha = await this.resolveIn(objects, ref);
      if (!sha) return [];
      const files = await objects.files(
        (await objects.commit(sha)).tree,
        opts?.prefix,
      );
      return [...files]
        .map(([filePath, file]) => ({ path: filePath, oid: file.oid }))
        .sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  async listFilesAtRef(
    ref: string,
    opts?: { prefix?: string },
  ): Promise<string[]> {
    return (await this.listBlobsAtRef(ref, opts)).map((entry) => entry.path);
  }

  async readBlobAtRef(
    ref: string,
    filePath: string,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array | null> {
    const normalized = normalizePath(filePath);
    const blob = await this.withObjects(async (objects) => {
      const sha = await this.resolveIn(objects, ref);
      if (!sha) return null;
      const entry = await objects
        .entry((await objects.commit(sha)).tree, normalized)
        .catch(() => null);
      if (!entry || isTreeMode(entry.mode)) return null;
      return objects.blob(entry.oid);
    });
    if (
      blob &&
      options?.maxBytes !== undefined &&
      blob.byteLength > options.maxBytes
    )
      throw new Error(
        `Project file '${normalized}' exceeds the ${options.maxBytes}-byte snapshot limit`,
      );
    return blob;
  }

  async readAllFilesAtRef(
    ref: string,
    options?: FileReadOptions,
  ): Promise<Record<string, string>> {
    return this.snapshotAt(ref, undefined, options);
  }

  async readFilesAtRef(
    ref: string,
    opts: { prefix: string },
  ): Promise<Record<string, string>> {
    return this.snapshotAt(ref, opts.prefix);
  }

  private async snapshotAt(
    ref: string,
    prefix: string | undefined,
    options?: FileReadOptions,
  ): Promise<Record<string, string>> {
    return this.withObjects(async (objects) => {
      const sha = await this.resolveIn(objects, ref);
      if (!sha) return {};
      const files = await objects.files(
        (await objects.commit(sha)).tree,
        prefix,
      );
      return readFileSnapshot({
        paths: [...files.keys()].sort(),
        options,
        read: async (file, maxBytes) => {
          const entry = files.get(file);
          if (!entry) return null;
          const blob = await objects.blob(entry.oid);
          if (blob.byteLength > maxBytes)
            throw new Error(
              `Project file '${file}' exceeds the ${maxBytes}-byte snapshot limit`,
            );
          return new TextDecoder().decode(blob);
        },
      });
    });
  }

  async writeFile(
    filePath: string,
    content: string,
    opts?: { message?: string },
  ): Promise<void> {
    await this.write({
      changes: [{ path: filePath, content }],
      message: opts?.message,
    });
  }

  async deleteFile(
    filePath: string,
    opts?: { message?: string },
  ): Promise<void> {
    await this.write({
      changes: [{ path: filePath, delete: true }],
      message: opts?.message,
    });
  }

  /**
   * Apply changes as one draft commit, starting the draft from `main` when
   * the member has none. File contents are written to the origin once; a
   * write that loses the race to another writer of the same draft rebuilds
   * only its trees on the winner and retries. Returns the draft's tip,
   * unchanged when the changes change nothing.
   *
   * Paths the project's ignore rules keep out of history are refused, or
   * dropped with `skipIgnored`; with `skipMissingDeletes`, deleting a file
   * the draft lacks is not an error (a sandbox sync reporting a file it
   * made and removed again).
   */
  async write(input: {
    changes: readonly DraftChange[];
    message?: string;
    /**
     * The content each path must still have, checked against the commit
     * the write builds on; a mismatch throws {@link DraftContentChangedError}.
     */
    expected?: Record<string, string>;
    skipIgnored?: boolean;
    skipMissingDeletes?: boolean;
  }): Promise<string | null> {
    const pending = new Map<string, Uint8Array | null>();
    for (const change of input.changes)
      pending.set(
        normalizePath(change.path),
        "delete" in change
          ? null
          : typeof change.content === "string"
            ? new TextEncoder().encode(change.content)
            : change.content,
      );
    const draftRefName = this.draftRefOrThrow();
    if (pending.size === 0) return null;
    const message =
      input.message ??
      `Draft: ${[...pending.keys()].slice(0, 3).join(", ")}${pending.size > 3 ? ", ..." : ""}`;
    // Contents are immutable objects: write them once, before any race.
    const written = [...pending].filter(
      (entry): entry is [string, Uint8Array] => entry[1] !== null,
    );
    const oids = await this.withObjects((objects) =>
      objects.writeBlobs(written.map(([, content]) => content)),
    );
    const blobs = new Map(written.map(([file], index) => [file, oids[index]]));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const outcome = await this.attempt(async (objects) => {
        const { draft, main } = await this.tips(objects);
        const parent = draft ?? main;
        const baseTree = parent ? (await objects.commit(parent)).tree : null;
        for (const [file, content] of Object.entries(input.expected ?? {})) {
          const entry = baseTree
            ? await objects.entry(baseTree, normalizePath(file))
            : null;
          const current =
            entry && !isTreeMode(entry.mode)
              ? new TextDecoder().decode(await objects.blob(entry.oid))
              : null;
          if (current !== content) throw new DraftContentChangedError(file);
        }
        const rules: IgnoreRules = new Map();
        const ignored: string[] = [];
        const changes = new Map<string, TreeChange>();
        for (const [file] of pending) {
          if (await objects.isIgnored(baseTree, file, rules)) {
            ignored.push(file);
            continue;
          }
          const oid = blobs.get(file);
          changes.set(file, oid ? { oid } : null);
        }
        if (ignored.length > 0 && !input.skipIgnored)
          throw new DraftIgnoredPathError(ignored);
        if (changes.size === 0) return { sha: parent };
        const tree = await objects.writeTree(baseTree, changes, {
          skipMissingDeletes: input.skipMissingDeletes,
        });
        if (tree === baseTree) return { sha: parent };
        const sha = await objects.writeCommit({
          tree,
          parents: parent ? [parent] : [],
          author: this.author,
          message,
        });
        await objects.origin.updateRef({
          ref: draftRefName,
          sha,
          expected: draft,
        });
        return { sha };
      });
      if (outcome) {
        this.head = { sha: outcome.sha };
        return outcome.sha;
      }
    }
    throw new DraftBusyError();
  }

  async log(options?: {
    maxCount?: number;
    ref?: string;
  }): Promise<CommitInfo[]> {
    return this.withObjects(async (objects) => {
      const tip = await this.resolveIn(objects, options?.ref ?? "HEAD");
      return tip ? objects.log(tip, options?.maxCount ?? 50) : [];
    });
  }

  /**
   * What the draft would publish: the files it changes since it last met
   * `main`, its commits, and how far `main` has moved since. A draft with
   * no changes is clean.
   */
  async status(): Promise<RepoStatus> {
    return this.withObjects(async (objects) => {
      const { draft, main } = await this.tips(objects);
      const clean = {
        branch: "main",
        dirty: false,
        modifiedFiles: [],
        ahead: 0,
        behind: 0,
        baseCommit: main,
        remoteHead: main,
      };
      if (!draft) return clean;
      const { base, ahead, behind } = main
        ? await objects.compare(draft, main)
        : { base: null, ahead: 0, behind: 0 };
      const changes = await objects.diffTrees(
        base ? (await objects.commit(base)).tree : null,
        (await objects.commit(draft)).tree,
      );
      return {
        ...clean,
        dirty: changes.length > 0,
        modifiedFiles: changes.map((change) => change.path),
        ahead,
        behind,
        baseCommit: draft,
      };
    });
  }

  /** The draft's changes since it last met `main`, with contents. */
  async workdirDiff(): Promise<DiffEntry[]> {
    return this.withObjects(async (objects) => {
      const { draft, main } = await this.tips(objects);
      if (!draft) return [];
      const base = main ? (await objects.compare(draft, main)).base : null;
      return describeChanges({
        objects,
        before: base ? (await objects.commit(base)).tree : null,
        after: (await objects.commit(draft)).tree,
      });
    });
  }

  async diff(opts: { base: string; head: string }): Promise<DiffEntry[]> {
    return this.withObjects(async (objects) =>
      describeChanges({
        objects,
        before: await this.treeAt(objects, opts.base),
        after: await this.treeAt(objects, opts.head),
      }),
    );
  }

  /** Delete the draft: the member's view follows `main` again. */
  async discard(): Promise<boolean> {
    const ref = this.draftRefOrThrow();
    this.head = undefined;
    return this.withObjects(async (objects) => {
      if (!(await objects.origin.resolveRef(ref))) return false;
      await objects.origin.deleteRef({ ref });
      return true;
    });
  }

  /**
   * Publish the draft as one commit on `main` with `message`, then delete
   * it. When `main` moved since the draft began, the two merge in memory
   * first; a conflict publishes nothing and reports the conflicted files. A
   * draft whose merge leaves `main` as it is publishes nothing. `guard`
   * sees every path the commit changes against `main` and throws to refuse.
   */
  async publish(input: {
    message: string;
    author: { name: string; email: string };
    guard?: (paths: readonly string[]) => void;
  }): Promise<DraftPublishResult> {
    const ref = this.draftRefOrThrow();
    this.head = undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await this.withObjects(
        async (objects): Promise<PublishPlan> => {
          const { draft, main } = await this.tips(objects);
          const nothing = async (): Promise<PublishPlan> => {
            if (draft) await clearDraft(objects, ref, draft);
            return {
              kind: "done",
              done: {
                status: "nothing-to-deploy",
                commitSha: null,
                remoteSha: main,
                conflicts: [],
              },
            };
          };
          if (!draft) return nothing();
          const draftTree = (await objects.commit(draft)).tree;
          if (!main) return { kind: "publish", draft, main, tree: draftTree };
          const { base } = await objects.compare(draft, main);
          const mainTree = (await objects.commit(main)).tree;
          let tree = draftTree;
          if (base !== main) {
            const merged = await mergeTrees({
              objects,
              base: base ? (await objects.commit(base)).tree : null,
              ours: draftTree,
              theirs: mainTree,
            });
            if (merged.status === "conflict")
              return {
                kind: "done",
                done: {
                  status: "conflict",
                  commitSha: draft,
                  remoteSha: main,
                  conflicts: merged.conflicts,
                },
              };
            tree = merged.tree;
          }
          if (tree === mainTree) return nothing();
          return { kind: "publish", draft, main, tree };
        },
      );
      if (plan.kind === "done") return plan.done;
      const published = await this.attempt(async (objects) => {
        const mainTree = plan.main
          ? (await objects.commit(plan.main)).tree
          : null;
        input.guard?.(
          (await objects.diffTrees(mainTree, plan.tree)).map(
            (change) => change.path,
          ),
        );
        const sha = await objects.writeCommit({
          tree: plan.tree,
          parents: plan.main ? [plan.main] : [],
          author: input.author,
          message: input.message,
        });
        await objects.origin.updateRef({ ref: MAIN, sha, expected: plan.main });
        await clearDraft(objects, ref, plan.draft);
        return sha;
      });
      if (published)
        return {
          status: "deployed",
          commitSha: published,
          remoteSha: published,
          conflicts: [],
        };
    }
    throw new DraftBusyError();
  }

  /**
   * Bring what others published into the draft. A draft without changes
   * simply follows `main` again; one with changes gets a merge commit, or
   * the conflicted files when the two cannot be merged (nothing moves).
   */
  async pull(): Promise<MergeResult> {
    return this.mergeMain({});
  }

  /**
   * Merge `main` into the draft with the member's resolutions for the
   * conflicted files, as one draft commit.
   */
  async resolveConflicts(input: {
    resolutions: Record<string, string>;
    message: string;
  }): Promise<string> {
    const resolutions = Object.fromEntries(
      Object.entries(input.resolutions).map(([file, content]) => [
        normalizePath(file),
        content,
      ]),
    );
    const result = await this.mergeMain({
      resolutions,
      message: input.message,
    });
    if (result.status === "conflict")
      throw new DraftUnresolvedError(result.conflicts);
    if (!result.mergeCommit)
      throw new Error("There is no draft to resolve conflicts in");
    return result.mergeCommit;
  }

  private async mergeMain(input: {
    resolutions?: Record<string, string>;
    message?: string;
  }): Promise<MergeResult> {
    const ref = this.draftRefOrThrow();
    this.head = undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await this.withObjects(
        async (objects): Promise<MergePlan> => {
          const upToDate = (sha: string | null): MergePlan => ({
            kind: "done",
            result: { status: "up-to-date", mergeCommit: sha, conflicts: [] },
          });
          const { draft, main } = await this.tips(objects);
          if (!draft || !main) return upToDate(draft ?? main);
          const { base } = await objects.compare(draft, main);
          const baseTree = base ? (await objects.commit(base)).tree : null;
          const draftTree = (await objects.commit(draft)).tree;
          const changed =
            (await objects.diffTrees(baseTree, draftTree)).length > 0;
          if (!changed && !input.resolutions) {
            await clearDraft(objects, ref, draft);
            return upToDate(main);
          }
          if (base === main && !input.resolutions) return upToDate(draft);
          const merged = await mergeTrees({
            objects,
            base: baseTree,
            ours: draftTree,
            theirs: (await objects.commit(main)).tree,
            resolutions: input.resolutions,
          });
          if (merged.status === "conflict")
            return {
              kind: "done",
              result: {
                status: "conflict",
                mergeCommit: null,
                conflicts: merged.conflicts,
              },
            };
          return { kind: "merged", draft, main, tree: merged.tree };
        },
      );
      if (plan.kind === "done") return plan.result;
      const sha = await this.attempt(async (objects) => {
        const commit = await objects.writeCommit({
          tree: plan.tree,
          parents: [plan.draft, plan.main],
          author: this.author,
          message: input.message ?? "Merge published changes into draft",
        });
        await objects.origin.updateRef({
          ref,
          sha: commit,
          expected: plan.draft,
        });
        return commit;
      });
      if (sha) return { status: "clean", mergeCommit: sha, conflicts: [] };
    }
    throw new DraftBusyError();
  }

  async dispose(): Promise<void> {}
}

/**
 * Publish files as one commit on top of `main`, without touching any
 * member's draft (the desktop's publish of a member's local copy). With
 * `base`, the commit the files were edited from, they merge with what was
 * published since, and files changed on both sides are reported as
 * conflicts instead of overwriting. A race with another publisher retries
 * on the new `main`.
 */
export async function publishFilesToOrigin(input: {
  remote: RemoteBackend;
  cache: GitObjectCache;
  tenantId: string;
  projectId: string;
  files: Record<string, string>;
  base?: string;
  message: string;
  author: { name: string; email: string };
  guard?: (paths: readonly string[]) => void;
}): Promise<DraftPublishResult> {
  const files = Object.entries(input.files).map(
    ([file, content]) =>
      [normalizePath(file), new TextEncoder().encode(content)] as const,
  );
  const withOrigin = <T>(fn: (objects: OriginObjects) => Promise<T>) =>
    input.remote.withOrigin(input.tenantId, input.projectId, (origin) =>
      fn(new OriginObjects(origin, input.cache)),
    );
  const oids = await withOrigin((objects) =>
    objects.writeBlobs(files.map(([, content]) => content)),
  );
  const changes = new Map<string, TreeChange>();
  files.forEach(([file], index) => {
    const oid = oids[index];
    if (oid) changes.set(file, { oid });
  });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await withOrigin(
      async (objects): Promise<DraftPublishResult | null> => {
        const main = await objects.origin.resolveRef(MAIN);
        const mainTree = main ? (await objects.commit(main)).tree : null;
        // Published files follow the project's ignore rules like any write.
        const rules: IgnoreRules = new Map();
        const ignored: string[] = [];
        for (const [file] of changes)
          if (await objects.isIgnored(mainTree, file, rules))
            ignored.push(file);
        if (ignored.length > 0) throw new DraftIgnoredPathError(ignored);
        let tree: string;
        if (input.base && main && input.base !== main) {
          // A base is a commit of the published program, never an id that
          // would let the caller read anything else.
          if (
            !SHA_RE.test(input.base) ||
            !(await objects.isReachable({ sha: input.base, tips: [main] }))
          )
            throw new InvalidBaseError(input.base);
          const baseTree = (await objects.commit(input.base)).tree;
          const merged = await mergeTrees({
            objects,
            base: baseTree,
            ours: await objects.writeTree(baseTree, changes),
            theirs: mainTree ?? baseTree,
          });
          if (merged.status === "conflict")
            return {
              status: "conflict",
              commitSha: input.base,
              remoteSha: main,
              conflicts: merged.conflicts,
            };
          tree = merged.tree;
        } else {
          tree = await objects.writeTree(mainTree, changes);
        }
        if (tree === mainTree)
          return {
            status: "nothing-to-deploy",
            commitSha: null,
            remoteSha: main,
            conflicts: [],
          };
        input.guard?.(
          (await objects.diffTrees(mainTree, tree)).map(
            (change) => change.path,
          ),
        );
        const sha = await objects.writeCommit({
          tree,
          parents: main ? [main] : [],
          author: input.author,
          message: input.message,
        });
        try {
          await objects.origin.updateRef({ ref: MAIN, sha, expected: main });
        } catch (error) {
          if (error instanceof RefMovedError) return null;
          throw error;
        }
        return {
          status: "deployed",
          commitSha: sha,
          remoteSha: sha,
          conflicts: [],
        };
      },
    ).catch((error: unknown) => {
      // The origin itself reports a lost race when it publishes the ref.
      if (error instanceof RefMovedError) return null;
      throw error;
    });
    if (result) return result;
  }
  throw new DraftBusyError();
}

/**
 * The published commit of `branch` as `repo` reads it: straight from the
 * origin for a draft, after fetching it into a checkout otherwise.
 */
export async function refreshPublished(input: {
  repo: ProjectRepo | OriginDraftRepo;
  remote: RemoteBackend;
  tenantId: string;
  projectId: string;
  branch?: string;
}): Promise<string | null> {
  const branch = input.branch ?? "main";
  assertValidRefName(`${BRANCHES}${branch}`);
  if (input.repo instanceof OriginDraftRepo)
    return input.remote.withOrigin(input.tenantId, input.projectId, (origin) =>
      origin.resolveRef(`${BRANCHES}${branch}`),
    );
  const fetched = await fetchRemote({
    dev: input.repo,
    remote: input.remote,
    tenantId: input.tenantId,
    projectId: input.projectId,
    remoteBranch: branch,
  });
  return fetched.sha
    ? input.repo.resolveRef(publishedRef(branch)).catch(() => null)
    : null;
}

/**
 * A ref in a private namespace: a session's branch or any member's draft.
 * Compared without case, as a case-insensitive disk would open it.
 */
function isPrivateRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  return (
    lower.startsWith(SESSION_BRANCHES) ||
    lower.startsWith(`${DRAFT_REF_PREFIX}/`)
  );
}

async function clearDraft(
  objects: OriginObjects,
  ref: string,
  expected: string,
): Promise<void> {
  // A write that landed meanwhile keeps the draft: nothing is lost.
  await objects.origin.deleteRef({ ref, expected }).catch((error: unknown) => {
    if (!(error instanceof RefMovedError)) throw error;
  });
}

async function describeChanges(input: {
  objects: OriginObjects;
  before: string | null;
  after: string | null;
}): Promise<DiffEntry[]> {
  const decode = async (oid: string | undefined) =>
    oid ? new TextDecoder().decode(await input.objects.blob(oid)) : null;
  const changes = await input.objects.diffTrees(input.before, input.after);
  return Promise.all(
    changes.map(async (change): Promise<DiffEntry> => {
      const before = await decode(change.before?.oid);
      const after = await decode(change.after?.oid);
      return {
        path: change.path,
        kind:
          before === null ? "added" : after === null ? "deleted" : "modified",
        before,
        after,
      };
    }),
  );
}

/**
 * A project-relative path in canonical form. Absolute paths are refused, as
 * the file APIs always did, so no spelling slips past path-based policy.
 */
function normalizePath(filePath: string): string {
  const slashed = filePath.replace(/\\/g, "/");
  if (slashed.startsWith("/")) throw new Error("Absolute paths not allowed");
  const normalized = path.posix.normalize(slashed).replace(/^(\.\/)+/, "");
  assertSafePath(normalized);
  if (!normalized || normalized === ".")
    throw new DraftPathError({ code: "EISDIR", path: filePath });
  return normalized;
}
