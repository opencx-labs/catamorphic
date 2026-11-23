import type { Json } from "@catamorphic/db";
import {
  isManagedBranch,
  nativeGit,
  type PushedBranch,
  pushOwnBranch,
  RemotePushRefusedError,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { MANAGED_BRANCH_PREFIX } from "@catamorphic/workflow/project-layout";
import { type Identity, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import {
  type CodeHostPrincipal,
  type CodeHostsService,
  CodeHostUnsupportedError,
  ProjectHasNoRemoteError,
} from "./code-hosts-service.js";
import { remoteOwnership } from "./projects-service.js";
import { defaultBranchOf } from "./remote-sync-service.js";
import {
  type ChatPullRequest,
  pullRequestNote,
} from "./sessions/pull-request-tool.js";

const tracer = getTracer("@catamorphic/core");

/**
 * The project has no repository a pull request could be opened in: none
 * linked, or one no code host serves.
 */
export class PullRequestUnavailableError extends Error {
  constructor() {
    super(
      "This project is not connected to a repository, so there is nowhere to open a pull request. The branch is saved with this chat.",
    );
    this.name = "PullRequestUnavailableError";
  }
}

/** A checkout whose branch has nothing a pull request could show. */
export class NothingToProposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToProposeError";
  }
}

/** A checkout a pull request is opened from. */
export interface PullRequestCheckout {
  /** A repository on this machine holding the commit. */
  repoPath: string;
  /** The commit to push: the tip of the chat's branch. */
  commit: string;
  /** The branch's local name. */
  branch: string;
}

export interface OpenPullRequestInput {
  identity: Identity;
  projectId: string;
  title: string;
  body?: string;
  checkout: PullRequestCheckout;
  /**
   * What tells this checkout's branch from another's of the same name:
   * a chat's id. Left out, the branch's own name must be under `work/`.
   */
  sessionId?: string;
  /** What this chat last pushed, when it pushed before. */
  pushed?: PushedBranch;
  /**
   * The ref the work started from. A branch of the repository becomes the
   * pull request's base; anything else leaves the default branch.
   */
  base?: string;
  /** Whose connection acts: the caller's own or the service's. */
  principal: CodeHostPrincipal;
  /** Keep this chat's lease as soon as Git has accepted the push. */
  remember?: (pushed: PushedBranch) => Promise<void>;
}

export interface OpenedPullRequest {
  url: string;
  number: number;
  /** The branch in the repository. */
  branch: string;
  /** The commit it now holds. */
  commit: string;
  base: string;
  /** False when the pull request was already open and the branch moved. */
  created: boolean;
  /** What happened to the branch. */
  push: "created" | "updated" | "replaced" | "unchanged";
}

/**
 * Pull requests from a checkout (ADR 0345): the one way work leaves a chat
 * for the project's repository. The control plane pushes the checkout's
 * branch as the chat's own `work/` branch, with the caller's connection or
 * the organization's, and opens a pull request for it through the code
 * host, or returns the one already open. A chat replaces only its own
 * branch, and only while the repository still holds what it last pushed.
 */
export class PullRequestsService {
  /** Late-bound: the chats a pull request is recorded on. */
  private chats:
    | {
        record(input: {
          identity: Identity;
          projectId: string;
          sessionId: string;
          pullRequest: { url: string; number: number; title: string };
        }): Promise<void>;
      }
    | undefined;

  constructor(
    private readonly codeHosts: CodeHostsService,
    private readonly deps: {
      /** Records each push beside the gateway's own (ADR 0175). */
      audit?: (event: {
        identity: Identity;
        projectId: string;
        connectionId: string;
        eventType: string;
        outcome: "allowed" | "denied" | "error";
        action: string;
        metadata: Json;
      }) => Promise<void>;
    } = {},
  ) {}

  /** Where an opened pull request is recorded: the chat's own metadata. */
  bindChats(chats: NonNullable<PullRequestsService["chats"]>): void {
    this.chats = chats;
  }

  /**
   * Open or update a chat's pull request (ADR 0345), from the checkout its
   * host found: push its branch, open the pull request, let the host keep
   * what was pushed, and record the pull request on the chat, which the
   * agent no longer does itself. The one function every host's
   * `create_pull_request` runs.
   */
  async openForChat(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    /** The session whose branch this is, when the chat works in another's. */
    workspaceSessionId?: string;
    title: string;
    body?: string;
    checkout: PullRequestCheckout;
    /** Files changed in the checkout and not committed. */
    uncommitted: readonly string[];
    pushed?: PushedBranch;
    base?: string;
    principal: CodeHostPrincipal;
    /** Keep what was pushed where the host keeps it for this chat. */
    remember(pushed: PushedBranch): Promise<void>;
  }): Promise<ChatPullRequest> {
    const opened = await this.open({
      identity: input.identity,
      projectId: input.projectId,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      checkout: input.checkout,
      sessionId: input.workspaceSessionId ?? input.sessionId,
      ...(input.pushed ? { pushed: input.pushed } : {}),
      ...(input.base ? { base: input.base } : {}),
      principal: input.principal,
      remember: input.remember,
    });
    await this.chats?.record({
      identity: input.identity,
      projectId: input.projectId,
      sessionId: input.sessionId,
      pullRequest: {
        url: opened.url,
        number: opened.number,
        title: input.title.trim(),
      },
    });
    return {
      url: opened.url,
      number: opened.number,
      branch: opened.branch,
      commit: opened.commit,
      base: opened.base,
      created: opened.created,
      uncommitted: [...input.uncommitted],
      note: pullRequestNote({
        created: opened.created,
        uncommitted: input.uncommitted,
      }),
    };
  }

  /**
   * The branch a checkout is pushed as: its own name under `work/`, else
   * `work/<name>-<the chat's short id>`.
   */
  remoteBranch(input: { branch: string; sessionId?: string }): string {
    if (isManagedBranch(input.branch)) return input.branch;
    const slug =
      input.branch
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "change";
    if (!input.sessionId)
      throw new RemotePushRefusedError(
        input.branch,
        `Work only pushes branches under '${MANAGED_BRANCH_PREFIX}'.`,
      );
    return `${MANAGED_BRANCH_PREFIX}${slug}-${input.sessionId.replaceAll("-", "").slice(0, 8)}`;
  }

  async open(input: OpenPullRequestInput): Promise<OpenedPullRequest> {
    const { identity, projectId } = input;
    // What proposing a change needs: using the project. The code host's
    // connection, not `program:write`, decides what reaches the repository.
    if (!mayUseProject(identity, projectId)) throw new AccessDeniedError();
    const title = input.title.trim();
    if (!title) throw new Error("A pull request needs a title");
    return withSpan(
      {
        tracer,
        name: "project.pull_request.open",
        attributes: {
          "catamorphic.tenant.id": identity.tenantId,
          "user.id": identity.externalUserId,
          "catamorphic.project.id": projectId,
          ...(input.sessionId
            ? { "catamorphic.agent.session.id": input.sessionId }
            : {}),
        },
      },
      async (span) => {
        try {
          const opened = await this.openThroughCodeHost({ ...input, title });
          span.setAttribute("catamorphic.git.ref", opened.branch);
          span.setAttribute("catamorphic.git.push", opened.push);
          return opened;
        } catch (error) {
          if (
            error instanceof ProjectHasNoRemoteError ||
            error instanceof CodeHostUnsupportedError
          )
            throw new PullRequestUnavailableError();
          throw error;
        }
      },
    );
  }

  private openThroughCodeHost(
    input: OpenPullRequestInput,
  ): Promise<OpenedPullRequest> {
    const { identity, projectId, checkout } = input;
    return this.codeHosts.withOrigin({
      identity,
      projectId,
      principal: input.principal,
      capability: "opening pull requests",
      use: async ({ host, provider, credential, remoteUrl, project }) => {
        if (!host.createPullRequest || !provider.git)
          throw new CodeHostUnsupportedError(
            remoteUrl,
            "opening pull requests",
          );
        const branch = this.remoteBranch({
          branch: checkout.branch,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        const minted = await provider.git.credentials({
          material: credential.material,
          remoteUrl,
          access: "write",
        });
        const credentials = {
          username: minted.username,
          password: minted.password,
        };
        const base = await this.baseBranch({
          repoPath: checkout.repoPath,
          remoteUrl,
          credentials,
          asked: input.base,
          fallback: defaultBranchOf(project),
          head: branch,
        });
        // Recorded as a push through the gateway is: who, which branch,
        // which commit, and whether the repository took it.
        const audit = (
          result: "allowed" | "denied" | "error",
          detail: Record<string, string>,
        ) =>
          this.deps
            .audit?.({
              identity,
              projectId,
              connectionId: credential.connection.id,
              eventType: "connection.git",
              outcome: result,
              action: "push",
              metadata: {
                actor: identity.externalUserId,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                input: {
                  refs: [{ ref: `refs/heads/${branch}`, new: checkout.commit }],
                },
                ...detail,
              },
            })
            .catch((error: unknown) =>
              console.warn("[catamorphic] Could not audit a push", error),
            );
        const { outcome, recordOwnership } = await pushOwnBranch({
          repoPath: checkout.repoPath,
          url: remoteUrl,
          credentials,
          ownership: remoteOwnership(project.remoteOwnership) ?? "attached",
          commit: checkout.commit,
          remoteBranch: branch,
          ...(input.pushed ? { pushed: input.pushed } : {}),
        }).catch(async (error: unknown) => {
          await audit(
            error instanceof RemotePushRefusedError ? "denied" : "error",
            { reason: error instanceof Error ? error.message : String(error) },
          );
          throw error;
        });
        await audit("allowed", { push: outcome });
        if (recordOwnership)
          await input.remember?.({ branch, commit: checkout.commit });
        const call = { credential, remoteUrl };
        // The branch's open pull request is this chat's: a second call
        // moved the branch, and returns the same pull request.
        const open = async () =>
          outcome === "created"
            ? undefined
            : (await host.listPullRequests?.(call))?.find(
                (pull) => pull.head === branch,
              );
        const existing = await open();
        const pull =
          existing ??
          (await host.createPullRequest({
            ...call,
            title: input.title,
            head: branch,
            base,
            ...(input.body !== undefined ? { body: input.body } : {}),
          }));
        return {
          url: pull.url,
          number: pull.number,
          branch,
          commit: checkout.commit,
          base: existing?.base ?? base,
          created: !existing,
          push: outcome,
        };
      },
    });
  }

  /**
   * The pull request's base: the ref the work started from when it is a
   * branch of the repository (never the pushed branch itself), else the
   * project's default branch.
   */
  private async baseBranch(input: {
    repoPath: string;
    remoteUrl: string;
    credentials: { username: string; password: string };
    asked: string | undefined;
    fallback: string;
    head: string;
  }): Promise<string> {
    const asked = input.asked?.replace(/^refs\/heads\//, "");
    if (
      !asked ||
      asked === input.head ||
      asked.startsWith("refs/") ||
      /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(asked) ||
      /[\s:+~^?*[\\]|^-|\.\./.test(asked)
    )
      return input.fallback;
    const listed = await nativeGit(
      input.repoPath,
      ["ls-remote", input.remoteUrl, `refs/heads/${asked}`],
      { ...input.credentials, url: input.remoteUrl },
    ).catch(() => "");
    return listed.trim() ? asked : input.fallback;
  }
}
