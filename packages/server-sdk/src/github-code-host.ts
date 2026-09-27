import type {
  CodeHost,
  CodeHostCredential,
  CodeHostRepository,
} from "@catamorphic/core";
import {
  GithubApi,
  type GithubPermissions,
  type GithubRepo,
} from "@catamorphic/github";
import type { GithubConnectionProvider } from "./github-connection-provider.js";

/**
 * GitHub as a code host over the `github` connection provider (ADR 0177):
 * pull requests and repositories for remotes under the provider's web
 * origin. Every call uses a token for the connection core hands it: the
 * person's own (attributed to them) or the organization's App installation,
 * narrowed to the repository and the permissions the call needs.
 */
export function githubCodeHost(provider: GithubConnectionProvider): CodeHost {
  const api = async (args: {
    credential: CodeHostCredential;
    remoteUrl?: string;
    fullName?: string;
    permissions?: GithubPermissions;
  }) => {
    const repository = args.remoteUrl
      ? provider.repositoryOf(args.remoteUrl)
      : args.fullName
        ? repositoryFromFullName(args.fullName)
        : undefined;
    const token = await provider.accessToken({
      material: args.credential.material,
      ...(repository ? { repository } : {}),
      ...(args.permissions ? { permissions: args.permissions } : {}),
    });
    return {
      client: new GithubApi(token, {
        fetch: provider.api.fetch,
        baseUrl: provider.api.baseUrl,
      }),
      fullName: repository ? `${repository.owner}/${repository.name}` : "",
    };
  };
  const read: GithubPermissions = { pull_requests: "read" };

  return {
    provider: provider.kind,

    createPullRequest: async ({ credential, remoteUrl, ...input }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: { pull_requests: "write", contents: "read" },
      });
      return client.createPullRequest(fullName, input);
    },

    listPullRequests: async ({ credential, remoteUrl }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: read,
      });
      return client.listPullRequests(fullName);
    },

    pullRequest: async ({ credential, remoteUrl, number }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: read,
      });
      return client.pullRequest({ fullName, number });
    },

    pullRequestDiscussion: async ({ credential, remoteUrl, number }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        // Reviews, comments, and checks: whatever the installation may read.
      });
      return client.pullRequestDiscussion({ fullName, number });
    },

    commentOnPullRequest: async ({ credential, remoteUrl, ...input }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: { pull_requests: "write", issues: "write" },
      });
      return client.commentOnPullRequest({ fullName, ...input });
    },

    pullRequestFiles: async ({ credential, remoteUrl, number }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: read,
      });
      return client.pullRequestFiles(fullName, number);
    },

    reviewPullRequest: async ({ credential, remoteUrl, ...input }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: { pull_requests: "write" },
      });
      await client.reviewPullRequest({
        fullName,
        number: input.number,
        headSha: input.headSha,
        decision: input.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        body: input.body ?? "",
      });
    },

    mergePullRequest: async ({ credential, remoteUrl, number, headSha }) => {
      const { client, fullName } = await api({
        credential,
        remoteUrl,
        permissions: { pull_requests: "write", contents: "write" },
      });
      await client.mergePullRequest({ fullName, number, headSha });
    },

    viewer: async ({ credential }) => {
      const account = credential.account;
      if (
        account &&
        typeof account === "object" &&
        !Array.isArray(account) &&
        account.type === "user" &&
        typeof account.login === "string"
      )
        return { login: account.login };
      throw new Error("A GitHub App installation has no viewer");
    },

    listRepositories: async ({ credential }) => {
      const { client } = await api({ credential });
      const repositories =
        credential.principalKind === "member"
          ? await client.listAccessibleRepos()
          : await client.listInstallationRepos();
      return repositories.map(repositoryOf);
    },

    repository: async ({ credential, fullName }) => {
      const { client } = await api({
        credential,
        fullName,
        permissions: { metadata: "read" },
      });
      return repositoryOf(await client.getRepo(fullName));
    },

    createRepository: async ({ credential, name, organization, ...rest }) => {
      const { client } = await api({ credential });
      return repositoryOf(
        await client.createRepo({
          name,
          ...(organization ? { organization } : {}),
          private: rest.private,
        }),
      );
    },
  };
}

function repositoryFromFullName(fullName: string): {
  owner: string;
  name: string;
} {
  const [owner, name, ...rest] = fullName.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner, name };
}

function repositoryOf(repo: GithubRepo): CodeHostRepository {
  return {
    fullName: repo.fullName,
    name: repo.name,
    owner: repo.owner,
    private: repo.private,
    defaultBranch: repo.defaultBranch,
    cloneUrl: repo.cloneUrl,
    description: repo.description,
    pushedAt: repo.pushedAt,
  };
}
