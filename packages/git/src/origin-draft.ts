import nodeFs from "node:fs";
import path from "node:path";
import {
  DRAFT_REF_PREFIX,
  draftRef,
  PUBLISHED_REF_PREFIX,
  publishedRef,
  SYSTEM_COMMIT_AUTHOR,
} from "@catamorphic/workflow/project-layout";
import git from "isomorphic-git";
import { type FileReadOptions, readFileSnapshot } from "./file-reads.js";
import {
  collectConflicts,
  fetchObject,
  fetchRemote,
  pushObject,
} from "./git-sync.js";
import {
  DraftPathError,
  type GitObjectCache,
  isTreeMode,
  OriginObjects,
  type TreeChange,
} from "./origin-objects.js";
import { assertSafePath } from "./project-repo.js";
import { RefMovedError } from "./ref-moved-error.js";
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

type PublishPlan =
  | { kind: "done"; done: DraftPublishResult }
  | {
      kind: "publish";
      draft: string;
      main: string | null;
      tree: string | null;
    };

type MergePlan =
  | { kind: "done"; upToDate: string | null }
  | { kind: "merge"; draft: string; main: string };

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

/**
 * A member's draft of a server-hosted project's program (ADR 0191): the ref
 * `refs/work/drafts/<member>` in the project's origin, read and written as
 * objects with no working copy on any machine. Without that ref the draft
 * is the published `main`. Every write is a draft commit moved in with a
 * compare-and-swap, so any replica sees every earlier write and nothing is
 * lost when one restarts. Publishing squashes the draft into one commit on
 * `main`; only a merge with a `main` that moved since the draft began uses
 * a real, ephemeral checkout.
 *
 * Reads accept `HEAD` (the draft), `main` and published refs, other
 * published branches, and commit ids; never another member's draft.
 */
export class OriginDraftRepo {
  readonly projectId: string;
  /** The draft's ref in the origin. */
  readonly ref: string;
  private readonly tenantId: string;
  private readonly remote: RemoteBackend;
  private readonly cache: GitObjectCache;
  private readonly openCheckout: () => Promise<ProjectRepo>;
  private readonly author: { name: string; email: string };

  constructor(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
    remote: RemoteBackend;
    cache: GitObjectCache;
    /** An ephemeral checkout of the published program, for merges. */
    openCheckout: () => Promise<ProjectRepo>;
    /** Author of draft commits; publishing records the publisher. */
    author?: { name: string; email: string };
  }) {
    this.tenantId = args.tenantId;
    this.projectId = args.projectId;
    this.ref = draftRef(args.externalUserId);
    this.remote = args.remote;
    this.cache = args.cache;
    this.openCheckout = args.openCheckout;
    this.author = args.author ?? SYSTEM_COMMIT_AUTHOR;
  }

  private withObjects<T>(fn: (objects: OriginObjects) => Promise<T>) {
    return this.remote.withOrigin(this.tenantId, this.projectId, (origin) =>
      fn(new OriginObjects(origin, this.cache)),
    );
  }

  private async tips(
    objects: OriginObjects,
  ): Promise<{ draft: string | null; main: string | null }> {
    const [draft, main] = await Promise.all([
      objects.origin.resolveRef(this.ref),
      objects.origin.resolveRef(MAIN),
    ]);
    return { draft, main };
  }

  private async resolveIn(
    objects: OriginObjects,
    ref: string,
  ): Promise<string | null> {
    if (ref === "HEAD" || ref === this.ref) {
      const { draft, main } = await this.tips(objects);
      return draft ?? main;
    }
    if (SHA_RE.test(ref))
      return (await objects.origin.hasObject(ref)) ? ref : null;
    const branch = ref.startsWith(`${PUBLISHED_REF_PREFIX}/`)
      ? ref.slice(PUBLISHED_REF_PREFIX.length + 1)
      : ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref.startsWith("refs/")
          ? null
          : ref;
    // Session branches and other members' drafts stay private.
    if (
      !branch ||
      branch.startsWith("sessions/") ||
      ref.startsWith(DRAFT_REF_PREFIX)
    )
      throw new DraftRefNotAllowedError(ref);
    return objects.origin.resolveRef(`refs/heads/${branch}`);
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
      if (entry.mode === "120000")
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
      const sha = await this.resolveIn(objects, ref).catch(() => null);
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
   * the member has none. A write that loses the race to another writer of
   * the same draft is rebuilt on the winner and retried. Returns the
   * draft's tip, unchanged when the changes change nothing.
   */
  async write(input: {
    changes: readonly DraftChange[];
    message?: string;
    /**
     * The content each path must still have, checked against the commit
     * the write builds on; a mismatch throws {@link DraftContentChangedError}.
     */
    expected?: Record<string, string>;
  }): Promise<string | null> {
    const changes = new Map<string, TreeChange>();
    for (const change of input.changes) {
      const normalized = normalizePath(change.path);
      changes.set(
        normalized,
        "delete" in change
          ? null
          : typeof change.content === "string"
            ? new TextEncoder().encode(change.content)
            : change.content,
      );
    }
    if (changes.size === 0) return null;
    const message =
      input.message ??
      `Draft: ${[...changes.keys()].slice(0, 3).join(", ")}${changes.size > 3 ? ", ..." : ""}`;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const outcome = await this.withObjects(async (objects) => {
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
        const tree = await objects.writeTree(baseTree, changes);
        if (tree === baseTree) return { sha: parent };
        const sha = await objects.writeCommit({
          tree,
          parents: parent ? [parent] : [],
          author: this.author,
          message,
        });
        try {
          await objects.origin.updateRef({
            ref: this.ref,
            sha,
            expected: draft,
          });
          return { sha };
        } catch (error) {
          if (error instanceof RefMovedError) return null;
          throw error;
        }
      });
      if (outcome) return outcome.sha;
    }
    throw new DraftBusyError();
  }

  async log(options?: {
    maxCount?: number;
    ref?: string;
  }): Promise<CommitInfo[]> {
    return this.withObjects(async (objects) => {
      const tip = await this.resolveIn(objects, options?.ref ?? "HEAD").catch(
        () => null,
      );
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
    return this.withObjects(async (objects) => {
      if (!(await objects.origin.resolveRef(this.ref))) return false;
      await objects.origin.deleteRef({ ref: this.ref });
      return true;
    });
  }

  /**
   * Publish the draft as one commit on `main` with `message`, then delete
   * it. When `main` moved since the draft began, the two are merged in an
   * ephemeral checkout first; a conflict publishes nothing and reports the
   * conflicted files. `guard` sees every path the commit changes against
   * `main` and throws to refuse.
   */
  async publish(input: {
    message: string;
    author: { name: string; email: string };
    guard?: (paths: readonly string[]) => void;
  }): Promise<DraftPublishResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await this.withObjects(
        async (objects): Promise<PublishPlan> => {
          const { draft, main } = await this.tips(objects);
          if (!draft)
            return {
              kind: "done",
              done: {
                status: "nothing-to-deploy" as const,
                commitSha: null,
                remoteSha: main,
                conflicts: [],
              },
            };
          const draftTree = (await objects.commit(draft)).tree;
          const base = main ? (await objects.compare(draft, main)).base : null;
          const baseTree = base ? (await objects.commit(base)).tree : null;
          if ((await objects.diffTrees(baseTree, draftTree)).length === 0) {
            await clearDraft(objects, this.ref, draft);
            return {
              kind: "done",
              done: {
                status: "nothing-to-deploy" as const,
                commitSha: null,
                remoteSha: main,
                conflicts: [],
              },
            };
          }
          return {
            kind: "publish",
            draft,
            main,
            tree: !main || base === main ? draftTree : null,
          };
        },
      );
      if (plan.kind === "done") return plan.done;
      const { draft, main } = plan;
      let tree = plan.tree;
      if (!tree && main) {
        // Ours is the member's draft and theirs the published program, as
        // in every conflict a member resolves.
        const merged = await this.mergeInCheckout({
          ours: draft,
          theirs: main,
        });
        if (merged.status === "conflict")
          return {
            status: "conflict",
            commitSha: draft,
            remoteSha: main,
            conflicts: merged.conflicts,
          };
        tree = merged.tree;
      }
      if (!tree) continue;
      const mergedTree = tree;
      const published = await this.withObjects(async (objects) => {
        const mainTree = main ? (await objects.commit(main)).tree : null;
        input.guard?.(
          (await objects.diffTrees(mainTree, mergedTree)).map(
            (change) => change.path,
          ),
        );
        const sha = await objects.writeCommit({
          tree: mergedTree,
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
        await clearDraft(objects, this.ref, draft);
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
    const result = await this.mergeMain(input);
    if (result.status === "conflict" || !result.mergeCommit)
      throw new Error("The resolutions leave the draft unmerged");
    return result.mergeCommit;
  }

  private async mergeMain(input: {
    resolutions?: Record<string, string>;
    message?: string;
  }): Promise<MergeResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await this.withObjects(
        async (objects): Promise<MergePlan> => {
          const { draft, main } = await this.tips(objects);
          if (!draft || !main) return { kind: "done", upToDate: draft ?? main };
          const { base } = await objects.compare(draft, main);
          const changed =
            (
              await objects.diffTrees(
                base ? (await objects.commit(base)).tree : null,
                (
                  await objects.commit(draft)
                ).tree,
              )
            ).length > 0;
          if (!changed && !input.resolutions) {
            await clearDraft(objects, this.ref, draft);
            return { kind: "done", upToDate: main };
          }
          if (base === main && !input.resolutions)
            return { kind: "done", upToDate: draft };
          return { kind: "merge", draft, main };
        },
      );
      if (plan.kind === "done")
        return {
          status: "up-to-date",
          mergeCommit: plan.upToDate,
          conflicts: [],
        };
      const merged = await this.mergeInCheckout({
        ours: plan.draft,
        theirs: plan.main,
        resolutions: input.resolutions,
      });
      if (merged.status === "conflict")
        return {
          status: "conflict",
          mergeCommit: null,
          conflicts: merged.conflicts,
        };
      const sha = await this.withObjects(async (objects) => {
        const commit = await objects.writeCommit({
          tree: merged.tree,
          parents: [plan.draft, plan.main],
          author: this.author,
          message: input.message ?? "Merge published changes into draft",
        });
        try {
          await objects.origin.updateRef({
            ref: this.ref,
            sha: commit,
            expected: plan.draft,
          });
          return commit;
        } catch (error) {
          if (error instanceof RefMovedError) return null;
          throw error;
        }
      });
      if (sha) return { status: "clean", mergeCommit: sha, conflicts: [] };
    }
    throw new DraftBusyError();
  }

  /**
   * Merge `theirs` into `ours` in an ephemeral checkout (removed after)
   * and publish the merged tree's objects to the origin. With
   * `resolutions`, conflicted files take the member's content.
   */
  private async mergeInCheckout(input: {
    ours: string;
    theirs: string;
    resolutions?: Record<string, string>;
  }): Promise<
    | { status: "merged"; tree: string }
    | { status: "conflict"; conflicts: ConflictEntry[] }
  > {
    const checkout = await this.openCheckout();
    const location = {
      dev: checkout,
      remote: this.remote,
      tenantId: this.tenantId,
      projectId: this.projectId,
    };
    try {
      for (const sha of [input.ours, input.theirs])
        await fetchObject({ ...location, sha });
      const dir = checkout.repoPath;
      await git.writeRef({
        fs: nodeFs,
        dir,
        ref: "refs/heads/merge",
        value: input.ours,
        force: true,
      });
      await git.checkout({ fs: nodeFs, dir, ref: "merge", force: true });
      let conflicts: ConflictEntry[] = [];
      try {
        await git.merge({
          fs: nodeFs,
          dir,
          ours: "merge",
          theirs: input.theirs,
          author: this.author,
          committer: this.author,
          fastForward: true,
          abortOnConflict: !input.resolutions,
          message: "Merge",
        });
        await git.checkout({ fs: nodeFs, dir, ref: "merge", force: true });
      } catch (error) {
        if (!(error instanceof git.Errors.MergeConflictError)) throw error;
        conflicts = await collectConflicts({
          dev: checkout,
          oursSha: input.ours,
          theirsSha: input.theirs,
          raw: error.data,
        });
        if (!input.resolutions) return { status: "conflict", conflicts };
      }
      if (input.resolutions) {
        const resolved = Object.keys(input.resolutions).map(normalizePath);
        for (const [file, content] of Object.entries(input.resolutions))
          await checkout.writeFile(normalizePath(file), content);
        // Hidden folders are not walked by commit; stage every file the
        // merge or the member touched so no conflict stage survives.
        for (const filepath of new Set([
          ...resolved,
          ...conflicts.map((entry) => entry.path),
        ])) {
          if (nodeFs.existsSync(path.join(dir, filepath)))
            await git.add({ fs: nodeFs, dir, filepath });
          else await git.remove({ fs: nodeFs, dir, filepath });
        }
        await checkout.commit("Resolve conflicts", this.author);
      }
      const head = await checkout.resolveRef("HEAD");
      const tree = (await git.readCommit({ fs: nodeFs, dir, oid: head })).commit
        .tree;
      await pushObject({ ...location, sha: tree });
      return { status: "merged", tree };
    } finally {
      await checkout.dispose();
    }
  }

  async dispose(): Promise<void> {}
}

/**
 * Publish files as one commit on top of `main`, without touching any
 * member's draft (the desktop's publish of a member's local files). A
 * race with another publisher retries on the new `main`.
 */
export async function publishFilesToOrigin(input: {
  remote: RemoteBackend;
  cache: GitObjectCache;
  tenantId: string;
  projectId: string;
  files: Record<string, string>;
  message: string;
  author: { name: string; email: string };
  guard?: (paths: readonly string[]) => void;
}): Promise<DraftPublishResult> {
  const changes = new Map<string, TreeChange>(
    Object.entries(input.files).map(([file, content]) => [
      normalizePath(file),
      new TextEncoder().encode(content),
    ]),
  );
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await input.remote.withOrigin(
      input.tenantId,
      input.projectId,
      async (origin): Promise<DraftPublishResult | null> => {
        const objects = new OriginObjects(origin, input.cache);
        const main = await origin.resolveRef(MAIN);
        const mainTree = main ? (await objects.commit(main)).tree : null;
        const tree = await objects.writeTree(mainTree, changes);
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
          await origin.updateRef({ ref: MAIN, sha, expected: main });
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
    );
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
  if (input.repo instanceof OriginDraftRepo)
    return input.remote.withOrigin(input.tenantId, input.projectId, (origin) =>
      origin.resolveRef(`refs/heads/${branch}`),
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
  const decode = async (oid: string | null) =>
    oid ? new TextDecoder().decode(await input.objects.blob(oid)) : null;
  const changes = await input.objects.diffTrees(input.before, input.after);
  return Promise.all(
    changes.map(async (change): Promise<DiffEntry> => {
      const before = await decode(change.before);
      const after = await decode(change.after);
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

function normalizePath(filePath: string): string {
  const normalized = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
  assertSafePath(normalized);
  if (!normalized || normalized === ".")
    throw new DraftPathError({ code: "EISDIR", path: filePath });
  return normalized;
}
