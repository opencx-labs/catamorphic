import type { CommitInfo, OriginRepo, RemoteBackend } from "@catamorphic/git";
import {
  type GitObjectType,
  parseCommit,
  unwrapObject,
  wrapObject,
} from "./git-object-codec.js";
import { type ObjectStore, PreconditionFailedError } from "./object-store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;

function assertRefName(ref: string): void {
  if (!REF_RE.test(ref) || ref.includes("..")) {
    throw new Error(`Invalid ref name: ${ref}`);
  }
}

export interface S3RemoteBackendOpts {
  store: ObjectStore;
  /**
   * Key prefix so multiple catamorphic environments can share a bucket.
   * Project layout: `<keyPrefix><tenantId>/<projectId>/{repo.json,objects/,refs/}`.
   */
  keyPrefix?: string;
}

/**
 * `RemoteBackend` storing each project's canonical bare repository directly
 * in an S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) — no local
 * mirror, no git repo on disk.
 *
 * Git objects are immutable and content-addressed, so they map cleanly onto
 * object storage; ref updates use conditional PUTs (`If-Match` /
 * `If-None-Match`) for the compare-and-swap semantics `OriginRepo.updateRef`
 * requires. Buckets don't speak the git protocol, so `getCloneSource` is not
 * implemented and sandboxes receive file uploads (same as `FsRemoteBackend`).
 * See docs/decisions/0012.
 */
export class S3RemoteBackend implements RemoteBackend {
  private readonly store: ObjectStore;
  private readonly keyPrefix: string;

  constructor(opts: S3RemoteBackendOpts) {
    this.store = opts.store;
    this.keyPrefix = opts.keyPrefix ?? "";
  }

  private basePath(tenantId: string, projectId: string): string {
    assertUuid(tenantId);
    assertUuid(projectId);
    return `${this.keyPrefix}${tenantId}/${projectId}`;
  }

  private markerKey(tenantId: string, projectId: string): string {
    return `${this.basePath(tenantId, projectId)}/repo.json`;
  }

  async initRemote(tenantId: string, projectId: string): Promise<void> {
    const marker = new TextEncoder().encode(
      JSON.stringify({ createdAt: new Date().toISOString() }),
    );
    try {
      await this.store.put(this.markerKey(tenantId, projectId), marker, {
        ifNoneMatch: "*",
      });
    } catch (err) {
      // Already initialized — init is idempotent.
      if (!(err instanceof PreconditionFailedError)) throw err;
    }
  }

  async deleteRemote(tenantId: string, projectId: string): Promise<void> {
    await this.store.deletePrefix(`${this.basePath(tenantId, projectId)}/`);
  }

  async exists(tenantId: string, projectId: string): Promise<boolean> {
    return this.store.has(this.markerKey(tenantId, projectId));
  }

  async withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T> {
    return fn(
      new S3OriginRepo({
        store: this.store,
        basePath: this.basePath(tenantId, projectId),
      }),
    );
  }
}

/**
 * `OriginRepo` over a key prefix in an object store:
 * - `objects/<sha>` — wrapped git objects (`<type> <len>\0<content>`), so
 *   `sha1(body) == key` and every object is self-verifying.
 * - `refs/heads/<branch>` — the 40-char commit SHA as the body.
 */
export class S3OriginRepo implements OriginRepo {
  private readonly store: ObjectStore;
  private readonly basePath: string;
  /** Synthetic identifier — this origin has no on-disk git directory. */
  readonly gitdir: string;

  constructor(opts: { store: ObjectStore; basePath: string }) {
    this.store = opts.store;
    this.basePath = opts.basePath;
    this.gitdir = `objectstore://${opts.basePath}`;
  }

  private refKey(ref: string): string {
    assertRefName(ref);
    return `${this.basePath}/${ref}`;
  }

  private objectKey(sha: string): string {
    if (!SHA_RE.test(sha)) {
      throw new Error(`Invalid object sha: ${sha}`);
    }
    return `${this.basePath}/objects/${sha}`;
  }

  async resolveRef(ref: string): Promise<string | null> {
    const entry = await this.store.get(this.refKey(ref));
    if (!entry) return null;
    const sha = new TextDecoder().decode(entry.data).trim();
    return SHA_RE.test(sha) ? sha : null;
  }

  async listRefs(prefix: string): Promise<{ ref: string; sha: string }[]> {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    assertRefName(normalized.slice(0, -1));
    const keys = await this.store.list(`${this.basePath}/${normalized}`);
    const entries = await Promise.all(
      keys.map(async (key) => {
        const ref = key.slice(this.basePath.length + 1);
        const sha = await this.resolveRef(ref);
        return sha ? { ref, sha } : null;
      }),
    );
    return entries.filter((entry) => entry !== null);
  }

  async updateRef(opts: {
    ref: string;
    sha: string;
    expected?: string | null;
  }): Promise<void> {
    const key = this.refKey(opts.ref);
    const body = new TextEncoder().encode(opts.sha);

    if (opts.expected === undefined) {
      await this.store.put(key, body);
      return;
    }

    const moved = async (): Promise<never> => {
      const current = await this.resolveRef(opts.ref);
      throw new Error(
        `Ref ${opts.ref} moved (expected ${opts.expected ?? "none"}, got ${current ?? "none"})`,
      );
    };

    if (opts.expected === null) {
      try {
        await this.store.put(key, body, { ifNoneMatch: "*" });
      } catch (err) {
        if (err instanceof PreconditionFailedError) await moved();
        throw err;
      }
      return;
    }

    const currentEntry = await this.store.get(key);
    const currentSha = currentEntry
      ? new TextDecoder().decode(currentEntry.data).trim()
      : null;
    if (!currentEntry || currentSha !== opts.expected) {
      await moved();
      return;
    }
    try {
      await this.store.put(key, body, { ifMatch: currentEntry.etag });
    } catch (err) {
      if (err instanceof PreconditionFailedError) await moved();
      throw err;
    }
  }

  async hasObject(sha: string): Promise<boolean> {
    return this.store.has(this.objectKey(sha));
  }

  async readObject(sha: string): Promise<{
    type: GitObjectType;
    data: Uint8Array;
  }> {
    const entry = await this.store.get(this.objectKey(sha));
    if (!entry) {
      throw new Error(`Object not found: ${sha}`);
    }
    return unwrapObject(entry.data);
  }

  async writeObject(opts: {
    type: GitObjectType;
    data: Uint8Array;
  }): Promise<string> {
    const { wrapped, sha } = wrapObject(opts);
    // Objects are immutable and content-addressed; skip the PUT when the
    // object is already stored, otherwise write unconditionally (an
    // overwrite is byte-identical by construction).
    if (!(await this.hasObject(sha))) {
      await this.store.put(this.objectKey(sha), wrapped);
    }
    return sha;
  }

  async log(ref: string, maxCount = 50): Promise<CommitInfo[]> {
    const tip = await this.resolveRef(ref);
    if (!tip) return [];

    const commits: CommitInfo[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];

    while (queue.length > 0 && commits.length < maxCount) {
      const sha = queue.shift();
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);

      const entry = await this.store.get(this.objectKey(sha));
      if (!entry) break;
      const obj = unwrapObject(entry.data);
      if (obj.type !== "commit") break;

      const commit = parseCommit(obj.data);
      commits.push({
        sha,
        message: commit.message,
        author: { name: commit.author.name, email: commit.author.email },
        timestamp: commit.author.timestamp,
      });
      queue.push(...commit.parents);
    }

    return commits.sort((a, b) => b.timestamp - a.timestamp);
  }
}
