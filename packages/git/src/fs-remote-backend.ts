import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";
import { RefMovedError } from "./ref-moved-error.js";
import type { CommitInfo, OriginRepo, RemoteBackend } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

/**
 * Ref updates in flight per ref. A bare repository on local disk serves one
 * process (a single-machine host), so serializing its compare-and-swap in
 * that process makes it atomic; several processes need an object origin.
 */
const refLocks = new Map<string, Promise<unknown>>();

async function withRefLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = refLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  refLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (refLocks.get(key) === run) refLocks.delete(key);
  }
}

export class FsRemoteBackend implements RemoteBackend {
  constructor(private readonly basePath: string) {}

  private resolveBarePath(tenantId: string, projectId: string): string {
    assertUuid(tenantId);
    assertUuid(projectId);
    const barePath = path.join(this.basePath, tenantId, `${projectId}.git`);
    if (!path.resolve(barePath).startsWith(path.resolve(this.basePath))) {
      throw new Error("Path traversal detected");
    }
    return barePath;
  }

  async initRemote(tenantId: string, projectId: string): Promise<void> {
    const barePath = this.resolveBarePath(tenantId, projectId);
    await fs.mkdir(barePath, { recursive: true });
    await git.init({
      fs: nodeFs,
      dir: barePath,
      bare: true,
      defaultBranch: "main",
    });
  }

  async deleteRemote(tenantId: string, projectId: string): Promise<void> {
    const barePath = this.resolveBarePath(tenantId, projectId);
    await fs.rm(barePath, { recursive: true, force: true });
  }

  async exists(tenantId: string, projectId: string): Promise<boolean> {
    const barePath = this.resolveBarePath(tenantId, projectId);
    try {
      await fs.access(barePath);
      return true;
    } catch {
      return false;
    }
  }

  async withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T> {
    const barePath = this.resolveBarePath(tenantId, projectId);
    const origin = new FsOriginRepo(barePath);
    return fn(origin);
  }
}

/**
 * OriginRepo over a local bare repo directory. Used directly by
 * `FsRemoteBackend` and reused by network-remote backends (e.g. Cloudflare
 * Artifacts) that maintain a local bare mirror.
 */
export class FsOriginRepo implements OriginRepo {
  private readonly cache = {};
  constructor(readonly gitdir: string) {}

  async resolveRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: nodeFs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  async listRefs(prefix: string): Promise<{ ref: string; sha: string }[]> {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const stripped = normalized.replace(/\/$/, "");
    const refs = await git.listBranches({
      fs: nodeFs,
      gitdir: this.gitdir,
    });
    const prefixMatch = stripped === "refs/heads";
    if (!prefixMatch) return [];
    const entries = await Promise.all(
      refs.map(async (name) => ({
        ref: `refs/heads/${name}`,
        sha: await git.resolveRef({
          fs: nodeFs,
          gitdir: this.gitdir,
          ref: `refs/heads/${name}`,
        }),
      })),
    );
    return entries;
  }

  async updateRef(opts: {
    ref: string;
    sha: string;
    expected?: string | null;
  }): Promise<void> {
    await withRefLock(`${this.gitdir}\0${opts.ref}`, () =>
      this.writeRefChecked(opts),
    );
  }

  private async writeRefChecked(opts: {
    ref: string;
    sha: string;
    expected?: string | null;
  }): Promise<void> {
    if (opts.expected !== undefined) {
      const current = await this.resolveRef(opts.ref);
      if (current !== opts.expected) {
        throw new RefMovedError({
          ref: opts.ref,
          expected: opts.expected,
          actual: current,
        });
      }
    }
    await git.writeRef({
      fs: nodeFs,
      gitdir: this.gitdir,
      ref: opts.ref,
      value: opts.sha,
      force: true,
    });
  }

  async deleteRef(input: { ref: string; expected?: string }): Promise<void> {
    await withRefLock(`${this.gitdir}\0${input.ref}`, () =>
      this.deleteRefChecked(input),
    );
  }

  private async deleteRefChecked(input: {
    ref: string;
    expected?: string;
  }): Promise<void> {
    if (input.expected !== undefined) {
      const current = await this.resolveRef(input.ref);
      if (current !== input.expected)
        throw new RefMovedError({
          ref: input.ref,
          expected: input.expected,
          actual: current,
        });
    }
    await git.deleteRef({ fs: nodeFs, gitdir: this.gitdir, ref: input.ref });
  }

  async hasObject(sha: string): Promise<boolean> {
    try {
      await git.readObject({
        fs: nodeFs,
        gitdir: this.gitdir,
        oid: sha,
        cache: this.cache,
      });
      return true;
    } catch {
      return false;
    }
  }

  async readObject(sha: string): Promise<{
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }> {
    const obj = await git.readObject({
      fs: nodeFs,
      gitdir: this.gitdir,
      oid: sha,
      format: "content",
      cache: this.cache,
    });
    if (obj.type === "deflated" || obj.type === "wrapped") {
      throw new Error(`Unexpected object format for ${sha}: ${obj.type}`);
    }
    return {
      type: obj.type as "blob" | "tree" | "commit" | "tag",
      data: obj.object as Uint8Array,
    };
  }

  async writeObject(opts: {
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }): Promise<string> {
    return git.writeObject({
      fs: nodeFs,
      gitdir: this.gitdir,
      type: opts.type,
      object: opts.data,
      format: "content",
    });
  }

  async log(ref: string, maxCount = 50): Promise<CommitInfo[]> {
    try {
      const commits = await git.log({
        fs: nodeFs,
        gitdir: this.gitdir,
        ref,
        depth: maxCount,
      });
      return commits.map((c) => ({
        sha: c.oid,
        message: c.commit.message,
        author: {
          name: c.commit.author.name,
          email: c.commit.author.email,
        },
        timestamp: c.commit.author.timestamp,
      }));
    } catch {
      return [];
    }
  }
}
