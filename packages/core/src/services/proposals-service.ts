import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import {
  isPersonalFile,
  type ProjectManager,
  push,
  pushToRemote,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { MANAGED_BRANCH_PREFIX } from "@catamorphic/workflow/project-layout";
import type { Kysely } from "kysely";
import { authorFor, type Identity, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type {
  CodeHost,
  CodeHostCredential,
  PullRequestFile,
  PullRequestSummary,
} from "./code-host.js";
import {
  CodeHostNotConnectedError,
  type CodeHostsService,
  CodeHostUnsupportedError,
  ProjectHasNoRemoteError,
} from "./code-hosts-service.js";
import {
  DocumentPathError,
  documentAccessAllowed,
  isStorePath,
  normalizeDocumentPath,
} from "./documents-service.js";
import { isProjectDataPath } from "./project-workspace.js";
import { ProjectNotFoundError, remoteOwnership } from "./projects-service.js";

/**
 * Propose a change to the program (ADR 0055): a member who cannot commit
 * — no code-host access, no `program:write` — asks for a doc fix, a new template,
 * a workflow tweak. Their agent (or the HTTP surface) hands us the files;
 * we commit them on a fresh branch from the shared `main`, authored as the
 * member, and open a pull request through the code host with the
 * organization's service connection ("on behalf of <member>", ADR 0177).
 * Admins review as usual. Without a service connection for the origin the
 * branch still lands on the project origin, where program writers see it in
 * the desktop.
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

const tracer = getTracer("@catamorphic/core");

export class ProposalsUnsupportedError extends Error {
  constructor() {
    super(
      "Proposals need a shared origin: this host keeps projects as plain folders, so there is no branch to propose onto",
    );
    this.name = "ProposalsUnsupportedError";
  }
}

export class ProposalsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly codeHosts: CodeHostsService,
  ) {}

  /** Read proposals through the company identity, narrowed to member documents. */
  async list(input: {
    identity: Identity;
    projectId: string;
  }): Promise<PullRequestSummary[]> {
    const proposals =
      (await this.viaService(input, async ({ host, call }) =>
        ((await host.listPullRequests?.(call)) ?? []).filter((item) =>
          item.head.startsWith(PROPOSAL_BRANCH_PREFIX),
        ),
      )) ?? [];
    const visible: PullRequestSummary[] = [];
    for (const proposal of proposals) {
      const files = await this.viaService(input, async ({ host, call }) =>
        host.pullRequestFiles?.({ ...call, number: proposal.number }),
      );
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
    const result = await this.viaService(input, async ({ host, call }) => {
      const readSummary = async () =>
        host.pullRequest
          ? host.pullRequest({ ...call, number: input.number })
          : (await host.listPullRequests?.(call))?.find(
              (item) => item.number === input.number,
            );
      const proposal = await readSummary();
      if (!proposal?.head.startsWith(PROPOSAL_BRANCH_PREFIX))
        throw new AccessDeniedError();
      const files = await host.pullRequestFiles?.({
        ...call,
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
    });
    if (!result) throw new ProposalsUnsupportedError();
    return result;
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
    const discussion = await this.viaService(input, async ({ host, call }) =>
      host.pullRequestDiscussion?.({ ...call, number: input.number }),
    );
    if (!discussion) throw new ProposalsUnsupportedError();
    return discussion;
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
    if (input.replyTo) {
      const discussion = await this.discussion(input);
      if (
        !discussion.inlineComments.some(
          (comment) => comment.id === input.replyTo,
        )
      )
        throw new AccessDeniedError();
    }
    const comment = await this.viaService(input, async ({ host, call }) =>
      host.commentOnPullRequest?.({
        ...call,
        number: input.number,
        body: `${input.body.trim()}\n\n_On behalf of ${input.identity.externalUserId} via Work._`,
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      }),
    );
    if (!comment) throw new ProposalsUnsupportedError();
    return comment;
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

  /**
   * Run against the origin with the organization's service connection;
   * null when the project has no origin, no code host serves it, or no
   * service connection is ready.
   */
  private async viaService<T>(
    input: { identity: Identity; projectId: string },
    use: (source: {
      host: CodeHost;
      call: { credential: CodeHostCredential; remoteUrl: string };
    }) => Promise<T>,
  ): Promise<T | null> {
    if (!mayPropose(input.identity, input.projectId))
      throw new AccessDeniedError();
    const project = await this.db
      .selectFrom("projects")
      .where("id", "=", input.projectId)
      .where("tenant_id", "=", input.identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!project) throw new ProjectNotFoundError(input.projectId);
    try {
      return await this.codeHosts.withOrigin({
        identity: input.identity,
        projectId: input.projectId,
        principal: "service",
        use: ({ host, credential, remoteUrl }) =>
          use({ host, call: { credential, remoteUrl } }),
      });
    } catch (error) {
      if (
        error instanceof ProjectHasNoRemoteError ||
        error instanceof CodeHostUnsupportedError ||
        error instanceof CodeHostNotConnectedError
      )
        return null;
      throw error;
    }
  }

  async propose(input: ProposeInput): Promise<ProposalResult> {
    const { identity, projectId } = input;
    if (!mayPropose(identity, projectId)) throw new AccessDeniedError();
    // Proposals are built in an ephemeral checkout of the shared origin.
    if (!this.projectManager.remoteBackend)
      throw new ProposalsUnsupportedError();
    const project = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select(["id", "remote_url", "remote_branch", "remote_ownership"])
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

    return withSpan(
      {
        tracer,
        name: "project.propose",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.tenant.id": identity.tenantId,
        },
      },
      () => this.build({ ...input, title, changes, project }),
    );
  }

  private async build(args: {
    identity: Identity;
    projectId: string;
    title: string;
    body?: string;
    changes: ProposedChange[];
    project: {
      remote_url: string | null;
      remote_branch: string | null;
      remote_ownership: string | null;
    };
  }): Promise<ProposalResult> {
    const { identity, projectId, title } = args;
    const remote = this.projectManager.remoteBackend;
    const baseBranch = args.project.remote_branch ?? "main";
    const branch = `${proposalBranch(title, identity.externalUserId, new Date())}-${randomUUID().slice(0, 8)}`;
    if (!remote) throw new ProposalsUnsupportedError();
    // Each proposal is built in its own ephemeral checkout of the program
    // as shared: origin main (the internal origin, kept converged with the
    // code host by remote sync).
    const dev = await this.projectManager.openEphemeral({
      tenantId: identity.tenantId,
      projectId,
    });
    try {
      await dev.createBranch(branch);
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
        `Proposed by ${identity.externalUserId} via Work.`,
      ]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      await dev.commit(message, authorFor(identity.externalUserId));

      // Land the branch: on the linked code host when the organization's
      // service connection can, else on the project origin.
      const body = [
        `Proposed by **${identity.externalUserId}** via Work.`,
        "",
        args.body?.trim() ?? "",
      ]
        .join("\n")
        .trim();
      const landed = args.project.remote_url
        ? await this.viaService(
            { identity, projectId },
            async ({ host, call }) => {
              await pushToRemote({
                repoPath: dev.repoPath,
                url: call.remoteUrl,
                credentials: await this.codeHosts.gitCredentials({
                  identity,
                  projectId,
                  remoteUrl: call.remoteUrl,
                  access: "write",
                  principal: "service",
                }),
                ownership:
                  remoteOwnership(args.project.remote_ownership) ?? "attached",
                ref: branch,
                remoteBranch: branch,
              });
              return {
                pullRequest: host.createPullRequest
                  ? await host.createPullRequest({
                      ...call,
                      title,
                      head: branch,
                      base: baseBranch,
                      body,
                    })
                  : undefined,
              };
            },
          )
        : null;
      const pullRequest = landed?.pullRequest;
      if (!landed) {
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
      await dev.dispose();
    }
  }
}

/** Anyone who uses the project may propose, whatever they hold. */
export const mayPropose = mayUseProject;

/** Proposals are branches Work creates, so attached repositories accept them. */
export const PROPOSAL_BRANCH_PREFIX = `${MANAGED_BRANCH_PREFIX}proposals/`;

/** `work/proposals/<user>/<title-slug>-<yyyymmdd-hhmmss>` */
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
  return `${PROPOSAL_BRANCH_PREFIX}${slug(externalUserId, 24) || "member"}/${
    slug(title, 40) || "change"
  }-${stamp}`;
}
