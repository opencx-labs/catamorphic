import type { DB } from "@catamorphic/db";
import type { GitCredentials, ProjectManager } from "@catamorphic/git";
import { fetchRemote, pushToRemote } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { publishedRef } from "@catamorphic/workflow/project-layout";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { hasProjectPermission } from "../identity.js";
import {
  AccessDeniedError,
  assertProjectPermission,
} from "./artifact-scope.js";
import type {
  CodeHost,
  CodeHostCredential,
  CodeHostRepository,
  PullRequestComment,
  PullRequestDiscussion,
  PullRequestFile,
  PullRequestSummary,
} from "./code-host.js";
import type {
  ConnectionProvider,
  ConnectionProviderRegistry,
} from "./connection-providers.js";
import type { ConnectionRecord } from "./connection-types.js";
import type { ConnectionsService } from "./connections-service.js";
import {
  type Project,
  ProjectNotFoundError,
  type ProjectsService,
} from "./projects-service.js";

/** Project ids are UUIDs; anything else names no project. */
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tracer = getTracer("@catamorphic/core");

/**
 * Whose authority a code-host call uses (ADR 0177): the caller's own
 * connection, the organization's service connection, or the caller's when
 * they have one and the organization's otherwise.
 */
export type CodeHostPrincipal = "member" | "service" | "either";

export class ProjectHasNoRemoteError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' is not linked to a remote repository`);
    this.name = "ProjectHasNoRemoteError";
  }
}

/** No registered code host (or none with this capability) serves the remote. */
export class CodeHostUnsupportedError extends Error {
  constructor(remoteUrl: string, capability = "this operation") {
    super(`No code host supports ${capability} for '${remoteUrl}'`);
    this.name = "CodeHostUnsupportedError";
  }
}

/** Neither the caller nor the organization has a usable connection. */
export class CodeHostNotConnectedError extends Error {
  constructor(readonly provider: string) {
    super(
      `No ${provider} connection is available: connect your ${provider} account, or ask an administrator to connect the '${provider}' service connection`,
    );
    this.name = "CodeHostNotConnectedError";
  }
}

export class ProjectAlreadyLinkedError extends Error {
  constructor(readonly projectId: string) {
    super(
      `Project '${projectId}' is already linked to a repository. Share its changes with a pull request.`,
    );
    this.name = "ProjectAlreadyLinkedError";
  }
}

interface ResolvedHost {
  provider: ConnectionProvider & {
    git: NonNullable<ConnectionProvider["git"]>;
  };
  host: CodeHost | undefined;
}

/**
 * Code hosts over connections (ADRs 0044, 0177). A remote is served by the
 * connection provider whose `git` capability covers its URL; the code host
 * registered for that provider adds pull requests and repositories. Every
 * call acts through one connection: the caller's own (a connection they
 * authorized in the project, else their personal one) or the service
 * connection named like the provider (the project's own first, then the
 * organization's). Credentials are opened for the call and never leave the
 * control plane.
 */
export class CodeHostsService {
  /** Publishes in flight in this process, per project. */
  private readonly publishing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      projectManager: ProjectManager;
      projects: ProjectsService;
      hosts: readonly CodeHost[];
      connections?: ConnectionsService;
      providers?: ConnectionProviderRegistry;
    },
  ) {
    for (const host of deps.hosts) {
      const provider = deps.providers?.get(host.provider);
      if (!provider?.git) {
        throw new Error(
          `Code host '${host.provider}' needs a registered connection provider of that kind that serves Git`,
        );
      }
    }
  }

  /** Whether any code host can act (hosts and connections are configured). */
  get available(): boolean {
    return this.deps.hosts.length > 0 && Boolean(this.deps.connections);
  }

  /** The registered code hosts' providers. */
  list(): Array<{ provider: string; displayName: string }> {
    return this.deps.hosts.map((host) => ({
      provider: host.provider,
      displayName:
        this.deps.providers?.get(host.provider)?.displayName ?? host.provider,
    }));
  }

  /** Git credentials for one remote, or undefined when none apply. */
  async gitCredentials(args: {
    identity: Identity;
    projectId?: string;
    remoteUrl: string;
    access: "read" | "write";
    principal?: CodeHostPrincipal;
  }): Promise<GitCredentials | undefined> {
    const resolved = this.resolve(args.remoteUrl);
    if (!resolved) return undefined;
    const connection = await this.connectionFor({
      identity: args.identity,
      projectId: args.projectId,
      provider: resolved.provider.kind,
      principal: args.principal ?? "either",
    });
    if (!connection) return undefined;
    return this.withCredential({
      identity: args.identity,
      connection,
      use: async (credential) => {
        const minted = await resolved.provider.git.credentials({
          material: credential.material,
          remoteUrl: args.remoteUrl,
          access: args.access,
        });
        return { username: minted.username, password: minted.password };
      },
    });
  }

  /**
   * Run a code-host operation against a project's origin with the
   * connection `principal` selects.
   */
  async withOrigin<T>(args: {
    identity: Identity;
    projectId: string;
    principal: CodeHostPrincipal;
    /** Names the capability in errors. */
    capability?: string;
    use: (input: {
      host: CodeHost;
      provider: ConnectionProvider;
      credential: CodeHostCredential;
      remoteUrl: string;
      project: {
        remoteBranch: string | null;
        defaultBranch: string | null;
        remoteOwnership: string | null;
      };
    }) => Promise<T>;
  }): Promise<T> {
    const project = await this.deps.db
      .selectFrom("projects")
      .where("id", "=", args.projectId)
      .where("tenant_id", "=", args.identity.tenantId)
      .select([
        "remote_url",
        "remote_branch",
        "default_branch",
        "remote_ownership",
      ])
      .executeTakeFirst();
    if (!project) throw new ProjectNotFoundError(args.projectId);
    const remoteUrl = project.remote_url;
    if (!remoteUrl) throw new ProjectHasNoRemoteError(args.projectId);
    const resolved = this.resolve(remoteUrl);
    const host = resolved?.host;
    if (!resolved || !host) {
      throw new CodeHostUnsupportedError(remoteUrl, args.capability);
    }
    const connection = await this.connectionFor({
      identity: args.identity,
      projectId: args.projectId,
      provider: host.provider,
      principal: args.principal,
    });
    if (!connection) throw new CodeHostNotConnectedError(host.provider);
    return this.withCredential({
      identity: args.identity,
      connection,
      use: (credential) =>
        args.use({
          host,
          provider: resolved.provider,
          credential,
          remoteUrl,
          project: {
            remoteBranch: project.remote_branch,
            defaultBranch: project.default_branch,
            remoteOwnership: project.remote_ownership,
          },
        }),
    });
  }

  /** Whether a connection of `principal` can act on the project's origin. */
  async originConnected(args: {
    identity: Identity;
    projectId: string;
    principal: CodeHostPrincipal;
  }): Promise<boolean> {
    // An id that cannot name a project names no connected origin.
    if (!PROJECT_ID.test(args.projectId)) return false;
    const project = await this.deps.db
      .selectFrom("projects")
      .where("id", "=", args.projectId)
      .where("tenant_id", "=", args.identity.tenantId)
      .select("remote_url")
      .executeTakeFirst();
    const host = project?.remote_url
      ? this.resolve(project.remote_url)?.host
      : undefined;
    if (!host) return false;
    return Boolean(
      await this.connectionFor({
        identity: args.identity,
        projectId: args.projectId,
        provider: host.provider,
        principal: args.principal,
      }),
    );
  }

  /** Open pull requests on the origin; `[]` without a host or a connection. */
  async listPullRequests(args: {
    identity: Identity;
    projectId: string;
    principal?: CodeHostPrincipal;
  }): Promise<PullRequestSummary[]> {
    this.assertReads(args);
    return this.span("list_pull_requests", args, async () => {
      try {
        return await this.withOrigin({
          ...args,
          principal: args.principal ?? "either",
          use: async ({ host, credential, remoteUrl }) => {
            if (!host.listPullRequests) return [];
            const [pulls, viewer] = await Promise.all([
              host.listPullRequests({ credential, remoteUrl }),
              host.viewer?.({ credential }).catch(() => undefined),
            ]);
            return viewer
              ? pulls.map((pull) => ({ ...pull, viewerLogin: viewer.login }))
              : pulls;
          },
        });
      } catch (error) {
        if (
          error instanceof ProjectHasNoRemoteError ||
          error instanceof CodeHostUnsupportedError ||
          error instanceof CodeHostNotConnectedError
        )
          return [];
        throw error;
      }
    });
  }

  async pullRequest(args: {
    identity: Identity;
    projectId: string;
    number: number;
    principal?: CodeHostPrincipal;
  }): Promise<PullRequestSummary> {
    this.assertReads(args);
    return this.operate(args, "pull_request", (call, host) =>
      required(
        host.pullRequest?.bind(host),
        "reading pull requests",
        call.remoteUrl,
      )({
        ...call,
        number: args.number,
      }),
    );
  }

  async pullRequestFiles(args: {
    identity: Identity;
    projectId: string;
    number: number;
    principal?: CodeHostPrincipal;
  }): Promise<PullRequestFile[]> {
    this.assertReads(args);
    return this.operate(args, "pull_request_files", (call, host) =>
      required(
        host.pullRequestFiles?.bind(host),
        "reading pull request files",
        call.remoteUrl,
      )({ ...call, number: args.number }),
    );
  }

  async pullRequestDiscussion(args: {
    identity: Identity;
    projectId: string;
    number: number;
    principal?: CodeHostPrincipal;
  }): Promise<PullRequestDiscussion> {
    this.assertReads(args);
    return this.operate(args, "pull_request_discussion", (call, host) =>
      required(
        host.pullRequestDiscussion?.bind(host),
        "reading pull request discussions",
        call.remoteUrl,
      )({ ...call, number: args.number }),
    );
  }

  /**
   * Comment on a pull request. A reader comments only as themselves, with
   * their own connection; speaking through the organization's connection
   * takes `program:write`.
   */
  async commentOnPullRequest(args: {
    identity: Identity;
    projectId: string;
    number: number;
    body: string;
    replyTo?: number;
    principal?: CodeHostPrincipal;
  }): Promise<PullRequestComment> {
    this.assertReads(args);
    const writes = hasProjectPermission(
      args.identity,
      args.projectId,
      "program:write",
    );
    if (!writes && args.principal === "service") throw new AccessDeniedError();
    const member: CodeHostPrincipal = "member";
    const scoped = writes ? args : { ...args, principal: member };
    return this.operate(scoped, "comment_on_pull_request", (call, host) =>
      required(
        host.commentOnPullRequest?.bind(host),
        "commenting on pull requests",
        call.remoteUrl,
      )({
        ...call,
        number: args.number,
        body: args.body,
        ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
      }),
    );
  }

  /** Approve or request changes; needs `program:publish`. */
  async reviewPullRequest(args: {
    identity: Identity;
    projectId: string;
    number: number;
    headSha: string;
    decision: "approve" | "request_changes";
    body?: string;
    principal?: CodeHostPrincipal;
  }): Promise<void> {
    assertProjectPermission(args.identity, args.projectId, "program:publish");
    return this.operate(args, "review_pull_request", (call, host) =>
      required(
        host.reviewPullRequest?.bind(host),
        "reviewing pull requests",
        call.remoteUrl,
      )({
        ...call,
        number: args.number,
        headSha: args.headSha,
        decision: args.decision,
        ...(args.body !== undefined ? { body: args.body } : {}),
      }),
    );
  }

  /** Merge the reviewed head; needs `program:publish`. */
  async mergePullRequest(args: {
    identity: Identity;
    projectId: string;
    number: number;
    headSha: string;
    principal?: CodeHostPrincipal;
  }): Promise<void> {
    assertProjectPermission(args.identity, args.projectId, "program:publish");
    return this.operate(args, "merge_pull_request", (call, host) =>
      required(
        host.mergePullRequest?.bind(host),
        "merging pull requests",
        call.remoteUrl,
      )({ ...call, number: args.number, headSha: args.headSha }),
    );
  }

  /** The caller's personal connection to a code host's provider. */
  async personalConnection(args: {
    identity: Identity;
    provider: string;
  }): Promise<ConnectionRecord | undefined> {
    this.requireHost(args.provider);
    return this.requireConnections().personal({
      identity: args.identity,
      providerKind: args.provider,
    });
  }

  /** Repositories the caller's personal connection reaches. */
  async listRepositories(args: {
    identity: Identity;
    provider: string;
  }): Promise<CodeHostRepository[]> {
    const host = this.requireHost(args.provider);
    const listRepositories = required(
      host.listRepositories?.bind(host),
      "listing repositories",
      args.provider,
    );
    const connection = await this.connectionFor({
      identity: args.identity,
      provider: args.provider,
      principal: "member",
    });
    if (!connection) throw new CodeHostNotConnectedError(args.provider);
    return this.withCredential({
      identity: args.identity,
      connection,
      use: (credential) => listRepositories({ credential }),
    });
  }

  /** Read one repository with the caller's own or the service connection. */
  async repository(args: {
    identity: Identity;
    provider: string;
    fullName: string;
    principal?: CodeHostPrincipal;
  }): Promise<CodeHostRepository> {
    const host = this.requireHost(args.provider);
    const read = required(
      host.repository?.bind(host),
      "reading repositories",
      args.provider,
    );
    const connection = await this.connectionFor({
      identity: args.identity,
      provider: args.provider,
      principal: args.principal ?? "member",
    });
    if (!connection) throw new CodeHostNotConnectedError(args.provider);
    return this.withCredential({
      identity: args.identity,
      connection,
      use: (credential) => read({ credential, fullName: args.fullName }),
    });
  }

  /**
   * Clone a repository into a new project. The repository's history lands
   * on the project's `main`, and it is linked as an attached remote (ADR
   * 0170): sync fetches from it, and Work's changes reach it only as
   * `work/*` branches and pull requests.
   */
  async importRepository(args: {
    identity: Identity;
    provider: string;
    fullName: string;
    /** Host-reserved local registration id. */
    id?: string;
    /** Project name; defaults to the repository name. */
    name?: string;
    /** Explicit working-copy directory (library-direct hosts only). */
    rootPath?: string;
    /** Default `member`; a Work server provisions through `service`. */
    principal?: CodeHostPrincipal;
  }): Promise<Project> {
    return withSpan(
      {
        tracer,
        name: "code_host.import_repository",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.connection.provider": args.provider,
        },
      },
      async () => {
        const host = this.requireHost(args.provider);
        const read = required(
          host.repository?.bind(host),
          "reading repositories",
          args.provider,
        );
        const provider = this.requireProvider(args.provider);
        const connection = await this.connectionFor({
          identity: args.identity,
          provider: args.provider,
          principal: args.principal ?? "member",
        });
        if (!connection) throw new CodeHostNotConnectedError(args.provider);
        const { repository, credentials } = await this.withCredential({
          identity: args.identity,
          connection,
          use: async (credential) => {
            const repository = await read({
              credential,
              fullName: args.fullName,
            });
            const minted = await provider.git.credentials({
              material: credential.material,
              remoteUrl: repository.cloneUrl,
              access: "read",
            });
            return {
              repository,
              credentials: {
                username: minted.username,
                password: minted.password,
              },
            };
          },
        });
        const project = await this.deps.projects.create(args.identity, {
          ...(args.id ? { id: args.id } : {}),
          name: args.name ?? repository.name,
          ...(args.rootPath ? { rootPath: args.rootPath } : {}),
          cloneFrom: {
            url: repository.cloneUrl,
            credentials,
            branch: repository.defaultBranch,
          },
        });
        await this.deps.db
          .updateTable("projects")
          .set({
            remote_url: repository.cloneUrl,
            remote_branch: repository.defaultBranch,
            default_branch: repository.defaultBranch,
            remote_ownership: "attached",
            updated_at: new Date(),
          })
          .where("id", "=", project.id)
          .execute();
        return {
          ...project,
          remoteUrl: repository.cloneUrl,
          remoteOwnership: "attached",
          defaultBranch: repository.defaultBranch,
        };
      },
    );
  }

  /**
   * Publish a project with no remote to a new repository: create it with
   * the caller's personal connection, link it as owned (ADR 0170), and push
   * the project's canonical `main`. Remote sync keeps it converged from then
   * on. A project already linked is refused.
   */
  async publishProject(args: {
    identity: Identity;
    projectId: string;
    provider: string;
    name: string;
    /** Organization; the connected account when omitted. */
    organization?: string;
    /** Defaults to private. */
    visibility?: "private" | "public";
  }): Promise<{ fullName: string; remoteUrl: string }> {
    assertProjectPermission(args.identity, args.projectId, "program:publish");
    // One publish per project at a time here, so a repeated request finds
    // the project linked instead of creating a second repository.
    const previous = this.publishing.get(args.projectId);
    const run = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.publishProjectOnce(args));
    this.publishing.set(args.projectId, run);
    const forget = () => {
      if (this.publishing.get(args.projectId) === run)
        this.publishing.delete(args.projectId);
    };
    void run.then(forget, forget);
    return run;
  }

  private publishProjectOnce(args: {
    identity: Identity;
    projectId: string;
    provider: string;
    name: string;
    organization?: string;
    visibility?: "private" | "public";
  }): Promise<{ fullName: string; remoteUrl: string }> {
    const { identity, projectId } = args;
    return withSpan(
      {
        tracer,
        name: "code_host.publish_project",
        attributes: {
          "catamorphic.tenant.id": identity.tenantId,
          "user.id": identity.externalUserId,
          "catamorphic.project.id": projectId,
          "catamorphic.connection.provider": args.provider,
        },
      },
      async () => {
        const row = await this.deps.db
          .selectFrom("projects")
          .where("id", "=", projectId)
          .where("tenant_id", "=", identity.tenantId)
          .select(["remote_url"])
          .executeTakeFirst();
        if (!row) throw new ProjectNotFoundError(projectId);
        if (row.remote_url) throw new ProjectAlreadyLinkedError(projectId);
        const host = this.requireHost(args.provider);
        const create = required(
          host.createRepository?.bind(host),
          "creating repositories",
          args.provider,
        );
        const provider = this.requireProvider(args.provider);
        const connection = await this.connectionFor({
          identity,
          provider: args.provider,
          principal: "member",
        });
        if (!connection) throw new CodeHostNotConnectedError(args.provider);
        const { repository, credentials } = await this.withCredential({
          identity,
          connection,
          use: async (credential) => {
            const repository = await create({
              credential,
              name: args.name,
              ...(args.organization ? { organization: args.organization } : {}),
              private: (args.visibility ?? "private") === "private",
            });
            const minted = await provider.git.credentials({
              material: credential.material,
              remoteUrl: repository.cloneUrl,
              access: "write",
            });
            return {
              repository,
              credentials: {
                username: minted.username,
                password: minted.password,
              },
            };
          },
        });
        // Link before pushing: Work created this repository, so a failed
        // first push is completed by the next sync. Only an unlinked project
        // is linked: a publish that raced this one (another replica) keeps
        // its repository.
        const linked = await this.deps.db
          .updateTable("projects")
          .set({
            remote_url: repository.cloneUrl,
            remote_branch: repository.defaultBranch,
            default_branch: repository.defaultBranch,
            remote_ownership: "owned",
            updated_at: new Date(),
          })
          .where("id", "=", projectId)
          .where("tenant_id", "=", identity.tenantId)
          .where("remote_url", "is", null)
          .executeTakeFirst();
        if (!linked.numUpdatedRows)
          throw new ProjectAlreadyLinkedError(projectId);
        const manager = this.deps.projectManager;
        const dev = await manager.openDev(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        try {
          const remote = manager.remoteBackend;
          const local = Boolean(
            await manager.localPath({ tenantId: identity.tenantId, projectId }),
          );
          const published =
            remote && !local
              ? (
                  await fetchRemote({
                    dev,
                    remote,
                    tenantId: identity.tenantId,
                    projectId,
                    remoteBranch: "main",
                  })
                ).sha
              : null;
          await pushToRemote({
            repoPath: dev.repoPath,
            native: local,
            url: repository.cloneUrl,
            credentials,
            ownership: "owned",
            ref: local ? "HEAD" : published ? publishedRef() : "main",
            remoteBranch: repository.defaultBranch,
          });
        } finally {
          await dev.dispose();
        }
        return {
          fullName: repository.fullName,
          remoteUrl: repository.cloneUrl,
        };
      },
    );
  }

  /** The provider (and code host) whose Git remotes cover the URL. */
  private resolve(remoteUrl: string): ResolvedHost | undefined {
    const url = remoteUrl.trim();
    for (const provider of this.deps.providers?.list() ?? []) {
      const git = provider.git;
      if (!git?.remoteBaseUrls.some((base) => url.startsWith(base))) continue;
      return {
        provider: { ...provider, git },
        host: this.deps.hosts.find((host) => host.provider === provider.kind),
      };
    }
    return undefined;
  }

  private async connectionFor(args: {
    identity: Identity;
    projectId?: string;
    provider: string;
    principal: CodeHostPrincipal;
  }): Promise<ConnectionRecord | undefined> {
    const connections = this.deps.connections;
    if (!connections) return undefined;
    const member =
      args.principal === "service"
        ? undefined
        : await connections.ownConnection({
            identity: args.identity,
            providerKind: args.provider,
            ...(args.projectId ? { projectId: args.projectId } : {}),
          });
    if (member || args.principal === "member") return member;
    const service = await connections.serviceConnection({
      tenantId: args.identity.tenantId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      name: args.provider,
    });
    return service?.status === "ready" && service.providerKind === args.provider
      ? service
      : undefined;
  }

  private async withCredential<T>(args: {
    identity: Identity;
    connection: ConnectionRecord;
    use: (credential: CodeHostCredential) => Promise<T>;
  }): Promise<T> {
    const connections = this.requireConnections();
    await connections.refreshIfNeeded({
      identity: args.identity,
      connectionId: args.connection.id,
    });
    return connections.withCredential({
      identity: args.identity,
      connectionId: args.connection.id,
      use: (material, row) =>
        args.use({
          connection: { id: row.id, revision: row.revision },
          principalKind: args.connection.principalKind,
          account: row.account_summary,
          material,
        }),
    });
  }

  private operate<T>(
    args: {
      identity: Identity;
      projectId: string;
      principal?: CodeHostPrincipal;
    },
    operation: string,
    run: (
      call: { credential: CodeHostCredential; remoteUrl: string },
      host: CodeHost,
    ) => Promise<T>,
  ): Promise<T> {
    return this.span(operation, args, () =>
      this.withOrigin({
        identity: args.identity,
        projectId: args.projectId,
        principal: args.principal ?? "either",
        use: ({ host, credential, remoteUrl }) =>
          run({ credential, remoteUrl }, host),
      }),
    );
  }

  private span<T>(
    operation: string,
    args: { identity: Identity; projectId: string },
    run: () => Promise<T>,
  ): Promise<T> {
    return withSpan(
      {
        tracer,
        name: `code_host.${operation}`,
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.project.id": args.projectId,
        },
      },
      run,
    );
  }

  /** Reading the origin's pull requests is reading the program. */
  private assertReads(args: { identity: Identity; projectId: string }): void {
    if (!hasProjectPermission(args.identity, args.projectId, "program:read"))
      throw new AccessDeniedError();
  }

  private requireHost(provider: string): CodeHost {
    const host = this.deps.hosts.find((item) => item.provider === provider);
    if (!host || !this.deps.connections) {
      throw new CodeHostUnsupportedError(provider);
    }
    return host;
  }

  private requireProvider(kind: string): ResolvedHost["provider"] {
    const provider = this.deps.providers?.get(kind);
    const git = provider?.git;
    if (!provider || !git) throw new CodeHostUnsupportedError(kind);
    return { ...provider, git };
  }

  private requireConnections(): ConnectionsService {
    if (!this.deps.connections) {
      throw new Error("Connections are not configured");
    }
    return this.deps.connections;
  }
}

function required<T>(
  capability: T | undefined,
  name: string,
  subject: string,
): T {
  if (!capability) throw new CodeHostUnsupportedError(subject, name);
  return capability;
}
