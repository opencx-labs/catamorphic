import { randomUUID } from "node:crypto";
import {
  type GitObjectType,
  parseCommit,
  unwrapObject,
  wrapObject,
} from "./git-object-codec.js";
import { type ObjectStore, PreconditionFailedError } from "./object-store.js";
import { RefMovedError } from "./ref-moved-error.js";
import { InvalidRefNameError, isValidRefName } from "./ref-names.js";
import type {
  CommitInfo,
  DraftSupport,
  OriginRepo,
  RemoteBackend,
} from "./types.js";

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
  if (!REF_RE.test(ref) || !isValidRefName(ref))
    throw new InvalidRefNameError(ref);
}

/**
 * Check that a store enforces the preconditions drafts rely on: a put with
 * `ifNoneMatch` on an existing key, and deletes with a stale or the current
 * `ifMatch`. Returns why it does not, or null when it does. The probe key
 * is removed afterwards.
 */
export async function probeConditionalWrites(input: {
  store: ObjectStore;
  key: string;
}): Promise<string | null> {
  const { store, key } = input;
  const refused = async (write: () => Promise<void>) =>
    write().then(
      () => false,
      (error: unknown) => {
        if (error instanceof PreconditionFailedError) return true;
        throw error;
      },
    );
  try {
    // A stale ETag the store itself issued: the one before an overwrite.
    await store.put(key, new TextEncoder().encode(`probe ${randomUUID()}`));
    const stale = await store.get(key);
    await store.put(key, new TextEncoder().encode(`probe ${randomUUID()}`));
    const entry = await store.get(key);
    if (!stale || !entry) return "the store did not keep a written object";
    if (stale.etag === entry.etag)
      return "the store kept an object's ETag when its content changed";
    if (
      !(await refused(() =>
        store.put(key, new TextEncoder().encode("again"), {
          ifNoneMatch: "*",
        }),
      ))
    )
      return "the store ignores If-None-Match on writes";
    if (
      !(await refused(() => store.delete(key, { ifMatch: stale.etag }))) ||
      !(await store.has(key))
    )
      return "the store ignores If-Match on deletes, so a draft could be deleted after another replica moved it";
    await store.delete(key, { ifMatch: entry.etag });
    if (await store.has(key))
      return "the store did not delete an object whose ETag matched";
    return null;
  } finally {
    await store.delete(key).catch(() => {});
  }
}

export interface ObjectRemoteBackendOpts {
  store: ObjectStore;
  /**
   * Key prefix so multiple catamorphic environments can share a bucket.
   * Project layout: `<keyPrefix><tenantId>/<projectId>/{repo.json,objects/,refs/}`.
   */
  keyPrefix?: string;
}

/**
 * `RemoteBackend` storing each project's canonical bare repository directly
 * in a host-injected object store. S3 and Postgres backends share the same
 * immutable objects and conditional ref updates, without a local origin mirror.
 *
 * Git objects are immutable and content-addressed, so they map cleanly onto
 * object storage; ref updates use conditional PUTs (`If-Match` /
 * `If-None-Match`) for the compare-and-swap semantics `OriginRepo.updateRef`
 * requires. Buckets don't speak the git protocol, so `getCloneSource` is not
 * implemented and sandboxes receive file uploads (same as `FsRemoteBackend`).
 * See docs/decisions/0012.
 */
export class ObjectRemoteBackend implements RemoteBackend {
  private readonly store: ObjectStore;
  private readonly keyPrefix: string;
  private draftCheck: Promise<DraftSupport> | undefined;

  constructor(opts: ObjectRemoteBackendOpts) {
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

  /**
   * Drafts need conditional puts and deletes that the store really
   * enforces (ADR 0191). Some S3-compatible stores ignore `If-Match` on
   * DeleteObject, so the store is probed once per process before any draft
   * is written, and drafts are refused on a store that fails.
   */
  draftSupport(): Promise<DraftSupport> {
    this.draftCheck ??= probeConditionalWrites({
      store: this.store,
      key: `${this.keyPrefix}conformance/${randomUUID()}`,
    }).then(
      (failure): DraftSupport =>
        failure ? { supported: false, reason: failure } : { supported: true },
    );
    return this.draftCheck;
  }

  async withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T> {
    return fn(
      new ObjectOriginRepo({
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
export class ObjectOriginRepo implements OriginRepo {
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

    const expected = opts.expected;
    const moved = async (): Promise<never> => {
      throw new RefMovedError({
        ref: opts.ref,
        expected,
        actual: await this.resolveRef(opts.ref),
      });
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

  async deleteRef(input: { ref: string; expected?: string }): Promise<void> {
    const key = this.refKey(input.ref);
    if (input.expected === undefined) {
      await this.store.delete(key);
      return;
    }
    const entry = await this.store.get(key);
    const actual = entry ? new TextDecoder().decode(entry.data).trim() : null;
    const moved = () =>
      new RefMovedError({
        ref: input.ref,
        expected: input.expected ?? null,
        actual,
      });
    if (!entry || actual !== input.expected) throw moved();
    try {
      await this.store.delete(key, { ifMatch: entry.etag });
    } catch (err) {
      if (err instanceof PreconditionFailedError) throw moved();
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
