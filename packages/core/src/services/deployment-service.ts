import {
  fetchRemote,
  OriginDraftRepo,
  type ProjectDraft,
  type ProjectManager,
  type ProjectRepo,
  refreshPublished,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { publishedRef } from "@catamorphic/workflow/project-layout";
import { authorFor } from "../identity.js";

const tracer = getTracer("@catamorphic/core");

const REMOTE_BRANCH = "main";

/**
 * The project's state blocks the request (unrecorded local changes, a local
 * checkout that syncs through its own remote): the person must act first.
 */
export class DeploymentBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentBlockedError";
  }
}

export interface DeployOptions {
  message?: string;
  /**
   * Publish exactly these files as one commit on top of the published
   * program, leaving the member's draft untouched (a member's local copy
   * of a server project publishing its files).
   */
  files?: Record<string, string>;
  /**
   * The published commit `files` were edited from. Files changed on the
   * server since then merge with them, or come back as conflicts instead
   * of being overwritten.
   */
  base?: string;
  /**
   * Checks every path the publish would change against the live program
   * and throws to refuse it. Runs before anything is published.
   */
  guardPublishedPaths?: (paths: readonly string[]) => void;
}

/**
 * A member's program draft and its publication (ADR 0191). A server-hosted
 * project's draft is a ref in its origin, so every call works on any
 * replica; a project in a local folder is its own draft and publishes the
 * commit the person recorded. Stateless: every call opens the draft anew.
 */
export class DeploymentService {
  constructor(
    private readonly projectManager: ProjectManager,
    /** Told about every published revision (enablements offer the update). */
    private readonly onPublished?: (input: {
      projectId: string;
      commitSha: string;
    }) => Promise<void>,
  ) {}

  private async withDraft<T>(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    fn: (draft: ProjectDraft) => Promise<T>,
  ): Promise<T> {
    const draft = await this.projectManager.openDraft({
      tenantId,
      projectId,
      externalUserId,
    });
    try {
      return await fn(draft);
    } finally {
      await draft.dispose();
    }
  }

  async getStatus(tenantId: string, projectId: string, externalUserId: string) {
    return this.withDraft(
      tenantId,
      projectId,
      externalUserId,
      async (draft) => {
        await refreshPublished({
          repo: draft,
          remote: requireRemote(this.projectManager),
          tenantId,
          projectId,
          branch: REMOTE_BRANCH,
        }).catch(() => null);
        const status = await draft.status();
        const remoteHeadTimestamp = await tipTimestamp(
          draft,
          status.remoteHead,
        );
        return { ...status, remoteHeadTimestamp };
      },
    );
  }

  async listCommits(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: { ref?: string; maxCount?: number },
  ) {
    return this.withDraft(
      tenantId,
      projectId,
      externalUserId,
      async (draft) => {
        await refreshPublished({
          repo: draft,
          remote: requireRemote(this.projectManager),
          tenantId,
          projectId,
          branch: REMOTE_BRANCH,
        }).catch(() => null);
        const ref = opts?.ref ?? publishedRef(REMOTE_BRANCH);
        return draft.log({ ref, maxCount: opts?.maxCount ?? 50 });
      },
    );
  }

  async workdirDiff(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ) {
    return this.withDraft(tenantId, projectId, externalUserId, (draft) =>
      draft.workdirDiff(),
    );
  }

  async diffRefs(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    base: string,
    head: string,
  ) {
    return this.withDraft(tenantId, projectId, externalUserId, (draft) =>
      draft.diff({ base, head }),
    );
  }

  async filesAtRef(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    ref: string,
  ) {
    return this.withDraft(tenantId, projectId, externalUserId, (draft) =>
      draft.readAllFilesAtRef(ref),
    );
  }

  async deploy(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: DeployOptions,
  ) {
    return withSpan(
      {
        tracer,
        name: "project.deploy",
        attributes: {
          "catamorphic.tenant.id": tenantId,
          "catamorphic.project.id": projectId,
        },
      },
      () => this.deployInner(tenantId, projectId, externalUserId, opts),
    );
  }

  private async deployInner(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: DeployOptions,
  ) {
    const remote = requireRemote(this.projectManager);
    return this.withDraft(
      tenantId,
      projectId,
      externalUserId,
      async (draft) => {
        const author = authorFor(externalUserId);
        const message = opts?.message ?? `Deploy ${new Date().toISOString()}`;
        if (draft instanceof OriginDraftRepo) {
          const result = opts?.files
            ? await this.projectManager.publishFiles({
                tenantId,
                projectId,
                files: opts.files,
                base: opts.base,
                message,
                author,
                guard: opts.guardPublishedPaths,
              })
            : await draft.publish({
                message,
                author,
                guard: opts?.guardPublishedPaths,
              });
          if (result.status === "deployed")
            await this.published({
              tenantId,
              projectId,
              commitSha: result.commitSha,
            });
          return result;
        }
        if (opts?.files) {
          throw new DeploymentBlockedError(
            "Save and record these changes in Git before publishing this local project.",
          );
        }
        // A local folder publishes the commit the person recorded; its
        // pending work and branch stay as they are.
        const status = await draft.status();
        if (status.dirty)
          throw new DeploymentBlockedError(
            "Record the changes you want to publish in Git first. Publishing keeps your branch and pending work unchanged.",
          );
        if (!status.baseCommit)
          return {
            status: "nothing-to-deploy" as const,
            commitSha: null,
            remoteSha: null,
            conflicts: [],
          };
        const publishedSha = status.baseCommit;
        if (opts?.guardPublishedPaths) {
          await fetchRemote({
            dev: draft,
            remote,
            tenantId,
            projectId,
            remoteBranch: REMOTE_BRANCH,
          }).catch(() => null);
          const live = await draft
            .resolveRef(publishedRef(REMOTE_BRANCH))
            .catch(() => null);
          opts.guardPublishedPaths(
            live
              ? (await draft.diff({ base: live, head: publishedSha })).map(
                  (entry) => entry.path,
                )
              : Object.keys(await draft.readAllFilesAtRef(publishedSha)),
          );
        }
        await remote.withOrigin(tenantId, projectId, async (origin) => {
          await origin.updateRef({
            ref: "refs/heads/main",
            sha: publishedSha,
            expected: await origin.resolveRef("refs/heads/main"),
          });
        });
        await this.published({ tenantId, projectId, commitSha: publishedSha });
        return {
          status: "deployed" as const,
          commitSha: publishedSha,
          remoteSha: publishedSha,
          conflicts: [],
        };
      },
    );
  }

  private async published(input: {
    tenantId: string;
    projectId: string;
    commitSha: string;
  }): Promise<void> {
    await this.onPublished?.({
      projectId: input.projectId,
      commitSha: input.commitSha,
    }).catch(() => {});
  }

  /**
   * Bring what others published into the member's draft. `files` are first
   * written into the draft.
   */
  async pullFromRemote(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: { files?: Record<string, string> },
  ) {
    return withSpan(
      {
        tracer,
        name: "project.pull_from_remote",
        attributes: {
          "catamorphic.tenant.id": tenantId,
          "catamorphic.project.id": projectId,
        },
      },
      async () =>
        this.withDraft(tenantId, projectId, externalUserId, async (draft) => {
          if (!(draft instanceof OriginDraftRepo))
            throw new DeploymentBlockedError(
              "This project uses its existing Git remote. Use Git sync to download changes; its published snapshot is already available locally.",
            );
          if (opts?.files)
            await draft.write({
              changes: Object.entries(opts.files).map(([path, content]) => ({
                path,
                content,
              })),
            });
          return draft.pull();
        }),
    );
  }

  /**
   * Throw away the member's unpublished changes: a server-hosted draft is
   * deleted and follows the published program again; a local folder's
   * uncommitted changes are reverted.
   */
  async discardDraft(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ) {
    return withSpan(
      {
        tracer,
        name: "project.discard_draft",
        attributes: {
          "catamorphic.tenant.id": tenantId,
          "catamorphic.project.id": projectId,
        },
      },
      async () =>
        this.withDraft(tenantId, projectId, externalUserId, async (draft) => {
          if (draft instanceof OriginDraftRepo) {
            await draft.discard();
            return { discarded: true, branch: REMOTE_BRANCH };
          }
          await draft.resetWorkingTree();
          return { discarded: true, branch: await draft.currentBranch() };
        }),
    );
  }

  /**
   * Record the member's resolutions of a conflicting publish: a server
   * draft merges the published program in with them as one draft commit,
   * a local folder commits them.
   */
  async resolveConflicts(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts: { resolutions: Record<string, string>; message?: string },
  ) {
    return withSpan(
      {
        tracer,
        name: "project.resolve_conflicts",
        attributes: {
          "catamorphic.tenant.id": tenantId,
          "catamorphic.project.id": projectId,
        },
      },
      async () =>
        this.withDraft(tenantId, projectId, externalUserId, async (draft) => {
          const message = opts.message ?? "Resolve merge conflicts";
          if (draft instanceof OriginDraftRepo)
            return {
              commitSha: await draft.resolveConflicts({
                resolutions: opts.resolutions,
                message,
              }),
            };
          for (const [filepath, content] of Object.entries(opts.resolutions))
            await draft.writeFile(filepath, content);
          return {
            commitSha: await draft.commit(message, authorFor(externalUserId)),
          };
        }),
    );
  }
}

function requireRemote(pm: ProjectManager) {
  const remote = pm.remoteBackend;
  if (!remote)
    throw new Error("ProjectManager has no RemoteBackend configured");
  return remote;
}

async function tipTimestamp(
  repo: ProjectRepo | OriginDraftRepo,
  sha: string | null,
): Promise<number | null> {
  if (!sha) return null;
  const commits = await repo.log({ ref: sha, maxCount: 1 }).catch(() => []);
  return commits[0]?.timestamp ?? null;
}
