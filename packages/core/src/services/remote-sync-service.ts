import type { DB } from "@catamorphic/db";
import {
  type NetworkSyncResult,
  type ProjectManager,
  pushToRemote,
  syncWithNetworkRemote,
} from "@catamorphic/git";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type {
  CodeHost,
  PullRequestFile,
  PullRequestSummary,
} from "./code-host.js";

const SYNC_AUTHOR = { name: "Catamorphic", email: "system@catamorphic.dev" };

export type RemoteSyncOutcome = { status: "no-remote" } | NetworkSyncResult;

export class ProjectHasNoRemoteError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' is not linked to a remote repository`);
    this.name = "ProjectHasNoRemoteError";
  }
}

export class PullRequestsUnsupportedError extends Error {
  constructor(remoteUrl: string) {
    super(`No connected code host can open pull requests for '${remoteUrl}'`);
    this.name = "PullRequestsUnsupportedError";
  }
}

/**
 * Keeps a project's local `main` converged with its linked network remote
 * (ADR 0044). Provider-agnostic: hosts contribute credentials and optional
 * capabilities through the {@link CodeHost} seam. Calls are coalesced per
 * project — sync fires from turn-settled hooks, boot, and timers, and must
 * never run concurrently against one repo nor break its caller.
 */
export class RemoteSyncService {
  private readonly inflight = new Map<string, Promise<RemoteSyncOutcome>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly hosts: CodeHost[],
  ) {}

  /**
   * Run the sync policy now. Never throws for the routine outcomes —
   * conflicts and deferrals are reported as statuses; unexpected errors do
   * throw so explicit callers (the agent tool) can see them.
   */
  async sync(
    identity: Identity,
    projectId: string,
  ): Promise<RemoteSyncOutcome> {
    const existing = this.inflight.get(projectId);
    if (existing) return existing;
    const run = this.syncInner(identity, projectId).finally(() => {
      this.inflight.delete(projectId);
    });
    this.inflight.set(projectId, run);
    return run;
  }

  /** Fire-and-forget variant for hooks and timers: logs instead of throwing. */
  syncInBackground(identity: Identity, projectId: string): void {
    void this.sync(identity, projectId).catch((cause) => {
      console.warn(`Remote sync failed for project ${projectId}:`, cause);
    });
  }

  private async syncInner(
    identity: Identity,
    projectId: string,
  ): Promise<RemoteSyncOutcome> {
    const row = await this.projectRow(identity, projectId);
    if (!row?.remote_url) return { status: "no-remote" };

    const credentials = await this.credentialsFor(identity, row.remote_url);
    const dev = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return await syncWithNetworkRemote({
        dev,
        url: row.remote_url,
        credentials,
        remoteBranch: row.remote_branch ?? "main",
        author: SYNC_AUTHOR,
      });
    } finally {
      await dev.dispose();
    }
  }

  /**
   * Push HEAD to a fresh branch on the linked remote and open a pull request
   * through the host's capability. The dev repo's dirty tree is committed
   * first (the turn's checkpoint has not run yet when an agent calls this
   * mid-turn) so the PR contains the work being described.
   */
  async createPullRequest(
    identity: Identity,
    projectId: string,
    input: { title: string; body?: string },
  ): Promise<{ url: string; number: number; branch: string }> {
    const row = await this.projectRow(identity, projectId);
    const remoteUrl = row?.remote_url;
    if (!remoteUrl) throw new ProjectHasNoRemoteError(projectId);
    const host = this.hosts.find((h) => h.handles(remoteUrl));
    if (!host?.createPullRequest) {
      throw new PullRequestsUnsupportedError(remoteUrl);
    }
    const credentials = await host.credentials(identity);

    const dev = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      const status = await dev.status();
      if (status.dirty) {
        await dev.commit(input.title, SYNC_AUTHOR);
      }
      const branch = prBranchName(input.title, new Date());
      await pushToRemote({
        repoPath: dev.repoPath,
        url: remoteUrl,
        credentials,
        ref: "HEAD",
        remoteBranch: branch,
      });
      const pr = await host.createPullRequest(identity, {
        remoteUrl,
        title: input.title,
        head: branch,
        base: row?.remote_branch ?? "main",
        body: input.body,
      });
      return { ...pr, branch };
    } finally {
      await dev.dispose();
    }
  }

  /**
   * Open PRs on the linked remote, `[]` when the project has no remote or
   * no connected host offers PR listing — review surfaces render an empty
   * section, they don't error.
   */
  async listPullRequests(
    identity: Identity,
    projectId: string,
  ): Promise<PullRequestSummary[]> {
    const row = await this.projectRow(identity, projectId);
    const remoteUrl = row?.remote_url;
    if (!remoteUrl) return [];
    const host = this.hosts.find((h) => h.handles(remoteUrl));
    if (!host?.listPullRequests) return [];
    try {
      return await host.listPullRequests(identity, { remoteUrl });
    } catch (cause) {
      console.warn(`PR listing failed for project ${projectId}:`, cause);
      return [];
    }
  }

  /** A PR's changed files with patches; throws when unsupported. */
  async pullRequestFiles(
    identity: Identity,
    projectId: string,
    number: number,
  ): Promise<PullRequestFile[]> {
    const row = await this.projectRow(identity, projectId);
    const remoteUrl = row?.remote_url;
    if (!remoteUrl) throw new ProjectHasNoRemoteError(projectId);
    const host = this.hosts.find((h) => h.handles(remoteUrl));
    if (!host?.pullRequestFiles) {
      throw new PullRequestsUnsupportedError(remoteUrl);
    }
    return host.pullRequestFiles(identity, { remoteUrl, number });
  }

  private async credentialsFor(identity: Identity, remoteUrl: string) {
    const host = this.hosts.find((h) => h.handles(remoteUrl));
    if (!host) return undefined;
    try {
      return await host.credentials(identity);
    } catch (cause) {
      // A host that cannot mint credentials (disconnected, expired) must not
      // kill the sync — unauthenticated access may still work for public
      // remotes, and the failure will surface on the push if it matters.
      console.warn(`Code host '${host.id}' credentials unavailable:`, cause);
      return undefined;
    }
  }

  private projectRow(identity: Identity, projectId: string) {
    return this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select(["remote_url", "remote_branch"])
      .executeTakeFirst();
  }
}

/** `catamorphic/<title-slug>-HHmm` — readable on the host, unique enough. */
function prBranchName(title: string, now: Date): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "change";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `catamorphic/${slug}-${pad(now.getUTCHours())}${pad(
    now.getUTCMinutes(),
  )}`;
}
