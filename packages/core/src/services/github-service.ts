import type { DB, JsonObject } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { fetchRemote, pushToRemote } from "@catamorphic/git";
import type {
  FetchLike,
  GithubAppConfig,
  GithubRepo,
  GithubTokenSet,
  GithubTokenStore,
} from "@catamorphic/github";
import {
  exchangeCode,
  GithubApi,
  gitCredentialsFor,
  isGithubRemoteUrl,
  isTokenStale,
  refreshAccessToken,
  repoFullNameFromUrl,
} from "@catamorphic/github";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type { CodeHost } from "./code-host.js";
import type { ProjectEventsService } from "./project-events-service.js";
import type { ProjectsService } from "./projects-service.js";

export interface GithubServiceConfig {
  app: GithubAppConfig;
  /**
   * Host-owned connection persistence. Token custody follows the same rule
   * as identity: the host owns auth, so catamorphic's schema never holds
   * credentials.
   */
  tokenStore: GithubTokenStore;
  fetch?: FetchLike;
}

export type GithubConnectionStatus =
  | { connected: false }
  | { connected: true; login: string };

export interface ImportGithubRepoInput {
  /** e.g. `octocat/hello-world` */
  fullName: string;
  /** Project name; defaults to the repo name. */
  name?: string;
  /** Explicit working-copy directory (library-direct hosts only). */
  rootPath?: string;
}

export class GithubNotConnectedError extends Error {
  constructor() {
    super("No GitHub connection for this user — connect GitHub first");
    this.name = "GithubNotConnectedError";
  }
}

export class GithubTokenExpiredError extends Error {
  constructor() {
    super("The GitHub connection has expired — reconnect GitHub");
    this.name = "GithubTokenExpiredError";
  }
}

export class ProjectNotLinkedToGithubError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' is not linked to a GitHub repository`);
    this.name = "ProjectNotLinkedToGithubError";
  }
}

/**
 * Per-user GitHub App connections: token refresh, repo listing,
 * import-as-project, and push-back. Both OAuth *acquisition* and token
 * *persistence* deliberately live outside — hosts obtain a `GithubTokenSet`
 * however fits their surface (device flow in a desktop app, web flow
 * callback on a server), hand it to {@link connect}, and supply the
 * {@link GithubTokenStore} it is kept in.
 */
export class GithubService {
  private readonly store: GithubTokenStore;
  private readonly fetch: FetchLike | undefined;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly projects: ProjectsService,
    private readonly config: GithubServiceConfig,
    private readonly projectEvents?: ProjectEventsService,
  ) {
    this.store = config.tokenStore;
    this.fetch = config.fetch;
  }

  async status(identity: Identity): Promise<GithubConnectionStatus> {
    const connection = await this.store.get(
      identity.tenantId,
      identity.externalUserId,
    );
    if (!connection) return { connected: false };
    return { connected: true, login: connection.githubLogin };
  }

  /**
   * GitHub as a {@link CodeHost} (ADR 0044) — the shape generic machinery
   * (remote sync, PR creation) consumes without knowing it is GitHub.
   */
  get codeHost(): CodeHost {
    return {
      id: "github",
      handles: (remoteUrl) => isGithubRemoteUrl(remoteUrl),
      credentials: async (identity) => {
        try {
          return gitCredentialsFor(await this.freshToken(identity));
        } catch {
          // Not connected / expired: sync proceeds unauthenticated; the
          // failure surfaces on the operation that actually needed auth.
          return undefined;
        }
      },
      createPullRequest: async (identity, input) => {
        const fullName = repoFullNameFromUrl(input.remoteUrl);
        if (!fullName) {
          throw new Error(`Not a GitHub remote: ${input.remoteUrl}`);
        }
        const api = new GithubApi(await this.freshToken(identity), {
          fetch: this.fetch,
        });
        return api.createPullRequest(fullName, {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        });
      },
      listPullRequests: async (identity, input) => {
        const fullName = repoFullNameFromUrl(input.remoteUrl);
        if (!fullName) {
          throw new Error(`Not a GitHub remote: ${input.remoteUrl}`);
        }
        const api = new GithubApi(await this.freshToken(identity), {
          fetch: this.fetch,
        });
        return api.listPullRequests(fullName);
      },
      pullRequestFiles: async (identity, input) => {
        const fullName = repoFullNameFromUrl(input.remoteUrl);
        if (!fullName) {
          throw new Error(`Not a GitHub remote: ${input.remoteUrl}`);
        }
        const api = new GithubApi(await this.freshToken(identity), {
          fetch: this.fetch,
        });
        return api.pullRequestFiles(fullName, input.number);
      },
    };
  }

  /**
   * Store (or replace) the user's connection from a freshly-minted token set.
   * Fetches the GitHub user so the stored login always matches the token.
   */
  async connect(
    identity: Identity,
    tokens: GithubTokenSet,
  ): Promise<GithubConnectionStatus> {
    const api = new GithubApi(tokens.accessToken, { fetch: this.fetch });
    const user = await api.getUser();
    await this.store.set(identity.tenantId, identity.externalUserId, {
      tokens,
      githubLogin: user.login,
      githubUserId: user.id,
    });
    return { connected: true, login: user.login };
  }

  /**
   * Validate a host-supplied credential against the exact repository before
   * replacing the user's stored connection. Desktop hosts use this for a
   * `gh` CLI credential without creating a second GitHub API path.
   */
  async connectForRepository(
    identity: Identity,
    tokens: GithubTokenSet,
    fullName: string,
  ): Promise<{
    connection: Extract<GithubConnectionStatus, { connected: true }>;
    repository: GithubRepo;
  }> {
    const api = new GithubApi(tokens.accessToken, { fetch: this.fetch });
    const repository = await api.getRepo(fullName);
    const user = await api.getUser();
    await this.store.set(identity.tenantId, identity.externalUserId, {
      tokens,
      githubLogin: user.login,
      githubUserId: user.id,
    });
    return {
      connection: { connected: true, login: user.login },
      repository,
    };
  }

  /** Verify that the currently stored credential can read one repository. */
  async repository(identity: Identity, fullName: string): Promise<GithubRepo> {
    const api = new GithubApi(await this.freshToken(identity), {
      fetch: this.fetch,
    });
    return api.getRepo(fullName);
  }

  /**
   * Server web-flow completion: exchange the OAuth callback code for tokens
   * and store the connection. Requires the app config to include the client
   * secret.
   */
  async connectWithCode(
    identity: Identity,
    args: { code: string; redirectUri?: string },
  ): Promise<GithubConnectionStatus> {
    const tokens = await exchangeCode(this.config.app, args, {
      fetch: this.fetch,
    });
    return this.connect(identity, tokens);
  }

  async disconnect(identity: Identity): Promise<void> {
    await this.store.delete(identity.tenantId, identity.externalUserId);
  }

  async listRepos(identity: Identity): Promise<GithubRepo[]> {
    const token = await this.freshToken(identity);
    const api = new GithubApi(token, { fetch: this.fetch });
    return api.listAccessibleRepos();
  }

  /** Poll connected-user repository activity into the durable project log. */
  async pollProjectEvents(
    identity: Identity,
    projectId: string,
    input: { afterExternalId?: string } = {},
  ): Promise<{ nextCursor: string | null; appended: number }> {
    if (!this.projectEvents) {
      throw new Error("Project events are not configured");
    }
    const project = await this.db
      .selectFrom("projects")
      .select("remote_url")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .executeTakeFirst();
    if (!project?.remote_url) {
      throw new ProjectNotLinkedToGithubError(projectId);
    }
    const fullName = repoFullNameFromUrl(project.remote_url);
    if (!fullName) throw new ProjectNotLinkedToGithubError(projectId);
    const api = new GithubApi(await this.freshToken(identity), {
      fetch: this.fetch,
    });
    const observed = await api.listRepositoryWatchEvents(fullName);
    const cursorIndex = input.afterExternalId
      ? observed.findIndex((event) => event.id === input.afterExternalId)
      : -1;
    const unseen = input.afterExternalId
      ? cursorIndex >= 0
        ? observed.slice(0, cursorIndex)
        : observed
      : observed;
    let appended = 0;
    // GitHub returns newest first; append oldest first for intuitive replay.
    for (const event of [...unseen].reverse()) {
      const result = await this.projectEvents.append({
        projectId,
        source: "github",
        kind: githubEventKind(event.type),
        externalId: event.id,
        occurredAt: event.createdAt,
        payload: JSON.parse(
          JSON.stringify({
            repository: fullName,
            eventType: event.type,
            actor: event.actor,
            payload: event.payload,
          }),
        ),
      });
      if (result.created) appended += 1;
    }
    return {
      nextCursor: observed[0]?.id ?? input.afterExternalId ?? null,
      appended,
    };
  }

  /**
   * Append a GitHub webhook after the embedding host verifies its signature
   * and resolves the repository to a tenant/project. Transport and secret
   * custody stay host-owned; webhook and polling payloads share one log.
   */
  async ingestWebhook(
    identity: Identity,
    projectId: string,
    input: {
      deliveryId: string;
      eventName: string;
      payload: JsonObject;
      occurredAt?: string;
    },
  ) {
    if (!this.projectEvents)
      throw new Error("Project events are not configured");
    const project = await this.db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .executeTakeFirst();
    if (!project) throw new ProjectNotLinkedToGithubError(projectId);
    return this.projectEvents.append({
      projectId,
      source: "github",
      kind: githubEventKind(input.eventName),
      externalId: input.deliveryId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      payload: input.payload,
    });
  }

  /**
   * Clone a GitHub repo into a new catamorphic project. The repo's history
   * lands on the project's `main`; the GitHub remote + branch are recorded on
   * the project row so {@link pushProject} can push back later.
   */
  async importRepo(identity: Identity, input: ImportGithubRepoInput) {
    const token = await this.freshToken(identity);
    const api = new GithubApi(token, { fetch: this.fetch });
    const repo = await api.getRepo(input.fullName);

    const project = await this.projects.create(identity, {
      name: input.name ?? repo.name,
      rootPath: input.rootPath,
      cloneFrom: {
        url: repo.cloneUrl,
        credentials: gitCredentialsFor(token),
        branch: repo.defaultBranch,
      },
    });

    await this.db
      .updateTable("projects")
      .set({
        remote_url: repo.cloneUrl,
        remote_branch: repo.defaultBranch,
        updated_at: new Date(),
      })
      .where("id", "=", project.id)
      .execute();

    return { ...project, remoteUrl: repo.cloneUrl };
  }

  /**
   * Push the project's canonical `main` (the internal origin, not the
   * caller's possibly-stale working copy) to the linked GitHub repository.
   */
  async pushProject(identity: Identity, projectId: string): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select(["remote_url", "remote_branch"])
      .executeTakeFirst();
    if (!row?.remote_url) throw new ProjectNotLinkedToGithubError(projectId);

    const token = await this.freshToken(identity);
    const dev = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      const remote = this.projectManager.remoteBackend;
      let ref = "main";
      if (remote) {
        const fetched = await fetchRemote({
          dev,
          remote,
          tenantId: identity.tenantId,
          projectId,
          remoteBranch: "main",
        });
        if (fetched.sha) ref = "refs/remotes/origin/main";
      }
      await pushToRemote({
        repoPath: dev.repoPath,
        url: row.remote_url,
        credentials: gitCredentialsFor(token),
        ref,
        remoteBranch: row.remote_branch ?? "main",
      });
    } finally {
      await dev.dispose();
    }
  }

  /** Access token from the store, refreshed and re-persisted when stale. */
  private async freshToken(identity: Identity): Promise<string> {
    const connection = await this.store.get(
      identity.tenantId,
      identity.externalUserId,
    );
    if (!connection) throw new GithubNotConnectedError();

    if (!isTokenStale(connection.tokens)) {
      return connection.tokens.accessToken;
    }

    if (!connection.tokens.refreshToken) throw new GithubTokenExpiredError();
    let tokens: GithubTokenSet;
    try {
      tokens = await refreshAccessToken(
        this.config.app,
        connection.tokens.refreshToken,
        { fetch: this.fetch },
      );
    } catch {
      throw new GithubTokenExpiredError();
    }

    await this.store.set(identity.tenantId, identity.externalUserId, {
      ...connection,
      tokens,
    });

    return tokens.accessToken;
  }
}

export function githubEventKind(eventType: string): string {
  const name = eventType
    .replace(/Event$/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return `github.${name || "event"}`;
}
