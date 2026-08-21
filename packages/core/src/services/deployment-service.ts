import {
  fetchRemote,
  generateWorkBranchName,
  type ProjectManager,
  type ProjectRepo,
  PushNotFastForwardError,
  pull,
  push,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { authorFor } from "../identity.js";
import { forgetProgramFetch } from "./program-reader.js";

const tracer = getTracer("@catamorphic/core");

const REMOTE_BRANCH = "main";

/**
 * High-level project-scoped git operations invoked by the HTTP layer. Wraps
 * ProjectRepo / ProjectManager with draft-branch semantics, deploy = commit +
 * push, and AI-assisted pull/merge. Stateless: every call opens its own
 * per-user dev repo.
 */
export class DeploymentService {
  constructor(private readonly projectManager: ProjectManager) {}

  private async withDev<T>(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    fn: (repo: ProjectRepo) => Promise<T>,
  ): Promise<T> {
    const repo = await this.projectManager.openDev(
      tenantId,
      projectId,
      externalUserId,
    );
    try {
      return await fn(repo);
    } finally {
      await repo.dispose();
    }
  }

  async getStatus(tenantId: string, projectId: string, externalUserId: string) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      await fetchRemote({
        dev: repo,
        remote: requireRemote(this.projectManager),
        tenantId,
        projectId,
        remoteBranch: REMOTE_BRANCH,
      }).catch(() => null);

      const status = await repo.status();
      const remoteHeadTimestamp = await tipTimestamp(repo, status.remoteHead);
      return { ...status, remoteHeadTimestamp };
    });
  }

  async listBranches(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, (repo) =>
      repo.listBranches(),
    );
  }

  async listCommits(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: { ref?: string; maxCount?: number },
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      await fetchRemote({
        dev: repo,
        remote: requireRemote(this.projectManager),
        tenantId,
        projectId,
        remoteBranch: REMOTE_BRANCH,
      }).catch(() => null);
      const ref = opts?.ref ?? `refs/remotes/origin/${REMOTE_BRANCH}`;
      return repo.log({ ref, maxCount: opts?.maxCount ?? 50 });
    });
  }

  async workdirDiff(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, (repo) =>
      repo.workdirDiff(),
    );
  }

  async diffRefs(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    base: string,
    head: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, (repo) =>
      repo.diff({ base, head }),
    );
  }

  async filesAtRef(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    ref: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, (repo) =>
      repo.readAllFilesAtRef(ref),
    );
  }

  async ensureWorkBranch(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      const current = await repo.currentBranch();
      if (current !== "main") return { branch: current, created: false };
      const name = await generateWorkBranchName({
        isTaken: (n) => repo.hasBranch(n),
      });
      await repo.createBranch(name);
      return { branch: name, created: true };
    });
  }

  async checkoutBranch(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    branch: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      await repo.checkout(branch);
      return repo.status();
    });
  }

  async deploy(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: { message?: string; files?: Record<string, string> },
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
    opts?: { message?: string; files?: Record<string, string> },
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      if (opts?.files) {
        for (const [path, content] of Object.entries(opts.files)) {
          await repo.writeFile(path, content);
        }
      }
      const status = await repo.status();
      const author = authorFor(externalUserId);

      const currentBranch = status.branch;
      const isMainBranch = currentBranch === "main";

      if (isMainBranch && status.dirty) {
        const name = await generateWorkBranchName({
          isTaken: (n) => repo.hasBranch(n),
        });
        await repo.createBranch(name);
      }

      let commitSha: string | null = status.baseCommit;
      if (status.dirty) {
        commitSha = await repo.commit(
          opts?.message ?? `Deploy ${new Date().toISOString()}`,
          author,
        );
      }

      const remote = requireRemote(this.projectManager);
      await fetchRemote({
        dev: repo,
        remote,
        tenantId,
        projectId,
        remoteBranch: REMOTE_BRANCH,
      }).catch(() => null);
      const remoteSha = await repo
        .resolveRef(`refs/remotes/origin/${REMOTE_BRANCH}`)
        .catch(() => null);

      if (!commitSha) {
        return {
          status: "nothing-to-deploy" as const,
          commitSha: null,
          remoteSha,
          conflicts: [],
        };
      }

      if (!status.dirty && remoteSha === commitSha) {
        return {
          status: "nothing-to-deploy" as const,
          commitSha,
          remoteSha,
          conflicts: [],
        };
      }

      if (remoteSha && remoteSha !== commitSha) {
        const merge = await pull({
          dev: repo,
          remote,
          tenantId,
          projectId,
          remoteBranch: REMOTE_BRANCH,
          author,
        });
        if (merge.status === "conflict") {
          return {
            status: "conflict" as const,
            commitSha,
            remoteSha,
            conflicts: merge.conflicts,
          };
        }
        commitSha = await repo.resolveRef("HEAD");
      }

      const currentBranchAfter = await repo.currentBranch();
      if (currentBranchAfter !== "main") {
        await repo.moveBranch("main", commitSha);
        await repo.checkout("main");
      }

      try {
        const result = await push({
          dev: repo,
          remote,
          tenantId,
          projectId,
          remoteBranch: REMOTE_BRANCH,
          localSha: commitSha,
        });
        // The shared program just moved: readers holding the 5s fetch
        // memo (a pre-deploy existence check, a burst of reads) must not
        // serve the pre-push tree to a role/tool resolution that follows
        // the deploy immediately.
        forgetProgramFetch(tenantId, projectId);
        return {
          status: "deployed" as const,
          commitSha: result.sha,
          remoteSha: result.sha,
          conflicts: [],
        };
      } catch (err) {
        if (err instanceof PushNotFastForwardError) {
          return {
            status: "conflict" as const,
            commitSha,
            remoteSha,
            conflicts: [],
          };
        }
        throw err;
      }
    });
  }

  async pullFromRemote(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts?: { files?: Record<string, string> },
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      if (opts?.files) {
        for (const [path, content] of Object.entries(opts.files)) {
          await repo.writeFile(path, content);
        }
      }
      const author = authorFor(externalUserId);
      return pull({
        dev: repo,
        remote: requireRemote(this.projectManager),
        tenantId,
        projectId,
        remoteBranch: REMOTE_BRANCH,
        author,
      });
    });
  }

  async discardDraft(
    tenantId: string,
    projectId: string,
    externalUserId: string,
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      await repo.resetWorkingTree();
      const branch = await repo.currentBranch();
      if (branch !== "main") {
        await repo.checkout("main");
        await repo.deleteBranch(branch).catch(() => {});
      }
      return { discarded: true, branch };
    });
  }

  async resolveConflicts(
    tenantId: string,
    projectId: string,
    externalUserId: string,
    opts: { resolutions: Record<string, string>; message?: string },
  ) {
    return this.withDev(tenantId, projectId, externalUserId, async (repo) => {
      for (const [filepath, content] of Object.entries(opts.resolutions)) {
        await repo.writeFile(filepath, content);
      }
      const author = authorFor(externalUserId);
      const sha = await repo.commit(
        opts.message ?? "Resolve merge conflicts",
        author,
      );
      return { commitSha: sha };
    });
  }
}

function requireRemote(pm: ProjectManager) {
  const remote = pm.remoteBackend;
  if (!remote)
    throw new Error("ProjectManager has no RemoteBackend configured");
  return remote;
}

async function tipTimestamp(
  repo: ProjectRepo,
  sha: string | null,
): Promise<number | null> {
  if (!sha) return null;
  const commits = await repo.log({ ref: sha, maxCount: 1 }).catch(() => []);
  return commits[0]?.timestamp ?? null;
}
