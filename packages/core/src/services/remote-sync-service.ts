import type { DB } from "@catamorphic/db";
import {
  fetchFromRemote,
  type GitCredentials,
  type NetworkSyncResult,
  OriginDraftRepo,
  type ProjectManager,
  PushNotFastForwardError,
  push,
  syncWithNetworkRemote,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import { hasProjectPermission, type Identity } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { CodeHostsService } from "./code-hosts-service.js";
import { remoteOwnership } from "./projects-service.js";

const tracer = getTracer("@catamorphic/core");

const SYNC_AUTHOR = { name: "Work", email: "system@work.software" };

/**
 * A member's server draft (ADR 0191) has no checkout to sync: its
 * published program syncs with the linked repository by itself, and
 * changes reach that repository as pull requests.
 */
export class ServerDraftError extends Error {
  constructor() {
    super(
      "This project's drafts live on its server. Publish your draft, or propose the change as a pull request.",
    );
    this.name = "ServerDraftError";
  }
}

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
    /**
     * Told when a sync published commits the code host accepted (ADR
     * 0330), so following enablements move to them.
     */
    private readonly onPublished?: (input: {
      projectId: string;
      commitSha: string;
    }) => Promise<void>,
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
          await this.onPublished?.({ projectId, commitSha: remoteSha }).catch(
            (error: unknown) =>
              console.warn(
                `[catamorphic] Could not record project ${projectId}'s published revision`,
                error,
              ),
          );
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
        const dev = await this.projectManager.openDraft({
          tenantId: identity.tenantId,
          projectId,
          externalUserId: identity.externalUserId,
        });
        try {
          if (dev instanceof OriginDraftRepo) throw new ServerDraftError();
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
      branch: defaultBranchOf({
        defaultBranch: row.default_branch,
        remoteBranch: row.remote_branch,
      }),
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

/**
 * The branch of a project's linked repository that work starts from and
 * pull requests target: the repository's default branch, else the branch
 * the project tracks.
 */
export function defaultBranchOf(project: {
  defaultBranch: string | null;
  remoteBranch: string | null;
}): string {
  return project.defaultBranch ?? project.remoteBranch ?? "main";
}
