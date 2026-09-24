import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import {
  fetchRemote,
  isPersonalFile,
  type ProjectManager,
  push,
  pushToRemote,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import { authorFor, type Identity, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type {
  CodeHost,
  PullRequestFile,
  PullRequestSummary,
} from "./code-host.js";
import {
  DocumentPathError,
  documentAccessAllowed,
  isStorePath,
  normalizeDocumentPath,
} from "./documents-service.js";
import { isProjectDataPath } from "./project-workspace.js";
import { ProjectNotFoundError } from "./projects-service.js";

/**
 * Propose a change to the program (ADR 0055): a member who cannot commit
 * — no GitHub access, no `program:write` — asks for a doc fix, a new template,
 * a workflow tweak. Their agent (or the HTTP surface) hands us the files;
 * we commit them on a fresh branch from the shared `main`, authored as the
 * member, and open a pull request through the code host on the HOST's
 * credential ("on behalf of <member>"). Admins review as usual. Without a
 * code host the branch still lands on the project origin, where program
 * writers see it in the desktop.
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
const tracer = getTracer("@catamorphic/core");

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

  /** Read proposals through the company identity, narrowed to member documents. */
  async list(input: {
    identity: Identity;
    projectId: string;
  }): Promise<PullRequestSummary[]> {
    const source = await this.proposalSource(input);
    if (!source) return [];
    const proposals = (
      (await source.host.listPullRequests?.(source.identity, {
        remoteUrl: source.remoteUrl,
      })) ?? []
    ).filter((item) => item.head.startsWith("proposals/"));
    const visible: PullRequestSummary[] = [];
    for (const proposal of proposals) {
      const files = await source.host.pullRequestFiles?.(source.identity, {
        remoteUrl: source.remoteUrl,
        number: proposal.number,
      });
      if (
        files?.length &&
        files.every((file) => this.canReadProposalFile(input, file))
      )
        visible.push(proposal);
    }
    return visible;
  }

  /** An authorized snapshot also remains readable after a proposal is applied. */
  async read(input: {
    identity: Identity;
    projectId: string;
    number: number;
  }): Promise<{ proposal: PullRequestSummary; files: PullRequestFile[] }> {
    const source = await this.proposalSource(input);
    if (!source) throw new ProposalsUnsupportedError();
    const readSummary = async () =>
      source.host.pullRequest
        ? source.host.pullRequest(source.identity, {
            remoteUrl: source.remoteUrl,
            number: input.number,
          })
        : (
            await source.host.listPullRequests?.(source.identity, {
              remoteUrl: source.remoteUrl,
            })
          )?.find((item) => item.number === input.number);
    const proposal = await readSummary();
    if (!proposal?.head.startsWith("proposals/")) throw new AccessDeniedError();
    const files = await source.host.pullRequestFiles?.(source.identity, {
      remoteUrl: source.remoteUrl,
      number: input.number,
    });
    if (!files?.every((file) => this.canReadProposalFile(input, file)))
      throw new AccessDeniedError();
    const after = await readSummary();
    if (!after || proposal.headSha !== after.headSha)
      throw new DocumentPathError(
        "This proposal changed while loading. Refresh to review the latest version.",
      );
    return { proposal: after, files };
  }

  async files(input: {
    identity: Identity;
    projectId: string;
    number: number;
  }): Promise<PullRequestFile[]> {
    return (await this.read(input)).files;
  }

  async discussion(input: {
    identity: Identity;
    projectId: string;
    number: number;
  }) {
    await this.files(input);
    const source = await this.proposalSource(input);
    if (!source?.host.pullRequestDiscussion)
      throw new ProposalsUnsupportedError();
    return source.host.pullRequestDiscussion(source.identity, {
      remoteUrl: source.remoteUrl,
      number: input.number,
    });
  }

  async comment(input: {
    identity: Identity;
    projectId: string;
    number: number;
    body: string;
    replyTo?: number;
  }) {
    if (!input.body.trim() || input.body.length > 60000)
      throw new DocumentPathError(
        "Write a comment of at most 60,000 characters",
      );
    await this.files(input);
    const source = await this.proposalSource(input);
    if (!source?.host.commentOnPullRequest)
      throw new ProposalsUnsupportedError();
    if (input.replyTo) {
      const discussion = await this.discussion(input);
      if (
        !discussion.inlineComments.some(
          (comment) => comment.id === input.replyTo,
        )
      )
        throw new AccessDeniedError();
    }
    return source.host.commentOnPullRequest(source.identity, {
      remoteUrl: source.remoteUrl,
      number: input.number,
      body: `${input.body.trim()}\n\n_On behalf of ${input.identity.externalUserId} via Catamorphic._`,
      replyTo: input.replyTo,
    });
  }

  private canReadProposalFile(
    input: { identity: Identity; projectId: string },
    file: PullRequestFile,
  ): boolean {
    return [file.path, ...(file.previousPath ? [file.previousPath] : [])].every(
      (path) =>
        !isPersonalFile(path) &&
        !isProjectDataPath(path) &&
        documentAccessAllowed(input.identity, input.projectId, path, "read"),
    );
  }

  private async proposalSource(input: {
    identity: Identity;
    projectId: string;
  }) {
    if (!mayPropose(input.identity, input.projectId))
      throw new AccessDeniedError();
    const project = await this.db
      .selectFrom("projects")
      .where("id", "=", input.projectId)
      .where("tenant_id", "=", input.identity.tenantId)
      .select("remote_url")
      .executeTakeFirst();
    if (!project) throw new ProjectNotFoundError(input.projectId);
    const remoteUrl = project.remote_url;
    const identity = this.botIdentity;
    const host =
      remoteUrl && identity
        ? this.hosts.find((host) => host.handles(remoteUrl))
        : undefined;
    return host && remoteUrl && identity ? { host, remoteUrl, identity } : null;
  }

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
      if (isPersonalFile(path))
        throw new DocumentPathError(
          "Personal files stay on this device. Choose a project location before proposing them.",
        );
      if (isStorePath(path) || isProjectDataPath(path)) {
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
      withSpan(
        {
          tracer,
          name: "project.propose",
          attributes: {
            "catamorphic.project.id": projectId,
            "catamorphic.tenant.id": identity.tenantId,
          },
        },
        () => this.build({ ...input, title, changes, project }),
      ),
    );
    const settled = run
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(projectId) === settled)
          this.queues.delete(projectId);
      });
    this.queues.set(projectId, settled);
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
    const branch = `${proposalBranch(title, identity.externalUserId, new Date())}-${randomUUID().slice(0, 8)}`;
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
        .resolveRef("refs/catamorphic/published/main")
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

/** Anyone who uses the project may propose, whatever they hold. */
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
