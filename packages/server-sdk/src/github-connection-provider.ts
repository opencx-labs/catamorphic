import { createHash } from "node:crypto";
import {
  type ConnectionActionDefinition,
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
  GithubApi,
  GithubApiError,
  GithubAppAuth,
  type GithubAppConfig,
  GithubAuthError,
  type GithubPermissions,
  type GithubRestMethod,
  type GithubTokenSet,
  githubRestRequest,
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
  readonly api: { baseUrl: string; fetch: FetchLike };
};

const Repository = z
  .string()
  .regex(FULL_NAME)
  .describe("Repository as owner/name");
const Number_ = z.number().int().positive();
const Side = z.enum(["LEFT", "RIGHT"]);
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
  }),
  create_check_run: z.strictObject({
    repository: Repository,
    name: z.string().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    ...CheckRunFields,
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
];
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
  // Comments on pull requests need pull_requests, on issues need issues.
  issue_comment: undefined,
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
 * Credentials stay in the vault; callers never see a token.
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
  const appAuth = new GithubAppAuth({ fetch: doFetch, apiBaseUrl, now });
  const installations = new Map<string, Promise<number>>();

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
      annotations: { readOnlyHint: action === "pull_request_files" },
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

  const invokeTyped = async (args: {
    credential: Material;
    action: TypedAction;
    input: Json;
  }): Promise<unknown> => {
    // Validate before minting anything.
    TypedSchemas[args.action].parse(args.input);
    const repositoryField = repositoryOf(args.input);
    const [owner = "", name = ""] = repositoryField.split("/");
    const token = await tokenFor({
      credential: args.credential,
      repository: { owner, name },
      permissions: TYPED_PERMISSIONS[args.action],
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
          const { repository, ...input } = TypedSchemas.create_check_run.parse(
            args.input,
          );
          return await api.createCheckRun({ fullName: repository, ...input });
        }
        case "update_check_run": {
          const { repository, ...input } = TypedSchemas.update_check_run.parse(
            args.input,
          );
          return await api.updateCheckRun({ fullName: repository, ...input });
        }
        case "issue_comment": {
          const input = TypedSchemas.issue_comment.parse(args.input);
          const comment = await api.commentOnPullRequest({
            fullName: input.repository,
            number: input.number,
            body: input.body,
          });
          return { id: comment.id, url: comment.url };
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
  }): Promise<unknown> => {
    const input = RestSchemas[args.method].parse(args.input);
    const token = await tokenFor({
      credential: args.credential,
      repository: repositoryFromRestPath(input.path) ?? undefined,
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
    return response;
  };

  const userMaterial = async (tokens: GithubTokenSet) => {
    const user = await new GithubApi(tokens.accessToken, {
      fetch: doFetch,
      baseUrl: apiBaseUrl,
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

    api: { baseUrl: apiBaseUrl, fetch: doFetch },

    listActions: async ({ capabilities }) =>
      actions.filter((action) => capabilities.includes(action.name)),

    invoke: async ({ material, action, input, capabilities }) => {
      if (!capabilities.includes(action)) {
        throw new Error(
          `GitHub action '${action}' is outside the connection grant`,
        );
      }
      const credential = decodeMaterial(material);
      if (isRestAction(action)) {
        return toJson(await invokeRest({ credential, method: action, input }));
      }
      if (isTypedAction(action)) {
        return toJson(await invokeTyped({ credential, action, input }));
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
