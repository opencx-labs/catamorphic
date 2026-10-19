import { createHash } from "node:crypto";
import {
  type ConnectionActionDefinition,
  ConnectionActionRefusedError,
  ConnectionAuthorizationExpiredError,
  type ConnectionAuthorizationResult,
  type ConnectionGitRemotes,
  type ConnectionProvider,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import {
  buildAuthorizeUrl,
  exchangeCode,
  type FetchLike,
  type GithubActor,
  GithubApi,
  GithubApiError,
  GithubAppAuth,
  type GithubAppConfig,
  GithubAuthError,
  type GithubInstallation,
  type GithubPermissions,
  type GithubRestMethod,
  type GithubTokenSet,
  githubRestRequest,
  githubRestUrl,
  isTokenStale,
  parseGithubAppPrivateKey,
  pollDeviceToken,
  refreshAccessToken,
  repositoryFromRestPath,
  requestDeviceCode,
  revokeUserToken,
} from "@catamorphic/github";
import { getTracer, withSpan } from "@catamorphic/otel";
import { z } from "zod";

const tracer = getTracer("@catamorphic/server-sdk");

const NAME = /^[\w.-]+$/;
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

export interface GithubConnectionOptions {
  /** Provider kind; default `github`. */
  kind?: string;
  /** Default `GitHub`. */
  displayName?: string;
  /** REST API base. GitHub Enterprise Server: `https://HOST/api/v3`. */
  apiBaseUrl?: string;
  /** Web origin for OAuth and Git remotes. Default `https://github.com`. */
  webBaseUrl?: string;
  /**
   * The GitHub App's OAuth client, for member connections (user-to-server
   * tokens, attributed to the person). With a client secret members use the
   * web flow; without one, the device flow. Omit to accept only App
   * installation (service) connections.
   */
  oauth?: GithubAppConfig;
  /**
   * REST path prefixes outside `/repos/{owner}/{name}` that callers may
   * reach, e.g. `/user`. Default none: GraphQL, search, and organization
   * endpoints reach beyond the binding's repositories.
   */
  unscopedRestPaths?: readonly string[];
  /** Largest REST response slice returned to callers. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Longest pull request patch returned per file. Default 20,000 chars. */
  maxPatchChars?: number;
  timeoutMs?: number;
  /** How long completing a device authorization keeps polling. Default 60s. */
  devicePollTimeoutMs?: number;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type GithubConnectionProvider = ConnectionProvider & {
  readonly git: ConnectionGitRemotes;
  /**
   * Check GitHub App credentials and encode them as service connection
   * material. Names the installation directly or finds it from the account
   * (user or organization) the app is installed on.
   */
  authorizeApp(args: {
    appId: string;
    privateKey: string;
    installationId?: number;
    owner?: string;
  }): Promise<ConnectionAuthorizationResult>;
  /**
   * Check a user access token set the host obtained itself (the `gh` CLI's
   * token, a device flow it ran) and encode it as member material.
   */
  authorizeUser(args: {
    tokens: GithubTokenSet;
  }): Promise<ConnectionAuthorizationResult>;
  /**
   * A token for one call on the control plane (the code host, a host's
   * event poller): minted and narrowed for an App, stored for a member.
   * Never hand it to an agent or a sandbox.
   */
  accessToken(args: {
    material: Uint8Array;
    repository?: { owner: string; name: string };
    permissions?: GithubPermissions;
  }): Promise<string>;
  /** `owner` and `name` of a remote under this provider's web origin. */
  repositoryOf(remoteUrl: string): { owner: string; name: string };
  /** REST client settings for calls with {@link accessToken}. */
  readonly api: { baseUrl: string; webBaseUrl: string; fetch: FetchLike };
};

const Repository = z
  .string()
  .regex(FULL_NAME)
  .describe("Repository as owner/name");
const Number_ = z.number().int().positive();
const Side = z.enum(["LEFT", "RIGHT"]);
/** GitHub's limit on a description, comment, or review body. */
const MAX_BODY = 65_536;
const Body = z.string().min(1).max(MAX_BODY);
const NodeId = z.string().regex(/^[\w+/=-]{1,200}$/);
/** Items one call may change: each is checked before any is changed. */
const MAX_ITEMS = 20;
/** Reviews one call may dismiss: a pull request's own change requests. */
const MAX_DISMISSALS = 100;
/**
 * A marker that makes a write happen once: when this connection already
 * posted one carrying it, that one is returned and nothing is posted, so a
 * retried or redelivered call repeats nothing.
 */
const Stamp = z
  .string()
  .min(4)
  .max(200)
  .describe(
    "Posts once: an item of this connection's already carrying this marker is returned instead",
  );
const CheckRunFields = {
  status: z.enum(["queued", "in_progress", "completed"]).optional(),
  conclusion: z
    .enum([
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "success",
      "skipped",
      "timed_out",
    ])
    .optional(),
  detailsUrl: z.url().optional(),
  externalId: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  output: z
    .strictObject({
      title: z.string().min(1),
      summary: z.string().min(1),
      text: z.string().optional(),
      annotations: z
        .array(
          z.strictObject({
            path: z.string().min(1),
            startLine: Number_,
            endLine: Number_,
            level: z.enum(["notice", "warning", "failure"]),
            message: z.string().min(1),
            title: z.string().optional(),
          }),
        )
        .max(50)
        .optional(),
    })
    .optional(),
};

const RestBase = {
  path: z
    .string()
    .min(1)
    .describe("Path below the REST API, e.g. /repos/owner/name/pulls"),
  query: z.record(z.string(), z.string()).optional(),
  accept: z
    .string()
    .optional()
    .describe("GitHub media type, e.g. application/vnd.github.diff"),
};
const RestSchemas = {
  get: z.strictObject({
    ...RestBase,
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Byte offset to continue a truncated body from nextOffset"),
  }),
  post: z.strictObject({ ...RestBase, body: z.unknown().optional() }),
  put: z.strictObject({ ...RestBase, body: z.unknown().optional() }),
  patch: z.strictObject({ ...RestBase, body: z.unknown().optional() }),
  delete: z.strictObject({ ...RestBase, body: z.unknown().optional() }),
};

const TypedSchemas = {
  pull_request_files: z.strictObject({
    repository: Repository,
    number: Number_,
  }),
  create_review: z.strictObject({
    repository: Repository,
    number: Number_,
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).default("COMMENT"),
    body: z.string().optional(),
    commitId: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional()
      .describe("Head commit reviewed; defaults to the current head"),
    comments: z
      .array(
        z.strictObject({
          path: z.string().min(1),
          body: z.string().min(1),
          line: Number_.optional(),
          side: Side.optional(),
          startLine: Number_.optional(),
          startSide: Side.optional(),
        }),
      )
      .max(100)
      .optional(),
    stamp: Stamp.optional().describe(
      "Posts once: the body must contain it, and a review of this connection's on the pull request already containing it is returned instead",
    ),
  }),
  create_check_run: z.strictObject({
    repository: Repository,
    name: z.string().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    ...CheckRunFields,
    stamp: Stamp.optional().describe(
      "Posts once: becomes the run's external id, and a run of this App's with the same name and external id on the commit is returned instead",
    ),
  }),
  update_check_run: z.strictObject({
    repository: Repository,
    checkRunId: Number_,
    name: z.string().min(1).optional(),
    ...CheckRunFields,
  }),
  issue_comment: z.strictObject({
    repository: Repository,
    number: Number_,
    body: z.string().min(1),
    stamp: Stamp.optional().describe(
      "Posts once: the body must contain it, and a comment of this connection's on the issue already containing it is returned instead",
    ),
  }),
  review_threads: z.strictObject({ repository: Repository, number: Number_ }),
  check_runs: z.strictObject({
    repository: Repository,
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    name: z.string().min(1).optional(),
  }),
  resolve_review_thread: z.strictObject({
    repository: Repository,
    number: Number_,
    threads: z
      .array(
        z.strictObject({
          threadId: NodeId.describe(
            "Review thread node id, from review_threads",
          ),
          reply: Body.optional().describe(
            "Posted in the thread first, unless its last comment already says it",
          ),
        }),
      )
      .min(1)
      .max(MAX_ITEMS),
  }),
  update_pull_request: z.strictObject({
    repository: Repository,
    number: Number_,
    body: z.string().max(MAX_BODY).describe("The whole new description"),
  }),
  list_reviews: z.strictObject({ repository: Repository, number: Number_ }),
  dismiss_review: z.strictObject({
    repository: Repository,
    number: Number_,
    reviewIds: z.array(Number_).min(1).max(MAX_DISMISSALS),
    message: Body,
  }),
  reply_to_review_comment: z.strictObject({
    repository: Repository,
    number: Number_,
    commentId: Number_.describe(
      "The review comment that opened the thread (its database id)",
    ),
    body: Body,
    stamp: Stamp.optional().describe(
      "Posts once: the body must contain it, and a reply of this connection's in the thread already containing it is returned instead",
    ),
  }),
  update_issue_comment: z.strictObject({
    repository: Repository,
    commentId: Number_,
    body: Body,
  }),
  delete_issue_comment: z.strictObject({
    repository: Repository,
    commentId: Number_,
  }),
};

type RestAction = keyof typeof RestSchemas;
type TypedAction = keyof typeof TypedSchemas;

const REST_ACTIONS: readonly RestAction[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];
const TYPED_ACTIONS: readonly TypedAction[] = [
  "pull_request_files",
  "create_review",
  "create_check_run",
  "update_check_run",
  "issue_comment",
  "review_threads",
  "check_runs",
  "resolve_review_thread",
  "update_pull_request",
  "list_reviews",
  "dismiss_review",
  "reply_to_review_comment",
  "update_issue_comment",
  "delete_issue_comment",
];
/** Typed actions that only read. */
const TYPED_READS: ReadonlySet<TypedAction> = new Set([
  "pull_request_files",
  "review_threads",
  "check_runs",
  "list_reviews",
]);
/** Every action; roles narrow them through the binding's capabilities. */
export const GITHUB_CONNECTION_ACTIONS: readonly string[] = [
  ...REST_ACTIONS,
  ...TYPED_ACTIONS,
];

/** Installation token permissions each typed action needs, and no more. */
const TYPED_PERMISSIONS: Record<TypedAction, GithubPermissions | undefined> = {
  pull_request_files: { pull_requests: "read" },
  create_review: { pull_requests: "write" },
  create_check_run: { checks: "write" },
  update_check_run: { checks: "write" },
  // Comments on pull requests need pull_requests, on issues need issues:
  // issueCommentPermissions reads which the number is.
  issue_comment: undefined,
  review_threads: { pull_requests: "read" },
  check_runs: { checks: "read" },
  resolve_review_thread: { pull_requests: "write" },
  update_pull_request: { pull_requests: "write" },
  list_reviews: { pull_requests: "read" },
  dismiss_review: { pull_requests: "write" },
  reply_to_review_comment: { pull_requests: "write" },
  // Editing or deleting a pull request's conversation comment: Issues.
  update_issue_comment: { issues: "write" },
  delete_issue_comment: { issues: "write" },
};

const DESCRIPTIONS: Record<TypedAction, string> = {
  pull_request_files:
    "List a pull request's changed files with their unified-diff patches",
  create_review:
    "Review a pull request: a summary body, a verdict (COMMENT, APPROVE, REQUEST_CHANGES), and inline comments on diff lines",
  create_check_run:
    "Report a check run on a commit, with an optional summary and line annotations",
  update_check_run: "Update a check run's status, conclusion, or output",
  issue_comment: "Comment on an issue or pull request conversation",
  review_threads:
    "List a pull request's review threads: node id, resolved or not, path and line, and every comment with its database id, author, and whether this connection wrote it (own)",
  check_runs:
    "List the check runs on a commit, by name when given: id, status, conclusion, external id, and whether this App made it (own)",
  resolve_review_thread:
    "Resolve review threads of the pull request (up to 20), each with an optional reply; only threads this connection opened",
  update_pull_request: "Replace a pull request's description",
  list_reviews:
    "List a pull request's reviews: id, state, author, whether this connection wrote it (own), and the commit reviewed",
  dismiss_review:
    "Dismiss reviews of the pull request (up to 100) that approved or requested changes; only reviews this connection wrote",
  reply_to_review_comment:
    "Reply in the review thread an inline comment of the pull request opened",
  update_issue_comment:
    "Edit a conversation comment; only comments this connection wrote",
  delete_issue_comment:
    "Delete a conversation comment; only comments this connection wrote",
};

const AppMaterial = z
  .object({
    kind: z.literal("app").default("app"),
    appId: z.union([z.string().min(1), z.number().int()]).transform(String),
    privateKey: z.string().min(1),
    installationId: z.coerce.number().int().positive().optional(),
    owner: z.string().regex(NAME).optional(),
  })
  .refine(
    (value) => value.installationId !== undefined || value.owner !== undefined,
    "installationId or owner is required",
  );
const UserMaterial = z.object({
  kind: z.literal("user"),
  login: z.string().min(1),
  userId: z.number().int(),
  tokens: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullable(),
    refreshToken: z.string().nullable(),
    refreshTokenExpiresAt: z.number().nullable(),
  }),
});
const Material = z.union([UserMaterial, AppMaterial]);
type Material = z.infer<typeof Material>;
type AppMaterial = z.infer<typeof AppMaterial>;
type UserMaterial = z.infer<typeof UserMaterial>;

/** What an administrator enters to connect an App installation. */
const AppForm = z.object({
  appId: z.string().trim().min(1),
  privateKey: z.string().trim().min(1),
  installationId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : undefined))
    .pipe(z.number().int().positive().optional()),
  owner: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.string().regex(NAME).optional()),
});

const PrivateState = z.discriminatedUnion("flow", [
  z.object({ flow: z.literal("web"), redirectUri: z.string() }),
  z.object({
    flow: z.literal("device"),
    deviceCode: z.string(),
    interval: z.number().positive(),
    expiresAt: z.number(),
  }),
]);

/**
 * GitHub as an ordinary brokered connection (ADRs 0162, 0175). A service
 * connection holds a GitHub App's private key and installation, and mints
 * installation tokens narrowed to the repository and permissions of each
 * call. A member connection holds the person's user-to-server token, so
 * actions are attributed to them. Both serve REST actions (`get`, `post`,
 * ... plus typed conveniences) and Git credentials for the gateway.
 * Credentials stay in the vault; callers never see a token. Typed actions
 * that change or remove an existing review, thread, or comment touch only
 * the connection's own (the App's bot, or the connected person), so a
 * binding that grants them and no raw write verbs cannot reach anyone
 * else's (ADR 0259). A member connection acts with the person's own token,
 * which carries everything they may do: the narrowing above is the
 * installation token's, and only the action's own checks hold for a member.
 */
export function defineGithubConnectionProvider(
  options: GithubConnectionOptions = {},
): GithubConnectionProvider {
  const kind = options.kind ?? "github";
  const displayName = options.displayName ?? "GitHub";
  const apiBase = new URL(options.apiBaseUrl ?? "https://api.github.com");
  const webBase = new URL(options.webBaseUrl ?? "https://github.com");
  for (const base of [apiBase, webBase]) {
    if (base.protocol !== "https:" && !isLoopback(base.hostname)) {
      throw new Error(`${kind}: GitHub URLs must use HTTPS`);
    }
  }
  const apiBaseUrl = apiBase.toString().replace(/\/+$/, "");
  const webBaseUrl = webBase.toString().replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxPatchChars = options.maxPatchChars ?? 20_000;
  const appAuth = new GithubAppAuth({
    fetch: doFetch,
    apiBaseUrl,
    now,
    timeoutMs,
  });
  const installations = new Map<string, Promise<number>>();
  const installationDetails = new Map<string, Promise<GithubInstallation>>();
  const unscopedRestPaths = options.unscopedRestPaths ?? [];

  const actions: ConnectionActionDefinition[] = [
    ...REST_ACTIONS.map((method) => ({
      name: method,
      description: `${method.toUpperCase()} a path on the ${displayName} REST API (${apiBaseUrl})`,
      inputSchema: jsonSchema(RestSchemas[method]),
      annotations: { readOnlyHint: method === "get" },
    })),
    ...TYPED_ACTIONS.map((action) => ({
      name: action,
      description: DESCRIPTIONS[action],
      inputSchema: jsonSchema(TypedSchemas[action]),
      annotations: {
        readOnlyHint: TYPED_READS.has(action),
        ...(action === "delete_issue_comment" || action === "dismiss_review"
          ? { destructiveHint: true }
          : {}),
      },
    })),
  ];

  const installationIdFor = async (app: AppMaterial): Promise<number> => {
    if (app.installationId !== undefined) return app.installationId;
    const owner = app.owner ?? "";
    const key = JSON.stringify([
      app.appId,
      createHash("sha256").update(app.privateKey).digest("hex"),
      owner.toLowerCase(),
    ]);
    const cached = installations.get(key);
    if (cached) return cached;
    const pending = appAuth
      .findInstallation({ app, owner })
      .then((installation) => {
        if (!installation) {
          throw new Error(`The GitHub App is not installed on ${owner}`);
        }
        return installation.id;
      });
    installations.set(key, pending);
    pending.catch(() => installations.delete(key));
    return pending;
  };

  /** The App's installation: its permissions and the App's slug. */
  const installationOf = async (
    app: AppMaterial,
  ): Promise<GithubInstallation> => {
    const installationId = await installationIdFor(app);
    const key = JSON.stringify([
      app.appId,
      createHash("sha256").update(app.privateKey).digest("hex"),
      installationId,
    ]);
    const cached = installationDetails.get(key);
    if (cached) return cached;
    const pending = appAuth.installation({ app, installationId });
    installationDetails.set(key, pending);
    pending.catch(() => installationDetails.delete(key));
    return pending;
  };

  /**
   * Every permission of the App's installation at read level, for tokens
   * that serve reads: a GET never carries write access.
   */
  const readPermissionsFor = async (
    app: AppMaterial,
  ): Promise<GithubPermissions> =>
    readOnlyPermissions((await installationOf(app)).permissions);

  /**
   * Whether this connection wrote an item: the App's own bot
   * (`<slug>[bot]`) for an installation, the connected person for a member.
   */
  const ownAuthor = async (
    credential: Material,
  ): Promise<(author: GithubActor | null) => boolean> => {
    if (credential.kind === "user")
      return (author) =>
        author !== null &&
        author.type === "User" &&
        (author.id !== null
          ? author.id === credential.userId
          : author.login.toLowerCase() === credential.login.toLowerCase());
    const bot =
      `${(await installationOf(credential)).appSlug}[bot]`.toLowerCase();
    return (author) =>
      author !== null &&
      author.type === "Bot" &&
      author.login.toLowerCase() === bot;
  };

  /**
   * The default branch is never written through the API, as through Git
   * (ADR 0175): contents writes name another branch, and refs and merges
   * never target it.
   */
  const refuseDefaultBranchWrite = async (args: {
    token: string;
    repository: { owner: string; name: string };
    method: RestAction;
    path: string;
    body: unknown;
  }): Promise<void> => {
    const branch = branchWritten(args);
    if (branch === undefined) return;
    const full = `${args.repository.owner}/${args.repository.name}`;
    if (branch === null)
      throw new ConnectionActionRefusedError(
        `Writing contents of ${full} without naming a branch writes its default branch, which Work never changes directly; name a work/ branch and open a pull request`,
      );
    const metadata = await githubRestRequest({
      token: args.token,
      method: "GET",
      path: `/repos/${full}`,
      apiBaseUrl,
      fetch: doFetch,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const defaultBranch = jsonField(metadata.body, "default_branch");
    if (metadata.status !== 200 || typeof defaultBranch !== "string")
      throw new ConnectionActionRefusedError(
        `Could not read the default branch of ${full} (${metadata.status}), so this write is refused`,
      );
    if (branch === defaultBranch)
      throw new ConnectionActionRefusedError(
        `${defaultBranch} is the default branch of ${full}, which Work never changes directly; push a work/ branch and open a pull request`,
      );
  };

  /** A token for one call: minted and narrowed for apps, stored for members. */
  const tokenFor = (args: {
    credential: Material;
    repository?: { owner: string; name: string };
    permissions?: GithubPermissions;
  }): Promise<string> => {
    const credential = args.credential;
    if (credential.kind === "user") {
      if (isTokenStale(credential.tokens, now(), 0)) {
        return Promise.reject(new ConnectionAuthorizationExpiredError());
      }
      return Promise.resolve(credential.tokens.accessToken);
    }
    if (
      args.repository &&
      credential.owner &&
      args.repository.owner.toLowerCase() !== credential.owner.toLowerCase()
    ) {
      return Promise.reject(
        new Error(
          `${args.repository.owner}/${args.repository.name} is outside the GitHub App installation on ${credential.owner}`,
        ),
      );
    }
    return withSpan(
      {
        tracer,
        name: "github.installation_token",
        attributes: {
          "catamorphic.connection.provider": kind,
          ...(args.repository
            ? {
                "catamorphic.github.repository": `${args.repository.owner}/${args.repository.name}`,
              }
            : {}),
        },
      },
      async (span) => {
        const installationId = await installationIdFor(credential);
        span.setAttribute("catamorphic.github.installation.id", installationId);
        const minted = await appAuth.installationToken({
          app: credential,
          installationId,
          ...(args.repository ? { repositories: [args.repository.name] } : {}),
          ...(args.permissions ? { permissions: args.permissions } : {}),
        });
        return minted.token;
      },
    );
  };

  /** A member's token GitHub no longer accepts needs a new authorization. */
  const expireOn401 = (credential: Material, status: number) => {
    if (credential.kind === "user" && status === 401) {
      throw new ConnectionAuthorizationExpiredError(
        "GitHub no longer accepts this authorization",
      );
    }
  };

  /**
   * A conversation comment needs only pull_requests on a pull request and
   * issues on an issue; reading which it is takes a read-only token.
   */
  const issueCommentPermissions = async (args: {
    credential: Material;
    repository: { owner: string; name: string };
    number: number;
  }): Promise<GithubPermissions | undefined> => {
    if (args.credential.kind !== "app") return undefined;
    const reader = await tokenFor({
      credential: args.credential,
      repository: args.repository,
      permissions: await readPermissionsFor(args.credential),
    });
    const kind = await new GithubApi(reader, {
      fetch: doFetch,
      baseUrl: apiBaseUrl,
      signal: AbortSignal.timeout(timeoutMs),
    }).issueKind({
      fullName: `${args.repository.owner}/${args.repository.name}`,
      number: args.number,
    });
    return kind === "pull_request"
      ? { pull_requests: "write" }
      : { issues: "write" };
  };

  /** Refuse a conversation comment this connection did not write. */
  const requireOwnIssueComment = async (args: {
    api: GithubApi;
    credential: Material;
    input: { repository: string; commentId: number };
  }): Promise<void> => {
    const own = await ownAuthor(args.credential);
    const comment = await args.api.issueComment({
      fullName: args.input.repository,
      commentId: args.input.commentId,
    });
    if (!own(comment.author))
      throw new ConnectionActionRefusedError(
        `Comment ${args.input.commentId} is ${comment.author?.login ?? "someone else"}'s; this connection changes only its own comments`,
      );
  };

  const invokeTyped = async (args: {
    credential: Material;
    action: TypedAction;
    input: Json;
    repositories: readonly string[] | undefined;
  }): Promise<unknown> => {
    // Validate before minting anything.
    TypedSchemas[args.action].parse(args.input);
    const repositoryField = repositoryOf(args.input);
    const [owner = "", name = ""] = repositoryField.split("/");
    requireRepository({ owner, name }, args.repositories);
    const permissions =
      args.action === "issue_comment"
        ? await issueCommentPermissions({
            credential: args.credential,
            repository: { owner, name },
            number: TypedSchemas.issue_comment.parse(args.input).number,
          })
        : TYPED_PERMISSIONS[args.action];
    const token = await tokenFor({
      credential: args.credential,
      repository: { owner, name },
      permissions,
    });
    const api = new GithubApi(token, {
      fetch: doFetch,
      baseUrl: apiBaseUrl,
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      switch (args.action) {
        case "pull_request_files": {
          const input = TypedSchemas.pull_request_files.parse(args.input);
          const files = await api.pullRequestFiles(
            input.repository,
            input.number,
          );
          return {
            files: files.map((file) =>
              file.patch && file.patch.length > maxPatchChars
                ? {
                    ...file,
                    patch: file.patch.slice(0, maxPatchChars),
                    patchTruncated: true,
                  }
                : file,
            ),
          };
        }
        case "create_review": {
          const input = TypedSchemas.create_review.parse(args.input);
          if (input.stamp !== undefined) {
            requireStamped(input.body ?? "", input.stamp);
            const own = await ownAuthor(args.credential);
            const existing = (
              await api.listReviews({
                fullName: input.repository,
                number: input.number,
              })
            ).find(
              (review) =>
                own(review.author) && review.body.includes(input.stamp ?? ""),
            );
            if (existing)
              return {
                id: existing.id,
                url: existing.url,
                state: existing.state,
                existing: true,
              };
          }
          return await api.createReview({
            fullName: input.repository,
            number: input.number,
            event: input.event,
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.commitId ? { commitId: input.commitId } : {}),
            ...(input.comments ? { comments: input.comments } : {}),
          });
        }
        case "create_check_run": {
          const { repository, stamp, ...input } =
            TypedSchemas.create_check_run.parse(args.input);
          if (stamp !== undefined) {
            if (input.externalId !== undefined && input.externalId !== stamp)
              throw new ConnectionActionRefusedError(
                "A stamped check run's external id is its stamp",
              );
            // Check runs are an App's alone; a member connection makes none.
            const slug =
              args.credential.kind === "app"
                ? (await installationOf(args.credential)).appSlug
                : null;
            const existing = (
              await api.checkRuns({
                fullName: repository,
                sha: input.headSha,
                name: input.name,
              })
            ).find((run) => run.app === slug && run.externalId === stamp);
            if (existing)
              return {
                id: existing.id,
                url: existing.url,
                status: existing.status,
                conclusion: existing.conclusion,
                existing: true,
              };
          }
          return await api.createCheckRun({
            fullName: repository,
            ...input,
            ...(stamp !== undefined ? { externalId: stamp } : {}),
          });
        }
        case "update_check_run": {
          const { repository, ...input } = TypedSchemas.update_check_run.parse(
            args.input,
          );
          return await api.updateCheckRun({ fullName: repository, ...input });
        }
        case "issue_comment": {
          const input = TypedSchemas.issue_comment.parse(args.input);
          if (input.stamp !== undefined) {
            requireStamped(input.body, input.stamp);
            const own = await ownAuthor(args.credential);
            const existing = (
              await api.issueComments({
                fullName: input.repository,
                number: input.number,
              })
            ).find(
              (comment) =>
                own(comment.author) && comment.body.includes(input.stamp ?? ""),
            );
            if (existing)
              return { id: existing.id, url: existing.url, existing: true };
          }
          const comment = await api.commentOnPullRequest({
            fullName: input.repository,
            number: input.number,
            body: input.body,
          });
          return { id: comment.id, url: comment.url };
        }
        case "review_threads": {
          const input = TypedSchemas.review_threads.parse(args.input);
          const own = await ownAuthor(args.credential);
          const threads = await api.reviewThreads({
            fullName: input.repository,
            number: input.number,
          });
          return {
            threads: threads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((comment) => ({
                id: comment.id,
                author: comment.author?.login ?? null,
                own: own(comment.author),
                body: comment.body,
                url: comment.url,
                createdAt: comment.createdAt,
              })),
            })),
          };
        }
        case "check_runs": {
          const input = TypedSchemas.check_runs.parse(args.input);
          const slug =
            args.credential.kind === "app"
              ? (await installationOf(args.credential)).appSlug
              : null;
          const runs = await api.checkRuns({
            fullName: input.repository,
            sha: input.commit,
            ...(input.name ? { name: input.name } : {}),
          });
          return {
            runs: runs.map(({ app, ...run }) => ({
              ...run,
              // Anyone with checks: write (a pull request's own Actions
              // workflow, too) can name a run alike; only the App's count.
              own: slug !== null && app === slug,
            })),
          };
        }
        case "resolve_review_thread": {
          const input = TypedSchemas.resolve_review_thread.parse(args.input);
          requireDistinct(input.threads.map((thread) => thread.threadId));
          const own = await ownAuthor(args.credential);
          // Every thread is checked before any is touched: a forged id must
          // not reach another pull request's thread, or one a person opened.
          const threads = [];
          for (const item of input.threads) {
            const thread = await api.reviewThread({ threadId: item.threadId });
            if (
              !thread ||
              thread.number !== input.number ||
              thread.repository.toLowerCase() !== input.repository.toLowerCase()
            )
              throw new ConnectionActionRefusedError(
                `${item.threadId} is not a review thread of ${input.repository}#${input.number}`,
              );
            if (!own(thread.firstComment?.author ?? null))
              throw new ConnectionActionRefusedError(
                `${item.threadId} was opened by ${thread.firstComment?.author?.login ?? "someone else"}; this connection resolves only threads it opened`,
              );
            threads.push({ item, thread });
          }
          const resolved = [];
          for (const { item, thread } of threads) {
            // A retry finds its reply already last and does not repeat it.
            const reply = item.reply?.trim();
            const replied =
              reply !== undefined &&
              thread.firstComment !== null &&
              thread.lastComment?.body.trim() !== reply;
            if (replied && thread.firstComment)
              await api.commentOnPullRequest({
                fullName: input.repository,
                number: input.number,
                body: reply,
                replyTo: thread.firstComment.id,
              });
            if (!thread.isResolved)
              await api.resolveReviewThread({ threadId: thread.id });
            resolved.push({ id: thread.id, isResolved: true, replied });
          }
          return { threads: resolved };
        }
        case "update_pull_request": {
          const input = TypedSchemas.update_pull_request.parse(args.input);
          return await api.updatePullRequest({
            fullName: input.repository,
            number: input.number,
            body: input.body,
          });
        }
        case "list_reviews": {
          const input = TypedSchemas.list_reviews.parse(args.input);
          const own = await ownAuthor(args.credential);
          const reviews = await api.listReviews({
            fullName: input.repository,
            number: input.number,
          });
          return {
            reviews: reviews.map((review) => ({
              id: review.id,
              state: review.state,
              author: review.author?.login ?? null,
              own: own(review.author),
              body: review.body,
              commitId: review.commitId,
              submittedAt: review.submittedAt,
              url: review.url,
            })),
          };
        }
        case "dismiss_review": {
          const input = TypedSchemas.dismiss_review.parse(args.input);
          requireDistinct(input.reviewIds);
          const own = await ownAuthor(args.credential);
          const reviews = [];
          for (const reviewId of input.reviewIds) {
            const review = await api.review({
              fullName: input.repository,
              number: input.number,
              reviewId,
            });
            if (review.number !== input.number)
              throw new ConnectionActionRefusedError(
                `Review ${reviewId} is not on ${input.repository}#${input.number}`,
              );
            if (!own(review.author))
              throw new ConnectionActionRefusedError(
                `Review ${reviewId} is ${review.author?.login ?? "someone else"}'s; this connection dismisses only its own reviews`,
              );
            if (
              review.state !== "CHANGES_REQUESTED" &&
              review.state !== "APPROVED" &&
              review.state !== "DISMISSED"
            )
              throw new ConnectionActionRefusedError(
                `Review ${reviewId} is ${review.state}; only reviews that approved or requested changes can be dismissed`,
              );
            reviews.push(review);
          }
          for (const review of reviews)
            if (review.state !== "DISMISSED")
              await api.dismissReview({
                fullName: input.repository,
                number: input.number,
                reviewId: review.id,
                message: input.message,
              });
          return {
            reviews: reviews.map((review) => ({
              id: review.id,
              state: "DISMISSED",
              url: review.url,
            })),
          };
        }
        case "reply_to_review_comment": {
          const input = TypedSchemas.reply_to_review_comment.parse(args.input);
          const parent = await api.reviewComment({
            fullName: input.repository,
            commentId: input.commentId,
          });
          if (parent.number !== input.number)
            throw new ConnectionActionRefusedError(
              `Comment ${input.commentId} is not a review comment of ${input.repository}#${input.number}`,
            );
          // GitHub threads replies under the comment that opened them.
          const root = parent.inReplyTo ?? parent.id;
          if (input.stamp !== undefined) {
            requireStamped(input.body, input.stamp);
            const own = await ownAuthor(args.credential);
            const existing = (
              await api.reviewComments({
                fullName: input.repository,
                number: input.number,
              })
            ).find(
              (comment) =>
                (comment.inReplyTo ?? comment.id) === root &&
                own(comment.author) &&
                comment.body.includes(input.stamp ?? ""),
            );
            if (existing)
              return { id: existing.id, url: existing.url, existing: true };
          }
          const reply = await api.commentOnPullRequest({
            fullName: input.repository,
            number: input.number,
            body: input.body,
            replyTo: root,
          });
          return { id: reply.id, url: reply.url };
        }
        case "update_issue_comment": {
          const input = TypedSchemas.update_issue_comment.parse(args.input);
          await requireOwnIssueComment({
            api,
            credential: args.credential,
            input,
          });
          const updated = await api.updateIssueComment({
            fullName: input.repository,
            commentId: input.commentId,
            body: input.body,
          });
          return { id: updated.id, url: updated.url };
        }
        case "delete_issue_comment": {
          const input = TypedSchemas.delete_issue_comment.parse(args.input);
          await requireOwnIssueComment({
            api,
            credential: args.credential,
            input,
          });
          await api.deleteIssueComment({
            fullName: input.repository,
            commentId: input.commentId,
          });
          return { id: input.commentId, deleted: true };
        }
      }
    } catch (error) {
      if (error instanceof GithubApiError) {
        expireOn401(args.credential, error.status);
      }
      throw error;
    }
  };

  const invokeRest = async (args: {
    credential: Material;
    method: RestAction;
    input: Json;
    repositories: readonly string[] | undefined;
  }): Promise<unknown> => {
    const input = RestSchemas[args.method].parse(args.input);
    // Resolve first: a path GitHub would read differently is refused here.
    githubRestUrl({ path: input.path, apiBaseUrl });
    const repository = repositoryFromRestPath(input.path);
    if (repository) requireRepository(repository, args.repositories);
    else if (!unscopedRestPaths.some((prefix) => under(input.path, prefix)))
      throw new ConnectionActionRefusedError(
        `This connection reaches only its repositories through /repos/{owner}/{name}/...; '${input.path}' is outside them`,
      );
    const reads = args.method === "get";
    const token = await tokenFor({
      credential: args.credential,
      ...(repository ? { repository } : {}),
      ...(reads && args.credential.kind === "app"
        ? { permissions: await readPermissionsFor(args.credential) }
        : {}),
    });
    if (!reads && repository)
      await refuseDefaultBranchWrite({
        token,
        repository,
        method: args.method,
        path: input.path,
        body: "body" in input ? input.body : undefined,
      });
    const response = await githubRestRequest({
      token,
      method: restMethod(args.method),
      path: input.path,
      ...(input.query ? { query: input.query } : {}),
      ...("body" in input && input.body !== undefined
        ? { body: input.body }
        : {}),
      ...(input.accept ? { accept: input.accept } : {}),
      ...("offset" in input && input.offset !== undefined
        ? { offset: input.offset }
        : {}),
      ...(options.maxResponseBytes
        ? { maxResponseBytes: options.maxResponseBytes }
        : {}),
      apiBaseUrl,
      fetch: doFetch,
      signal: AbortSignal.timeout(timeoutMs),
    });
    expireOn401(args.credential, response.status);
    // A read GitHub failed to serve is not an answer: throwing lets the
    // caller (a workflow step's retry, an agent) ask again. Other statuses,
    // and every write's, come back as data.
    if (reads && response.status >= 500)
      throw new GithubApiError(
        response.status,
        `GitHub answered ${response.status} reading ${input.path}`,
      );
    return response;
  };

  const userMaterial = async (tokens: GithubTokenSet) => {
    const user = await new GithubApi(tokens.accessToken, {
      fetch: doFetch,
      baseUrl: apiBaseUrl,
      signal: AbortSignal.timeout(timeoutMs),
    }).getUser();
    const material: UserMaterial = {
      kind: "user",
      login: user.login,
      userId: user.id,
      tokens,
    };
    return {
      material: encode(material),
      account: {
        type: "user",
        login: user.login,
        id: user.id,
        name: user.name,
      },
      capabilities: GITHUB_CONNECTION_ACTIONS,
      ...(tokens.expiresAt ? { expiresAt: new Date(tokens.expiresAt) } : {}),
    };
  };

  const requireOauth = (): GithubAppConfig => {
    if (!options.oauth) {
      throw new Error(
        `${displayName} accepts only GitHub App connections; configure the app's OAuth client for personal connections`,
      );
    }
    return options.oauth;
  };

  const authorizeApp: GithubConnectionProvider["authorizeApp"] = async ({
    appId,
    privateKey,
    installationId,
    owner,
  }) => {
    parseGithubAppPrivateKey(privateKey);
    const app = { appId: appId.trim(), privateKey: privateKey.trim() };
    const installation =
      installationId !== undefined
        ? await appAuth.installation({ app, installationId })
        : owner
          ? await appAuth.findInstallation({ app, owner })
          : null;
    if (!installation) {
      throw new Error(
        owner
          ? `The GitHub App is not installed on ${owner}`
          : "An installation ID or owner is required",
      );
    }
    if (installation.suspendedAt) {
      throw new Error("The GitHub App installation is suspended");
    }
    const material: AppMaterial = {
      kind: "app",
      ...app,
      installationId: installation.id,
      ...(installation.account ? { owner: installation.account.login } : {}),
    };
    return {
      material: encode(material),
      account: {
        type: "app",
        appId: app.appId,
        installationId: installation.id,
        account: installation.account?.login ?? null,
        repositorySelection: installation.repositorySelection,
      },
      capabilities: GITHUB_CONNECTION_ACTIONS,
    };
  };

  return {
    kind,
    displayName,

    beginAuthorization: async ({ principal, redirectUri, state }) => {
      // An organization connects its GitHub App installation; a person
      // signs in with the App's OAuth client.
      if (principal === "service") {
        return {
          challenge: {
            kind: "form",
            fields: [
              { name: "appId", label: "App ID", secret: false, required: true },
              {
                name: "privateKey",
                label: "Private key (PEM)",
                secret: true,
                required: true,
                multiline: true,
              },
              {
                name: "installationId",
                label: "Installation ID",
                secret: false,
                required: false,
              },
              {
                name: "owner",
                label: "Installed on (organization or user)",
                secret: false,
                required: false,
              },
            ],
          },
        };
      }
      const oauth = requireOauth();
      if (oauth.clientSecret) {
        return {
          challenge: {
            kind: "url",
            url: buildAuthorizeUrl(oauth, {
              redirectUri,
              state,
              baseUrl: webBaseUrl,
            }),
          },
          privateState: encode({ flow: "web", redirectUri }),
        };
      }
      const grant = await requestDeviceCode(oauth, {
        fetch: doFetch,
        baseUrl: webBaseUrl,
      });
      const expiresAt = now() + grant.expiresIn * 1000;
      return {
        challenge: {
          kind: "device",
          verificationUrl: grant.verificationUri,
          userCode: grant.userCode,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        privateState: encode({
          flow: "device",
          deviceCode: grant.deviceCode,
          interval: grant.interval,
          expiresAt,
        }),
      };
    },

    completeAuthorization: async ({ principal, callback, privateState }) => {
      if (principal === "service") {
        const fields = AppForm.parse(callback);
        return authorizeApp({
          appId: fields.appId,
          privateKey: fields.privateKey,
          ...(fields.installationId
            ? { installationId: fields.installationId }
            : {}),
          ...(fields.owner ? { owner: fields.owner } : {}),
        });
      }
      const oauth = requireOauth();
      if (!privateState)
        throw new Error("GitHub authorization state is missing");
      const state = PrivateState.parse(decode(privateState));
      if (state.flow === "web") {
        if (callback.error) {
          throw new GithubAuthError(
            callback.error,
            callback.error_description ?? "GitHub authorization was refused",
          );
        }
        const code = callback.code;
        if (!code) throw new Error("GitHub returned no authorization code");
        return userMaterial(
          await exchangeCode(
            oauth,
            { code, redirectUri: state.redirectUri },
            { fetch: doFetch, baseUrl: webBaseUrl, now: now() },
          ),
        );
      }
      const deadline = Math.min(
        state.expiresAt,
        now() + (options.devicePollTimeoutMs ?? 60_000),
      );
      for (let interval = state.interval; ; ) {
        const polled = await pollDeviceToken(oauth, state.deviceCode, {
          fetch: doFetch,
          baseUrl: webBaseUrl,
          now: now(),
        });
        if (polled.tokens) return userMaterial(polled.tokens);
        if (polled.retryAfter > 0) interval = polled.retryAfter;
        if (now() + interval * 1000 > deadline) {
          throw new GithubAuthError(
            "authorization_pending",
            "GitHub authorization is not finished; enter the code, then continue",
          );
        }
        await sleep(interval * 1000);
      }
    },

    authorizeApp,

    authorizeUser: async ({ tokens }) => userMaterial(tokens),

    accessToken: ({ material, repository, permissions }) =>
      tokenFor({
        credential: decodeMaterial(material),
        ...(repository ? { repository } : {}),
        ...(permissions ? { permissions } : {}),
      }),

    repositoryOf: (remoteUrl) =>
      repositoryFromRemote({ remoteUrl, webBaseUrl }),

    api: { baseUrl: apiBaseUrl, webBaseUrl, fetch: doFetch },

    listActions: async ({ capabilities }) =>
      actions.filter((action) => capabilities.includes(action.name)),

    invoke: async ({ material, action, input, capabilities, repositories }) => {
      if (!capabilities.includes(action)) {
        throw new Error(
          `GitHub action '${action}' is outside the connection grant`,
        );
      }
      const credential = decodeMaterial(material);
      if (isRestAction(action)) {
        return toJson(
          await invokeRest({ credential, method: action, input, repositories }),
        );
      }
      if (isTypedAction(action)) {
        return toJson(
          await invokeTyped({ credential, action, input, repositories }),
        );
      }
      throw new Error(`Unknown GitHub action '${action}'`);
    },

    refresh: async ({ material }) => {
      const credential = decodeMaterial(material);
      if (credential.kind === "app") return { material };
      const refreshToken = credential.tokens.refreshToken;
      const refreshExpiry = credential.tokens.refreshTokenExpiresAt;
      if (
        !options.oauth ||
        !refreshToken ||
        (refreshExpiry !== null && refreshExpiry <= now())
      ) {
        throw new ConnectionAuthorizationExpiredError();
      }
      const oauth = options.oauth;
      const tokens = await refreshAccessToken(oauth, refreshToken, {
        fetch: doFetch,
        baseUrl: webBaseUrl,
        now: now(),
      }).catch((error: unknown) => {
        if (error instanceof GithubAuthError) {
          throw new ConnectionAuthorizationExpiredError();
        }
        throw error;
      });
      const next: UserMaterial = { ...credential, tokens };
      return {
        material: encode(next),
        ...(tokens.expiresAt ? { expiresAt: new Date(tokens.expiresAt) } : {}),
      };
    },

    revoke: async ({ material }) => {
      const credential = decodeMaterial(material);
      if (credential.kind === "app") {
        await appAuth.revokeCachedTokens({ app: credential });
        return;
      }
      if (!options.oauth?.clientSecret) return;
      await revokeUserToken({
        app: options.oauth,
        accessToken: credential.tokens.accessToken,
        fetch: doFetch,
        apiBaseUrl,
      });
    },

    git: {
      remoteBaseUrls: [`${webBaseUrl}/`],
      credentials: ({ material, remoteUrl, access }) =>
        withSpan(
          {
            tracer,
            name: "github.git.credentials",
            attributes: {
              "catamorphic.connection.provider": kind,
              "catamorphic.git.access": access,
            },
          },
          async () => {
            const repository = repositoryFromRemote({ remoteUrl, webBaseUrl });
            const credential = decodeMaterial(material);
            const password = await tokenFor({
              credential,
              repository,
              permissions: {
                contents: access === "write" ? "write" : "read",
              },
            });
            if (credential.kind === "user") {
              return {
                username: credential.login,
                password,
                ...(credential.tokens.expiresAt
                  ? { expiresAt: new Date(credential.tokens.expiresAt) }
                  : {}),
              };
            }
            return { username: "x-access-token", password };
          },
        ),
    },
  };
}

function isRestAction(value: string): value is RestAction {
  return REST_ACTIONS.some((action) => action === value);
}

function isTypedAction(value: string): value is TypedAction {
  return TYPED_ACTIONS.some((action) => action === value);
}

function restMethod(action: RestAction): GithubRestMethod {
  switch (action) {
    case "get":
      return "GET";
    case "post":
      return "POST";
    case "put":
      return "PUT";
    case "patch":
      return "PATCH";
    case "delete":
      return "DELETE";
  }
}

/** Refuse a repository outside the binding's (ADR 0175); names ignore case. */
function requireRepository(
  repository: { owner: string; name: string },
  repositories: readonly string[] | undefined,
): void {
  const full = `${repository.owner}/${repository.name}`;
  const allowed = repositories ?? [];
  if (allowed.some((entry) => entry.toLowerCase() === full.toLowerCase()))
    return;
  throw new ConnectionActionRefusedError(
    allowed.length > 0
      ? `${full} is outside this connection's repositories (${allowed.join(", ")})`
      : `This connection reaches no repository, so ${full} is refused: link the project to a GitHub remote or name repositories in the binding`,
  );
}

/** A stamp the body does not carry could never be found again. */
function requireStamped(body: string, stamp: string): void {
  if (!body.includes(stamp))
    throw new ConnectionActionRefusedError(
      "The body must contain its stamp, so a retry can find it",
    );
}

/** Refuse a list that names one item twice. */
function requireDistinct(items: readonly (string | number)[]): void {
  const repeated = items.find((item, index) => items.indexOf(item) !== index);
  if (repeated !== undefined)
    throw new ConnectionActionRefusedError(`${repeated} is listed twice`);
}

/** Whether a REST path is `prefix` or below it. */
function under(path: string, prefix: string): boolean {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = prefix.replace(/\/+$/, "");
  return normalized === base || normalized.startsWith(`${base}/`);
}

/**
 * The branch a REST write updates, for the endpoints that write branches
 * directly: `null` when a contents write names none (it writes the default
 * branch), undefined for anything else.
 */
function branchWritten(args: {
  repository: { owner: string; name: string };
  method: RestAction;
  path: string;
  body: unknown;
}): string | null | undefined {
  const rest = args.path
    .replace(/^\/?repos\/[^/]+\/[^/]+\/?/, "")
    .replace(/\/+$/, "");
  const field = (name: string) => {
    const value = jsonField(args.body, name);
    return typeof value === "string" ? value : undefined;
  };
  if (
    (rest === "contents" || rest.startsWith("contents/")) &&
    (args.method === "put" || args.method === "delete")
  )
    return field("branch")?.replace(/^refs\/heads\//, "") ?? null;
  if (rest.startsWith("git/refs/heads/") && args.method !== "post")
    return rest.slice("git/refs/heads/".length);
  if (rest === "git/refs" && args.method === "post") {
    const ref = field("ref");
    return ref?.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : undefined;
  }
  if (rest === "merges" && args.method === "post") return field("base");
  return undefined;
}

function jsonField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return Object.entries(value).find(([key]) => key === name)?.[1];
}

/** GitHub permissions that exist only at write level. */
const WRITE_ONLY_PERMISSIONS = new Set(["workflows"]);

/**
 * An installation's permissions at read level. Never empty: an empty
 * request would mint every permission the installation holds.
 */
function readOnlyPermissions(
  permissions: Readonly<Record<string, string>>,
): GithubPermissions {
  const read: Record<string, "read"> = { metadata: "read" };
  for (const [name, level] of Object.entries(permissions)) {
    if (WRITE_ONLY_PERMISSIONS.has(name)) continue;
    if (level === "read" || level === "write" || level === "admin")
      read[name] = "read";
  }
  return read;
}

function repositoryOf(input: Json): string {
  const parsed = z.object({ repository: Repository }).safeParse(input);
  if (!parsed.success) {
    throw new Error("A repository (owner/name) is required");
  }
  return parsed.data.repository;
}

/**
 * `https://github.com/owner/name(.git)` → owner and name. Anything outside
 * the provider's web origin is refused, so credentials only go to GitHub.
 */
function repositoryFromRemote(args: {
  remoteUrl: string;
  webBaseUrl: string;
}): { owner: string; name: string } {
  const prefix = `${args.webBaseUrl}/`;
  const url = args.remoteUrl.trim();
  const match = url.startsWith(prefix)
    ? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.slice(prefix.length))
    : null;
  if (!match?.[1] || !match[2] || match[1] === ".." || match[2] === "..") {
    throw new Error(`Not a repository on ${args.webBaseUrl}`);
  }
  return { owner: match[1], name: match[2] };
}

function decodeMaterial(material: Uint8Array): Material {
  const parsed = Material.safeParse(safeDecode(material));
  if (!parsed.success) {
    // Never echo material: it holds a private key or tokens.
    throw new Error("GitHub connection credentials are not readable");
  }
  return parsed.data;
}

function safeDecode(material: Uint8Array): unknown {
  try {
    return decode(material);
  } catch {
    return null;
  }
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decode(value: Uint8Array): unknown {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
  return parsed;
}

function toJson(value: unknown): Json {
  const json: Json = JSON.parse(JSON.stringify(value ?? null));
  return json;
}

function jsonSchema(schema: z.ZodType): Json {
  return z.json().parse(z.toJSONSchema(schema, { io: "input" }));
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
