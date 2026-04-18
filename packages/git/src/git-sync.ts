import nodeFs from "node:fs";
import git from "isomorphic-git";
import type {
  ConflictEntry,
  MergeResult,
  OriginRepo,
  ProjectRepo,
  RemoteBackend,
} from "./types.js";

/**
 * Server-orchestrated git transport between a dev `ProjectRepo` (working tree)
 * and an `OriginRepo` (bare repo). This module implements **object-level
 * transfer** — walking reachable commits/trees/blobs and copying them between
 * the two stores — so we never need a network git protocol between sandboxes.
 *
 * All operations assume the dev repo is an FS-backed `ProjectRepoImpl`. When
 * we later wire in Cloudflare dev sandboxes, this module will grow a thin
 * adapter, but the transfer algorithm stays the same.
 */

const SYSTEM_AUTHOR = {
  name: "Catamorphic",
  email: "system@catamorphic.dev",
};

export interface PushOpts {
  dev: ProjectRepo;
  remote: RemoteBackend;
  tenantId: string;
  projectId: string;
  /** Branch on the remote to push to. Defaults to `main`. */
  remoteBranch?: string;
  /** SHA on the dev side to push. Defaults to the tip of the current branch. */
  localSha?: string;
}

export interface FetchOpts {
  dev: ProjectRepo;
  remote: RemoteBackend;
  tenantId: string;
  projectId: string;
  remoteBranch?: string;
}

export interface PullOpts extends FetchOpts {
  /** Author for the merge commit (if one is needed). */
  author?: { name: string; email: string };
}

/**
 * Copy reachable commits from dev → origin and fast-forward the remote branch.
 * Throws if the push would not be a fast-forward (caller should pull first).
 */
export async function push(opts: PushOpts): Promise<{ sha: string }> {
  const branch = opts.remoteBranch ?? "main";
  const localSha = opts.localSha ?? (await opts.dev.resolveRef("HEAD"));

  return opts.remote.withOrigin(
    opts.tenantId,
    opts.projectId,
    async (origin) => {
      const ref = `refs/heads/${branch}`;
      const currentRemote = await origin.resolveRef(ref);

      if (currentRemote === localSha) {
        return { sha: localSha };
      }

      if (currentRemote) {
        const fastForward = await isAncestor({
          dev: opts.dev,
          ancestor: currentRemote,
          descendant: localSha,
        });
        if (!fastForward) {
          throw new PushNotFastForwardError({
            localSha,
            remoteSha: currentRemote,
          });
        }
      }

      await transferCommits({
        source: devSource(opts.dev),
        sink: originSink(origin),
        sha: localSha,
      });

      await origin.updateRef({
        ref,
        sha: localSha,
        expected: currentRemote,
      });

      await syncRemoteTrackingRef({
        dev: opts.dev,
        branch,
        sha: localSha,
      });

      return { sha: localSha };
    },
  );
}

/**
 * Copy the tip of the remote branch into the dev repo and update the
 * `refs/remotes/origin/<branch>` tracking ref. Does not touch the working tree.
 */
export async function fetchRemote(opts: FetchOpts): Promise<{
  sha: string | null;
  alreadyUpToDate: boolean;
}> {
  const branch = opts.remoteBranch ?? "main";

  return opts.remote.withOrigin(
    opts.tenantId,
    opts.projectId,
    async (origin) => {
      const ref = `refs/heads/${branch}`;
      const remoteSha = await origin.resolveRef(ref);
      if (!remoteSha) return { sha: null, alreadyUpToDate: true };

      const alreadyUpToDate = await devHasCommit({
        dev: opts.dev,
        sha: remoteSha,
      });

      if (!alreadyUpToDate) {
        await transferCommits({
          source: originSource(origin),
          sink: devSink(opts.dev),
          sha: remoteSha,
        });
      }

      await syncRemoteTrackingRef({
        dev: opts.dev,
        branch,
        sha: remoteSha,
      });

      return { sha: remoteSha, alreadyUpToDate };
    },
  );
}

/**
 * Fetch the remote branch, then merge it into the current branch. Uses a
 * 3-way merge via isomorphic-git. Returns conflicts when the merge cannot be
 * resolved automatically; working tree is left with conflict markers in that
 * case so the caller can surface them or invoke the AI resolver.
 */
export async function pull(opts: PullOpts): Promise<MergeResult> {
  const branch = opts.remoteBranch ?? "main";
  const author = opts.author ?? SYSTEM_AUTHOR;

  const fetched = await fetchRemote(opts);
  if (!fetched.sha) {
    return {
      status: "up-to-date",
      mergeCommit: null,
      conflicts: [],
    };
  }

  const localSha = await opts.dev.resolveRef("HEAD");
  if (localSha === fetched.sha) {
    return {
      status: "up-to-date",
      mergeCommit: null,
      conflicts: [],
    };
  }

  const localIsAhead = await isAncestor({
    dev: opts.dev,
    ancestor: fetched.sha,
    descendant: localSha,
  });
  if (localIsAhead) {
    return {
      status: "up-to-date",
      mergeCommit: null,
      conflicts: [],
    };
  }

  const currentBranch = await opts.dev.currentBranch();

  try {
    const result = await git.merge({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ours: currentBranch,
      theirs: fetched.sha,
      author,
      committer: author,
      fastForward: true,
      abortOnConflict: false,
      message: `Merge origin/${branch} into ${currentBranch}`,
    });

    await git.checkout({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ref: currentBranch,
      force: true,
    });

    return {
      status: "clean",
      mergeCommit: result.oid ?? null,
      conflicts: [],
    };
  } catch (err: unknown) {
    const maybeConflict = err as { code?: string; data?: unknown };
    if (maybeConflict?.code === "MergeConflictError") {
      const conflicts = await collectConflicts({
        dev: opts.dev,
        oursSha: localSha,
        theirsSha: fetched.sha,
        raw: maybeConflict.data,
      });
      return {
        status: "conflict",
        mergeCommit: null,
        conflicts,
      };
    }
    throw err;
  }
}

export class PushNotFastForwardError extends Error {
  readonly localSha: string;
  readonly remoteSha: string;
  constructor(opts: { localSha: string; remoteSha: string }) {
    super(
      `Push is not a fast-forward (local ${opts.localSha.slice(0, 8)} vs remote ${opts.remoteSha.slice(0, 8)})`,
    );
    this.name = "PushNotFastForwardError";
    this.localSha = opts.localSha;
    this.remoteSha = opts.remoteSha;
  }
}

// --- Object transfer primitives ---

interface ObjectSource {
  hasObject(sha: string): Promise<boolean>;
  readObject(sha: string): Promise<{
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }>;
}

interface ObjectSink {
  hasObject(sha: string): Promise<boolean>;
  writeObject(opts: {
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }): Promise<string>;
}

function devSource(dev: ProjectRepo): ObjectSource {
  return {
    hasObject: (sha) =>
      git
        .readObject({ fs: nodeFs, dir: dev.repoPath, oid: sha })
        .then(() => true)
        .catch(() => false),
    readObject: async (sha) => {
      const obj = await git.readObject({
        fs: nodeFs,
        dir: dev.repoPath,
        oid: sha,
        format: "content",
      });
      return {
        type: obj.type as "blob" | "tree" | "commit" | "tag",
        data: obj.object as Uint8Array,
      };
    },
  };
}

function devSink(dev: ProjectRepo): ObjectSink {
  return {
    hasObject: (sha) =>
      git
        .readObject({ fs: nodeFs, dir: dev.repoPath, oid: sha })
        .then(() => true)
        .catch(() => false),
    writeObject: (opts) =>
      git.writeObject({
        fs: nodeFs,
        dir: dev.repoPath,
        type: opts.type,
        object: opts.data,
        format: "content",
      }),
  };
}

function originSource(origin: OriginRepo): ObjectSource {
  return {
    hasObject: (sha) => origin.hasObject(sha),
    readObject: (sha) => origin.readObject(sha),
  };
}

function originSink(origin: OriginRepo): ObjectSink {
  return {
    hasObject: (sha) => origin.hasObject(sha),
    writeObject: (opts) => origin.writeObject(opts),
  };
}

async function transferCommits(opts: {
  source: ObjectSource;
  sink: ObjectSink;
  sha: string;
}): Promise<void> {
  const queue: string[] = [opts.sha];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const sha = queue.pop();
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);

    const alreadyAtSink = await opts.sink.hasObject(sha);
    if (alreadyAtSink) continue;

    const obj = await opts.source.readObject(sha);
    await opts.sink.writeObject(obj);

    if (obj.type === "commit") {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === "tree") {
      const entries = parseTree(obj.data);
      for (const entry of entries) queue.push(entry.oid);
    }
  }
}

interface ParsedCommit {
  tree: string;
  parents: string[];
}

function parseCommit(data: Uint8Array): ParsedCommit {
  const text = new TextDecoder("utf-8").decode(data);
  const headerEnd = text.indexOf("\n\n");
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const parents: string[] = [];
  let tree = "";
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    let spaceIdx = i;
    while (spaceIdx < data.length && data[spaceIdx] !== 0x20) spaceIdx++;
    const mode = new TextDecoder("utf-8").decode(data.slice(i, spaceIdx));

    let nullIdx = spaceIdx + 1;
    while (nullIdx < data.length && data[nullIdx] !== 0x00) nullIdx++;
    const name = new TextDecoder("utf-8").decode(
      data.slice(spaceIdx + 1, nullIdx),
    );

    const oidBytes = data.slice(nullIdx + 1, nullIdx + 21);
    const oid = Array.from(oidBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    entries.push({ mode, name, oid });
    i = nullIdx + 21;
  }
  return entries;
}

// --- Ancestor check ---

async function isAncestor(opts: {
  dev: ProjectRepo;
  ancestor: string;
  descendant: string;
}): Promise<boolean> {
  if (opts.ancestor === opts.descendant) return true;
  try {
    const commits = await git.log({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      ref: opts.descendant,
      depth: 500,
    });
    return commits.some((c) => c.oid === opts.ancestor);
  } catch {
    return false;
  }
}

async function devHasCommit(opts: {
  dev: ProjectRepo;
  sha: string;
}): Promise<boolean> {
  try {
    await git.readObject({
      fs: nodeFs,
      dir: opts.dev.repoPath,
      oid: opts.sha,
    });
    return true;
  } catch {
    return false;
  }
}

async function syncRemoteTrackingRef(opts: {
  dev: ProjectRepo;
  branch: string;
  sha: string;
}): Promise<void> {
  await git.writeRef({
    fs: nodeFs,
    dir: opts.dev.repoPath,
    ref: `refs/remotes/origin/${opts.branch}`,
    value: opts.sha,
    force: true,
  });
}

async function collectConflicts(opts: {
  dev: ProjectRepo;
  oursSha: string;
  theirsSha: string;
  raw: unknown;
}): Promise<ConflictEntry[]> {
  const raw = opts.raw as { filepaths?: string[] } | undefined;
  const paths = raw?.filepaths ?? [];
  const result: ConflictEntry[] = [];

  for (const filepath of paths) {
    const ours = await readAtRef(opts.dev.repoPath, opts.oursSha, filepath);
    const theirs = await readAtRef(opts.dev.repoPath, opts.theirsSha, filepath);
    const baseSha = await git
      .findMergeBase({
        fs: nodeFs,
        dir: opts.dev.repoPath,
        oids: [opts.oursSha, opts.theirsSha],
      })
      .then((bases) => bases[0] ?? null)
      .catch(() => null);
    const base = baseSha
      ? await readAtRef(opts.dev.repoPath, baseSha, filepath)
      : null;

    result.push({
      path: filepath,
      base,
      ours,
      theirs,
    });
  }
  return result;
}

async function readAtRef(
  dir: string,
  oid: string,
  filepath: string,
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({
      fs: nodeFs,
      dir,
      oid,
      filepath,
    });
    return new TextDecoder("utf-8").decode(blob);
  } catch {
    return null;
  }
}
