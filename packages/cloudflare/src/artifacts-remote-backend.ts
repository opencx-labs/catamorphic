import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { CloneSource, OriginRepo, RemoteBackend } from "@catamorphic/git";
import { FsOriginRepo } from "@catamorphic/git";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import {
  ArtifactsApiError,
  type ArtifactsClient,
  tokenSecret,
} from "./artifacts-client.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Invalid UUID: ${value}`);
  }
}

export interface ArtifactsRemoteBackendOpts {
  client: ArtifactsClient;
  /**
   * Local directory for bare mirror repos. `withOrigin` syncs the Artifacts
   * repo into a mirror here, runs the callback against it, then pushes any
   * ref changes back. The mirror is a disposable cache — safe to delete.
   */
  cachePath: string;
  /**
   * Prefix for Artifacts repo names, so multiple catamorphic environments
   * can share a namespace. Repo names look like
   * `<prefix>--<tenantId>--<projectId>`.
   */
  repoPrefix?: string;
}

interface CachedToken {
  secret: string;
  expiresAtMs: number;
}

/**
 * `RemoteBackend` storing each project's canonical bare repository in a
 * Cloudflare Artifacts repo (one Artifacts repo per project).
 *
 * Reads and writes go through real git smart-HTTP transport, so the same
 * repo is directly cloneable by sandboxes, CI, and local git clients via
 * {@link getCloneSource}.
 */
export class ArtifactsRemoteBackend implements RemoteBackend {
  private readonly client: ArtifactsClient;
  private readonly cachePath: string;
  private readonly repoPrefix: string;
  private readonly remoteUrls = new Map<string, string>();
  private readonly tokens = new Map<string, CachedToken>();

  constructor(opts: ArtifactsRemoteBackendOpts) {
    this.client = opts.client;
    this.cachePath = opts.cachePath;
    this.repoPrefix = opts.repoPrefix ?? "cat";
  }

  repoName(tenantId: string, projectId: string): string {
    assertUuid(tenantId);
    assertUuid(projectId);
    return `${this.repoPrefix}--${tenantId}--${projectId}`;
  }

  async initRemote(tenantId: string, projectId: string): Promise<void> {
    const name = this.repoName(tenantId, projectId);
    try {
      const created = await this.client.createRepo({
        name,
        defaultBranch: "main",
      });
      this.remoteUrls.set(name, created.remote);
      this.cacheToken(name, "write", created.token);
    } catch (err) {
      // 409 = repo already exists; init is idempotent.
      if (!(err instanceof ArtifactsApiError && err.status === 409)) {
        throw err;
      }
    }
  }

  async deleteRemote(tenantId: string, projectId: string): Promise<void> {
    const name = this.repoName(tenantId, projectId);
    await this.client.deleteRepo(name);
    this.remoteUrls.delete(name);
    this.tokens.delete(this.tokenKey(name, "read"));
    this.tokens.delete(this.tokenKey(name, "write"));
    await fs.rm(this.mirrorPath(tenantId, projectId), {
      recursive: true,
      force: true,
    });
  }

  async exists(tenantId: string, projectId: string): Promise<boolean> {
    const name = this.repoName(tenantId, projectId);
    if (this.remoteUrls.has(name)) return true;
    const repo = await this.client.getRepo(name);
    if (repo) this.remoteUrls.set(name, repo.remote);
    return repo !== null;
  }

  async getCloneSource(
    tenantId: string,
    projectId: string,
    opts?: { scope?: "read" | "write" },
  ): Promise<CloneSource> {
    const name = this.repoName(tenantId, projectId);
    const url = await this.remoteUrl(name);
    const scope = opts?.scope ?? "read";
    const secret = await this.token(name, scope);
    return { url, username: "x", password: secret, branch: "main" };
  }

  async withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T> {
    const name = this.repoName(tenantId, projectId);
    const url = await this.remoteUrl(name);
    const gitdir = this.mirrorPath(tenantId, projectId);

    await this.ensureMirror(gitdir);
    const remoteRefs = await this.syncMirrorFromRemote({ gitdir, url, name });

    const result = await fn(new FsOriginRepo(gitdir));

    await this.pushChangedRefs({ gitdir, url, name, remoteRefs });
    return result;
  }

  private mirrorPath(tenantId: string, projectId: string): string {
    assertUuid(tenantId);
    assertUuid(projectId);
    const mirror = path.join(this.cachePath, tenantId, `${projectId}.git`);
    if (!path.resolve(mirror).startsWith(path.resolve(this.cachePath))) {
      throw new Error("Path traversal detected");
    }
    return mirror;
  }

  private async ensureMirror(gitdir: string): Promise<void> {
    try {
      await fs.access(path.join(gitdir, "HEAD"));
    } catch {
      await fs.mkdir(gitdir, { recursive: true });
      await git.init({
        fs: nodeFs,
        dir: gitdir,
        gitdir,
        bare: true,
        defaultBranch: "main",
      });
    }
  }

  /**
   * Pull every remote branch into the mirror's `refs/heads/*`. Returns the
   * remote's ref snapshot so `pushChangedRefs` can diff after the callback.
   */
  private async syncMirrorFromRemote(opts: {
    gitdir: string;
    url: string;
    name: string;
  }): Promise<Map<string, string>> {
    const onAuth = await this.onAuth(opts.name, "read");
    const serverRefs = await git.listServerRefs({
      http,
      url: opts.url,
      prefix: "refs/heads/",
      onAuth,
    });

    const snapshot = new Map<string, string>();
    for (const serverRef of serverRefs) {
      snapshot.set(serverRef.ref, serverRef.oid);

      const localSha = await resolveRefSafe(opts.gitdir, serverRef.ref);
      if (localSha === serverRef.oid) continue;

      const branch = serverRef.ref.replace(/^refs\/heads\//, "");
      await git.fetch({
        fs: nodeFs,
        http,
        gitdir: opts.gitdir,
        url: opts.url,
        ref: branch,
        singleBranch: true,
        tags: false,
        onAuth,
      });
      await git.writeRef({
        fs: nodeFs,
        gitdir: opts.gitdir,
        ref: serverRef.ref,
        value: serverRef.oid,
        force: true,
      });
    }
    return snapshot;
  }

  /** Push every `refs/heads/*` ref the callback created or moved. */
  private async pushChangedRefs(opts: {
    gitdir: string;
    url: string;
    name: string;
    remoteRefs: Map<string, string>;
  }): Promise<void> {
    const branches = await git.listBranches({
      fs: nodeFs,
      gitdir: opts.gitdir,
    });

    const changed: string[] = [];
    for (const branch of branches) {
      const ref = `refs/heads/${branch}`;
      const localSha = await resolveRefSafe(opts.gitdir, ref);
      if (localSha && opts.remoteRefs.get(ref) !== localSha) {
        changed.push(branch);
      }
    }
    if (changed.length === 0) return;

    const onAuth = await this.onAuth(opts.name, "write");
    for (const branch of changed) {
      await git.push({
        fs: nodeFs,
        http,
        gitdir: opts.gitdir,
        url: opts.url,
        ref: `refs/heads/${branch}`,
        remoteRef: `refs/heads/${branch}`,
        // git-sync already enforces fast-forward semantics at a higher
        // level; force mirrors FsOriginRepo.updateRef's behavior.
        force: true,
        onAuth,
      });
    }
  }

  private async remoteUrl(name: string): Promise<string> {
    const cached = this.remoteUrls.get(name);
    if (cached) return cached;
    const repo = await this.client.getRepo(name);
    if (!repo) {
      throw new Error(`Artifacts repo '${name}' does not exist`);
    }
    this.remoteUrls.set(name, repo.remote);
    return repo.remote;
  }

  private async onAuth(
    name: string,
    scope: "read" | "write",
  ): Promise<() => { username: string; password: string }> {
    const secret = await this.token(name, scope);
    return () => ({ username: "x", password: secret });
  }

  private tokenKey(name: string, scope: "read" | "write"): string {
    return `${name}:${scope}`;
  }

  private cacheToken(
    name: string,
    scope: "read" | "write",
    plaintext: string,
  ): string {
    const secret = tokenSecret(plaintext);
    const expiresMatch = plaintext.match(/\?expires=(\d+)/);
    const expiresAtMs = expiresMatch
      ? Number(expiresMatch[1]) * 1000
      : Date.now() + 3600_000;
    this.tokens.set(this.tokenKey(name, scope), { secret, expiresAtMs });
    return secret;
  }

  private async token(name: string, scope: "read" | "write"): Promise<string> {
    const cached = this.tokens.get(this.tokenKey(name, scope));
    if (cached && cached.expiresAtMs - Date.now() > 60_000) {
      return cached.secret;
    }
    const token = await this.client.createToken({ repo: name, scope });
    return this.cacheToken(name, scope, token.plaintext);
  }
}

async function resolveRefSafe(
  gitdir: string,
  ref: string,
): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: nodeFs, gitdir, ref });
  } catch {
    return null;
  }
}
