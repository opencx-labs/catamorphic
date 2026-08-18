import type { DB } from "@catamorphic/db";
import {
  fetchRemote,
  type ProjectManager,
  push,
  pushToRemote,
} from "@catamorphic/git";
import type { Kysely } from "kysely";
import { authorFor, type Identity, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { CodeHost } from "./code-host.js";
import {
  DocumentPathError,
  isStorePath,
  normalizeDocumentPath,
} from "./documents-service.js";
import { ProjectNotFoundError } from "./projects-service.js";

/**
 * Propose a change to the program (ADR 0055): a member who cannot commit
 * — no GitHub access, no builder ref — asks for a doc fix, a new template,
 * a workflow tweak. Their agent (or the HTTP surface) hands us the files;
 * we commit them on a fresh branch from the shared `main`, authored as the
 * member, and open a pull request through the code host on the HOST's
 * credential ("on behalf of <member>"). Admins review as usual. Without a
 * code host the branch still lands on the project origin, where builders
 * see it in the desktop.
 *
 * Only program paths are proposable: `store/…` changes ship directly.
 */
export interface ProposedChange {
  path: string;
  /** New content; omit with `delete: true` to remove the file. */
  content?: string;
  delete?: boolean;
}

export interface ProposalResult {
  branch: string;
  /** Present when a code host opened a pull request. */
  pullRequest?: { url: string; number: number };
}

export interface ProposeInput {
  identity: Identity;
  projectId: string;
  title: string;
  body?: string;
  changes: readonly ProposedChange[];
}

/** The working copy proposals are built in — one per project, never a member's. */
const PROPOSALS_WORKER = "catamorphic-proposals";

export class ProposalsUnsupportedError extends Error {
  constructor() {
    super(
      "Proposals need a shared origin: this host keeps projects as plain folders, so there is no branch to propose onto",
    );
    this.name = "ProposalsUnsupportedError";
  }
}

export class ProposalsService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly hosts: readonly CodeHost[],
    /**
     * The identity whose code-host connection opens pull requests for
     * members (the organisation's bot). Absent = branches only.
     */
    private readonly botIdentity?: Identity,
  ) {}

  async propose(input: ProposeInput): Promise<ProposalResult> {
    const { identity, projectId } = input;
    if (!mayPropose(identity, projectId)) throw new AccessDeniedError();
    // The worker copy is only dedicated on backends that keep per-user
    // working copies; on a pathResolver backend (the desktop) openDev
    // resolves to the user's own folder, which we must never reset.
    if (!this.projectManager.remoteBackend)
      throw new ProposalsUnsupportedError();
    const project = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select(["id", "remote_url", "remote_branch"])
      .executeTakeFirst();
    if (!project) throw new ProjectNotFoundError(projectId);
    const title = input.title.trim();
    if (!title) throw new DocumentPathError("A proposal needs a title");
    if (input.changes.length === 0) {
      throw new DocumentPathError("A proposal needs at least one change");
    }
    const changes = input.changes.map((change) => {
      const path = normalizeDocumentPath(change.path);
      if (isStorePath(path)) {
        throw new DocumentPathError(
          `${path} is in the store; write it directly instead of proposing`,
        );
      }
      if (!change.delete && typeof change.content !== "string") {
        throw new DocumentPathError(`${path}: content is required`);
      }
      return { ...change, path };
    });

    // One proposal at a time per project: they share a working copy.
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(() =>
      this.build({ ...input, title, changes, project }),
    );
    this.queues.set(
      projectId,
      run.catch(() => {}),
    );
    return run;
  }

  private async build(args: {
    identity: Identity;
    projectId: string;
    title: string;
    body?: string;
    changes: ProposedChange[];
    project: { remote_url: string | null; remote_branch: string | null };
  }): Promise<ProposalResult> {
    const { identity, projectId, title } = args;
    const remote = this.projectManager.remoteBackend;
    const baseBranch = args.project.remote_branch ?? "main";
    const branch = proposalBranch(title, identity.externalUserId, new Date());
    const dev = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      PROPOSALS_WORKER,
    );
    try {
      // Start from the program as shared: origin main (the internal origin,
      // kept converged with the code host by remote sync).
      if (!remote) throw new ProposalsUnsupportedError();
      await fetchRemote({
        dev,
        remote,
        tenantId: identity.tenantId,
        projectId,
        remoteBranch: "main",
      });
      const base = await dev
        .resolveRef("refs/remotes/origin/main")
        .catch(() => "HEAD");
      await dev.resetWorkingTree();
      await dev.createBranch(branch, base);
      for (const change of args.changes) {
        if (change.delete) {
          await dev.deleteFile(change.path).catch(() => {});
        } else {
          await dev.writeFile(change.path, change.content ?? "");
        }
      }
      const message = [
        title,
        "",
        args.body?.trim() ?? "",
        "",
        `Proposed by ${identity.externalUserId} via Catamorphic.`,
      ]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      await dev.commit(message, authorFor(identity.externalUserId));

      // Land the branch: on the linked code host when the bot can, else on
      // the project origin.
      const remoteUrl = args.project.remote_url;
      const host =
        remoteUrl && this.botIdentity
          ? this.hosts.find((h) => h.handles(remoteUrl))
          : undefined;
      let pullRequest: ProposalResult["pullRequest"];
      if (remoteUrl && host && this.botIdentity) {
        const credentials = await host.credentials(this.botIdentity);
        await pushToRemote({
          repoPath: dev.repoPath,
          url: remoteUrl,
          credentials,
          ref: branch,
          remoteBranch: branch,
        });
        if (host.createPullRequest) {
          pullRequest = await host.createPullRequest(this.botIdentity, {
            remoteUrl,
            title,
            head: branch,
            base: baseBranch,
            body: [
              `Proposed by **${identity.externalUserId}** via Catamorphic.`,
              "",
              args.body?.trim() ?? "",
            ]
              .join("\n")
              .trim(),
          });
        }
      } else {
        await push({
          dev,
          remote,
          tenantId: identity.tenantId,
          projectId,
          remoteBranch: branch,
          localSha: await dev.resolveRef(branch),
        });
      }
      return pullRequest ? { branch, pullRequest } : { branch };
    } finally {
      // Leave the worker copy on main for the next proposal.
      await dev.checkout("main").catch(() => {});
      await dev.dispose();
    }
  }
}

/** Anyone who uses the project may propose: builders and members alike. */
export const mayPropose = mayUseProject;

/** `proposals/<user>/<title-slug>-<yyyymmdd-hhmmss>` */
export function proposalBranch(
  title: string,
  externalUserId: string,
  now: Date,
): string {
  const slug = (value: string, max: number) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
    now.getUTCDate(),
  )}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `proposals/${slug(externalUserId, 24) || "member"}/${
    slug(title, 40) || "change"
  }-${stamp}`;
}
