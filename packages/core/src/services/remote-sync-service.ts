import { randomBytes } from "node:crypto";
import type { DB } from "@catamorphic/db";
import {
  fetchFromRemote,
  type GitCredentials,
  type NetworkSyncResult,
  type ProjectManager,
  PushNotFastForwardError,
  push,
  pushToRemote,
  syncWithNetworkRemote,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { MANAGED_BRANCH_PREFIX } from "@catamorphic/workflow/project-layout";
import type { Kysely } from "kysely";
import { hasProjectPermission, type Identity } from "../identity.js";
import {
  AccessDeniedError,
  assertProjectPermission,
} from "./artifact-scope.js";
import {
  type CodeHostsService,
  CodeHostUnsupportedError,
} from "./code-hosts-service.js";
import { remoteOwnership } from "./projects-service.js";

const tracer = getTracer("@catamorphic/core");

const SYNC_AUTHOR = { name: "Work", email: "system@work.software" };

export type RemoteSyncOutcome = { status: "no-remote" } | NetworkSyncResult;

/**
 * Keeps a project's local `main` converged with its linked network remote
 * (ADR 0044). An attached remote (one that existed before Work, ADR 0170) is
 * only fetched and fast-forwarded; local commits reach it as a `work/*`
 * branch plus a pull request. Provider-agnostic: hosts contribute credentials
 * and pull requests through connections and the code-host seam (ADR 0177). Calls are coalesced per
 * project — sync fires from turn-settled hooks, boot, and timers, and must
 * never run concurrently against one repo nor break its caller.
 */
export class RemoteSyncService {
  /**
   * Replica memory (a): syncs in flight through this process's working
   * copies. A push to the origin is a compare-and-swap, so replicas never
   * overwrite each other; the Work server syncs each project on one
   * replica at a time under a claim (ADR 0193).
   */
  private readonly inflight = new Map<string, Promise<RemoteSyncOutcome>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly codeHosts: CodeHostsService,
  ) {}

  /**
   * Download accepted code-host changes without publishing a member's work.
   * When the project's main has diverged from the code host's, nothing is
   * downloaded; the project records since when (`remoteDivergedAt`) until
   * the two converge again.
   */
  async syncPublished(input: {
    identity: Identity;
    projectId: string;
  }): Promise<RemoteSyncOutcome> {
    const { identity, projectId } = input;
    if (!hasProjectPermission(identity, projectId, "program:publish"))
      throw new AccessDeniedError();
    const key = `published:${projectId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const run = withSpan(
      {
        tracer,
        name: "project.remote.sync_published",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.tenant.id": identity.tenantId,
        },
      },
      async (): Promise<RemoteSyncOutcome> => {
        const remote = this.projectManager.remoteBackend;
        const row = await this.projectRow(identity, projectId);
        if (!remote || !row?.remote_url) return { status: "no-remote" };
        const dev = await this.projectManager.openEphemeral({
          tenantId: identity.tenantId,
          projectId,
        });
        try {
          const localSha = await dev.resolveRef();
          const fetched = await fetchFromRemote({
            repoPath: dev.repoPath,
            url: row.remote_url,
            credentials: await this.credentialsFor({
              identity,
              projectId,
              remoteUrl: row.remote_url,
              access: "read",
            }),
            branch: row.remote_branch ?? "main",
          });
          const remoteSha = fetched.sha;
          if (!remoteSha) return { status: "no-op", localSha, remoteSha };
          if (remoteSha === localSha) {
            await this.markDiverged({ identity, projectId, diverged: false });
            return { status: "up-to-date", localSha, remoteSha };
          }
          try {
            await push({
              dev,
              remote,
              tenantId: identity.tenantId,
              projectId,
              remoteBranch: "main",
              localSha: remoteSha,
            });
          } catch (error) {
            if (error instanceof PushNotFastForwardError) {
              // Never resolve divergence by pushing unreviewed server work to the code host.
              await this.markDiverged({ identity, projectId, diverged: true });
              return { status: "diverged", localSha, remoteSha };
            }
            throw error;
          }
          await this.markDiverged({ identity, projectId, diverged: false });
          return { status: "pulled", localSha: remoteSha, remoteSha };
        } finally {
          await dev.dispose();
        }
      },
    ).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

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
    return withSpan(
      {
        tracer,
        name: "project.remote.sync",
        attributes: {
          "catamorphic.tenant.id": identity.tenantId,
          "user.id": identity.externalUserId,
          "catamorphic.project.id": projectId,
        },
      },
      async () => {
        const row = await this.projectRow(identity, projectId);
        if (!row?.remote_url) return { status: "no-remote" };

        const ownership = remoteOwnership(row.remote_ownership) ?? "attached";
        const credentials = await this.credentialsFor({
          identity,
          projectId,
          remoteUrl: row.remote_url,
          // Work pushes only to a repository it created (ADR 0170).
          access: ownership === "owned" ? "write" : "read",
        });
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
            ownership,
            author: SYNC_AUTHOR,
          });
        } finally {
          await dev.dispose();
        }
      },
    );
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
    return this.createPullRequestInner(identity, projectId, input);
  }

  /**
   * Host integration for a linked worktree. The host validates and
   * checkpoints the checkout first; this method pushes its named ref from
   * the repository's shared Git directory without touching the primary tree.
   */
  async createPullRequestFromRef(
    identity: Identity,
    projectId: string,
    input: { title: string; body?: string; localRef: string },
  ): Promise<{ url: string; number: number; branch: string }> {
    if (!validLocalBranch(input.localRef)) {
      throw new Error(`Invalid local branch ref '${input.localRef}'`);
    }
    return this.createPullRequestInner(identity, projectId, input);
  }

  private async createPullRequestInner(
    identity: Identity,
    projectId: string,
    input: { title: string; body?: string; localRef?: string },
  ): Promise<{ url: string; number: number; branch: string }> {
    // Pushing a branch to the origin changes the program; the connection may
    // be the organization's, so the caller's own permission decides.
    assertProjectPermission(identity, projectId, "program:write");
    return withSpan(
      {
        tracer,
        name: "project.remote.create_pull_request",
        attributes: {
          "catamorphic.tenant.id": identity.tenantId,
          "user.id": identity.externalUserId,
          "catamorphic.project.id": projectId,
        },
      },
      async () => {
        return this.codeHosts.withOrigin({
          identity,
          projectId,
          principal: "either",
          capability: "opening pull requests",
          use: async ({ host, provider, credential, remoteUrl, project }) => {
            if (!host.createPullRequest || !provider.git) {
              throw new CodeHostUnsupportedError(
                remoteUrl,
                "opening pull requests",
              );
            }
            const minted = await provider.git.credentials({
              material: credential.material,
              remoteUrl,
              access: "write",
            });
            const dev = await this.projectManager.openDev(
              identity.tenantId,
              projectId,
              identity.externalUserId,
            );
            try {
              const local = Boolean(
                await this.projectManager.localPath({
                  tenantId: identity.tenantId,
                  projectId,
                }),
              );
              if (!input.localRef) {
                const status = await dev.status();
                if (status.dirty) {
                  if (local)
                    throw new Error(
                      "Record the changes you want to share first. Opening a pull request will not stage your pending work.",
                    );
                  await dev.commit(input.title, SYNC_AUTHOR);
                }
              }
              const branch = prBranchName(input.title, new Date());
              await pushToRemote({
                repoPath: dev.repoPath,
                native: local,
                url: remoteUrl,
                credentials: {
                  username: minted.username,
                  password: minted.password,
                },
                ownership:
                  remoteOwnership(project.remoteOwnership) ?? "attached",
                ref: input.localRef ?? "HEAD",
                remoteBranch: branch,
              });
              const pr = await host.createPullRequest({
                credential,
                remoteUrl,
                title: input.title,
                head: branch,
                base: project.defaultBranch ?? project.remoteBranch ?? "main",
                ...(input.body !== undefined ? { body: input.body } : {}),
              });
              return { ...pr, branch };
            } finally {
              await dev.dispose();
            }
          },
        });
      },
    );
  }

  /**
   * The project's linked remote and the credentials this host fetches it
   * with, for the control plane's own Git traffic (ADR 0178's mirror). The
   * one place origin credentials are looked up; they never leave the
   * control plane. Null when the project has no linked remote.
   */
  async origin(input: { identity: Identity; projectId: string }): Promise<{
    url: string;
    branch: string;
    credentials?: GitCredentials;
  } | null> {
    const row = await this.projectRow(input.identity, input.projectId);
    if (!row?.remote_url) return null;
    const credentials = await this.credentialsFor({
      identity: input.identity,
      projectId: input.projectId,
      remoteUrl: row.remote_url,
      access: "read",
    });
    return {
      url: row.remote_url,
      branch: row.remote_branch ?? row.default_branch ?? "main",
      ...(credentials ? { credentials } : {}),
    };
  }

  private async credentialsFor(args: {
    identity: Identity;
    projectId: string;
    remoteUrl: string;
    access: "read" | "write";
  }) {
    try {
      return await this.codeHosts.gitCredentials(args);
    } catch (cause) {
      // A connection that cannot mint credentials (expired, revoked) must
      // not kill the sync: unauthenticated access may still work for public
      // remotes, and the failure surfaces on the push if it matters.
      console.warn(
        `Code host credentials unavailable for ${args.projectId}:`,
        cause,
      );
      return undefined;
    }
  }

  /** Record (or clear) since when main diverged from the code host's. */
  private async markDiverged(input: {
    identity: Identity;
    projectId: string;
    diverged: boolean;
  }): Promise<void> {
    await this.db
      .updateTable("projects")
      .set({ remote_diverged_at: input.diverged ? new Date() : null })
      .where("id", "=", input.projectId)
      .where("tenant_id", "=", input.identity.tenantId)
      .where("remote_diverged_at", input.diverged ? "is" : "is not", null)
      .execute();
  }

  private projectRow(identity: Identity, projectId: string) {
    return this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select([
        "remote_url",
        "remote_branch",
        "remote_ownership",
        "default_branch",
      ])
      .executeTakeFirst();
  }
}

function validLocalBranch(ref: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock")
  );
}

/**
 * `work/<title-slug>-YYYYMMDD-HHmm-<suffix>`: readable on the host, and
 * distinct across days and for pull requests opened in the same minute.
 */
export function prBranchName(
  title: string,
  now: Date,
  suffix: string = randomBytes(3).toString("hex"),
): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "change";
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `${MANAGED_BRANCH_PREFIX}${slug}-${day}-${time}-${suffix}`;
}
