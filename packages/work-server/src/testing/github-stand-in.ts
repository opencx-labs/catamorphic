import { execFile, spawn } from "node:child_process";
import { createPublicKey, createVerify, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * GitHub on loopback for end-to-end tests: one App installation on a few
 * repositories, the REST endpoints the `pull-request-reviews` and
 * `github-polling` packs call through the `github` connection, and Git
 * smart HTTP for each repository. Every request is recorded, so a test
 * asserts exactly what reached GitHub; nothing but installation tokens the
 * App's token flow minted (itself signed with the App's key) is accepted.
 *
 * Routes are a table keyed by method and path pattern: an endpoint a
 * recipe starts calling is one entry.
 */
export interface GithubStandIn {
  /** The REST API base and the web base (Git remotes): one origin. */
  url: string;
  /** The App's bot, the author of everything the App writes. */
  bot: GithubActor;
  /** Every request, in order. */
  calls: GithubCall[];
  /** Installation tokens the App's token flow minted. */
  tokens: ReadonlySet<string>;
  /** Calls that changed GitHub or tried to, Git pushes included. */
  writes(): GithubCall[];
  /** One of its repositories, by `owner/name`. */
  repository(fullName: string): StandInRepository;
  /**
   * A `fetch` for the server's GitHub hook: the stand-in, and nothing else,
   * so no request can leave for the real GitHub.
   */
  fetch: typeof fetch;
  close(): Promise<void>;
}

/** One repository: its Git, its pull requests, and what the App wrote. */
export interface StandInRepository {
  fullName: string;
  /** The bare Git directory, which tests push to. */
  gitDirectory: string;
  pulls: Map<number, StandInPull>;
  checkRuns: StandInCheckRun[];
  reviews: StandInReview[];
  /** Conversation comments, by everyone. */
  issueComments: StandInComment[];
  /** Inline review comments, by everyone. */
  reviewComments: StandInComment[];
  /** The writes that reached this repository, through its API or Git. */
  writes(): GithubCall[];
  /**
   * Open pull request `number` whose head is already at
   * `refs/pull/<number>/head`; its base is the repository's main.
   */
  openPullRequest(input: {
    number: number;
    title: string;
    body: string;
    headRef: string;
    author: GithubActor;
    reviewers?: GithubActor[];
  }): Promise<StandInPull>;
  /** Record a push: the pull request's head moved to `refs/pull/<number>/head`. */
  pushed(input: { number: number }): Promise<StandInPull>;
  /** Close it without merging. */
  close(input: { number: number }): StandInPull;
  /** A person's comment in a pull request's conversation. */
  comment(input: {
    number: number;
    body: string;
    author: GithubActor;
  }): StandInComment;
}

export interface GithubActor {
  login: string;
  id: number;
  type: "User" | "Bot";
}

export interface GithubCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** `jwt`, `installation`, `git` (an installation token over Basic), or none. */
  credential: "jwt" | "installation" | "git" | null;
  body: unknown;
  status: number;
}

export interface StandInPull {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  user: GithubActor;
  requestedReviewers: GithubActor[];
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface StandInCheckRun {
  id: number;
  name: string;
  head_sha: string;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  output: unknown;
  app: { slug: string };
  html_url: string;
}

export interface StandInReview {
  id: number;
  number: number;
  user: GithubActor;
  body: string;
  state: string;
  commit_id: string | null;
  submitted_at: string;
  html_url: string;
  pull_request_url: string;
  /** The inline comments it was posted with. */
  comments: Array<{ path: string; line?: number; side?: string; body: string }>;
}

export interface StandInComment {
  id: number;
  number: number;
  user: GithubActor;
  body: string;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number;
  created_at: string;
  updated_at: string;
  html_url: string;
}

/** GitHub's timestamps: seconds, `Z`. */
const githubTime = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

type Json = Record<string, unknown>;
const json = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

interface RouteContext {
  match: RegExpExecArray;
  query: URLSearchParams;
  body: Json;
}

interface RouteAnswer {
  status?: number;
  body: unknown;
}

interface Route {
  method: string;
  pattern: RegExp;
  /** Who may call it: the App itself (a JWT) or an installation. */
  credential: "jwt" | "installation";
  handle(context: RouteContext): RouteAnswer | Promise<RouteAnswer>;
}

export async function startGithubStandIn(input: {
  /** The repositories the App is installed on, as `owner/name`. */
  repositories: readonly string[];
  /** Where each bare repository is made, as `<owner>/<name>.git`. */
  gitRoot: string;
  /** The GitHub App the `github` service connection authorizes as. */
  app: { id: string; slug: string; installationId: number; privateKey: string };
  /**
   * Accept Git pushes. Off by default: a push is refused (403) and still
   * recorded as a write, so a test sees any attempt.
   */
  pushes?: boolean;
}): Promise<GithubStandIn> {
  const appKey = createPublicKey(input.app.privateKey);
  const bot: GithubActor = {
    login: `${input.app.slug}[bot]`,
    id: 4242,
    type: "Bot",
  };
  const calls: GithubCall[] = [];
  const tokens = new Set<string>();
  const ids = { next: 1000 };
  const origin = { url: "" };
  const owners = new Set(
    input.repositories.map((entry) => entry.split("/")[0]),
  );
  const appRoutes: Route[] = [
    {
      method: "GET",
      pattern: new RegExp(`^/app/installations/${input.app.installationId}$`),
      credential: "jwt",
      handle: () => ({
        body: {
          id: input.app.installationId,
          account: { login: [...owners][0], id: 1, type: "Organization" },
          repository_selection: "selected",
          permissions: {},
          events: [],
          app_slug: input.app.slug,
          suspended_at: null,
        },
      }),
    },
    {
      method: "POST",
      pattern: new RegExp(
        `^/app/installations/${input.app.installationId}/access_tokens$`,
      ),
      credential: "jwt",
      handle: () => {
        const token = `ghs_${randomBytes(18).toString("hex")}`;
        tokens.add(token);
        return {
          status: 201,
          body: {
            token,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/graphql$/,
      credential: "installation",
      // Review threads: the App's inline comments start none a reply
      // would answer in.
      handle: () => ({
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      }),
    },
  ];
  const repositories = new Map<
    string,
    { handle: StandInRepository; routes: Route[] }
  >();
  for (const fullName of input.repositories)
    repositories.set(
      fullName,
      await standInRepository({
        fullName,
        gitRoot: input.gitRoot,
        bot,
        calls,
        ids,
        origin,
        appSlug: input.app.slug,
      }),
    );

  /** The App's own JWT, signed RS256 with its key and issued by its id. */
  const appJwt = (token: string): boolean => {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    if (!verifier.verify(appKey, Buffer.from(signature, "base64url")))
      return false;
    const claims = json(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const now = Date.now() / 1000;
    return (
      String(claims.iss) === input.app.id &&
      typeof claims.exp === "number" &&
      claims.exp > now
    );
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      // A route that failed answers instead of leaving the caller waiting.
      const last = calls.at(-1);
      if (last && last.status === 0) last.status = 500;
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      } else response.destroy();
    });
  });
  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://stand-in");
    const pathname = decodeURIComponent(requestUrl.pathname);
    const authorization = request.headers.authorization ?? "";
    const call: GithubCall = {
      method: request.method ?? "GET",
      path: pathname,
      query: Object.fromEntries(requestUrl.searchParams),
      credential: null,
      body: undefined,
      status: 0,
    };
    calls.push(call);
    const gitRepository = /^\/([^/]+\/[^/]+)\.git\//.exec(pathname)?.[1];
    if (gitRepository && repositories.has(gitRepository)) {
      const [scheme, encoded] = authorization.split(" ");
      const [user, token] = Buffer.from(encoded ?? "", "base64")
        .toString()
        .split(":");
      if (
        scheme !== "Basic" ||
        user !== "x-access-token" ||
        !tokens.has(token ?? "")
      ) {
        call.status = 401;
        response.writeHead(401, { "www-authenticate": 'Basic realm="github"' });
        response.end();
        return;
      }
      call.credential = "git";
      if (isPush(call) && !input.pushes) {
        call.status = 403;
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("Pushes are not accepted here");
        return;
      }
      call.status = 200;
      gitHttpBackend({ request, response, projectRoot: input.gitRoot });
      return;
    }
    const answer = (status: number, value: unknown) => {
      call.status = status;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // As GitHub answers a body it cannot parse.
      answer(400, { message: "Problems parsing JSON" });
      return;
    }
    const body: Json = json(parsed);
    call.body = parsed;
    const routes = [
      ...appRoutes,
      ...[...repositories.values()].flatMap((entry) => entry.routes),
    ];
    for (const route of routes) {
      if (route.method !== call.method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const bearer = /^(?:Bearer|token) (\S+)$/.exec(authorization)?.[1] ?? "";
      const allowed =
        route.credential === "jwt" ? appJwt(bearer) : tokens.has(bearer);
      if (!allowed) {
        answer(401, { message: "Bad credentials" });
        return;
      }
      call.credential = route.credential;
      try {
        const handled = await route.handle({
          match,
          query: requestUrl.searchParams,
          body,
        });
        answer(handled.status ?? 200, handled.body);
      } catch (error) {
        if (error instanceof NotFound) answer(404, { message: "Not Found" });
        else throw error;
      }
      return;
    }
    answer(404, { message: "Not Found" });
  }
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The stand-in GitHub has no port");
  origin.url = `http://127.0.0.1:${address.port}`;

  return {
    url: origin.url,
    bot,
    calls,
    tokens,
    writes: () => calls.filter(isWrite),
    repository: (fullName) => {
      const found = repositories.get(fullName);
      if (!found)
        throw new Error(`The stand-in GitHub has no repository ${fullName}`);
      return found.handle;
    },
    fetch: (resource, init) => {
      const target = new URL(
        resource instanceof Request ? resource.url : String(resource),
      );
      if (target.origin !== origin.url)
        return Promise.reject(
          new Error(
            `The stand-in GitHub refused a request to ${target.origin}`,
          ),
        );
      return fetch(resource, init);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** One repository's state and routes. */
async function standInRepository(args: {
  fullName: string;
  gitRoot: string;
  bot: GithubActor;
  calls: GithubCall[];
  ids: { next: number };
  origin: { url: string };
  appSlug: string;
}): Promise<{ handle: StandInRepository; routes: Route[] }> {
  const { fullName, bot } = args;
  const [owner = "", name = ""] = fullName.split("/");
  const gitDirectory = path.join(args.gitRoot, owner, `${name}.git`);
  fs.mkdirSync(gitDirectory, { recursive: true });
  await execute("git", ["init", "--bare", "-q", "-b", "main", gitDirectory]);
  const pulls = new Map<number, StandInPull>();
  const checkRuns: StandInCheckRun[] = [];
  const reviews: StandInReview[] = [];
  const issueComments: StandInComment[] = [];
  const reviewComments: StandInComment[] = [];
  const repo = `/repos/${owner}/${name}`;
  const web = () => `${args.origin.url}/${owner}/${name}`;
  const git = async (gitArgs: readonly string[]) =>
    (
      await execute("git", ["--git-dir", gitDirectory, ...gitArgs])
    ).stdout.trim();

  /** A list answer, paged as GitHub pages it. */
  const page = <T>(items: readonly T[], query: URLSearchParams): T[] => {
    const size = Number(query.get("per_page") ?? 30);
    const at = Number(query.get("page") ?? 1);
    return items.slice((at - 1) * size, at * size);
  };
  const pullOf = (number: string | undefined) => {
    const pull = pulls.get(Number(number));
    if (!pull) throw new NotFound();
    return pull;
  };
  const restPull = (pull: StandInPull) => ({
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    html_url: `${web()}/pull/${pull.number}`,
    url: `${args.origin.url}${repo}/pulls/${pull.number}`,
    draft: pull.draft,
    merged: pull.mergedAt !== null,
    user: pull.user,
    requested_reviewers: pull.requestedReviewers,
    head: pull.head,
    base: pull.base,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
  });
  const restComment = (comment: StandInComment, kind: "issue" | "review") => ({
    ...comment,
    ...(kind === "issue"
      ? { issue_url: `${args.origin.url}${repo}/issues/${comment.number}` }
      : {
          pull_request_url: `${args.origin.url}${repo}/pulls/${comment.number}`,
        }),
  });
  /** The pull request's files, as GitHub lists them: each with its patch. */
  const filesOf = async (pull: StandInPull) => {
    const range = `${pull.base.sha}...${pull.head.sha}`;
    const changed = (await git(["diff", "--name-status", range]))
      .split("\n")
      .filter(Boolean);
    return Promise.all(
      changed.map(async (line) => {
        const [status = "M", filename = ""] = line.split("\t");
        const diff = await git(["diff", range, "--", filename]);
        const [added = "0", deleted = "0"] = (
          await git(["diff", "--numstat", range, "--", filename])
        ).split("\t");
        return {
          filename,
          status:
            status === "A" ? "added" : status === "D" ? "removed" : "modified",
          additions: Number(added),
          deletions: Number(deleted),
          patch: diff.slice(diff.indexOf("@@")),
        };
      }),
    );
  };

  const routes: Route[] = [
    {
      method: "GET",
      pattern: new RegExp(`^${repo}$`),
      credential: "installation",
      handle: () => ({
        body: {
          id: 1,
          full_name: fullName,
          name,
          owner: { login: owner },
          private: true,
          default_branch: "main",
          html_url: web(),
          clone_url: `${web()}.git`,
        },
      }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls$`),
      credential: "installation",
      handle: ({ query }) => {
        const state = query.get("state") ?? "open";
        const listed = [...pulls.values()]
          .filter((pull) => state === "all" || pull.state === state)
          .sort((left, right) =>
            query.get("direction") === "asc"
              ? left.updatedAt.localeCompare(right.updatedAt)
              : right.updatedAt.localeCompare(left.updatedAt),
          );
        return { body: page(listed, query).map(restPull) };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)$`),
      credential: "installation",
      handle: ({ match }) => ({ body: restPull(pullOf(match[1])) }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)/files$`),
      credential: "installation",
      handle: async ({ match }) => ({ body: await filesOf(pullOf(match[1])) }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)/reviews$`),
      credential: "installation",
      handle: ({ match, query }) => {
        const number = pullOf(match[1]).number;
        return {
          body: page(
            reviews.filter((review) => review.number === number),
            query,
          ).map(
            ({ comments: _comments, number: _number, ...review }) => review,
          ),
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)/reviews$`),
      credential: "installation",
      handle: ({ match, body }) => {
        const pull = pullOf(match[1]);
        const id = args.ids.next++;
        const comments = Array.isArray(body.comments)
          ? body.comments.map(json).map((comment) => ({
              path: String(comment.path),
              ...(typeof comment.line === "number"
                ? { line: comment.line }
                : {}),
              ...(typeof comment.side === "string"
                ? { side: comment.side }
                : {}),
              body: String(comment.body),
            }))
          : [];
        const review: StandInReview = {
          id,
          number: pull.number,
          user: bot,
          body: typeof body.body === "string" ? body.body : "",
          state:
            body.event === "REQUEST_CHANGES"
              ? "CHANGES_REQUESTED"
              : body.event === "APPROVE"
                ? "APPROVED"
                : "COMMENTED",
          // Missing stays missing: a poster that drops it shows.
          commit_id: typeof body.commit_id === "string" ? body.commit_id : null,
          submitted_at: githubTime(),
          html_url: `${web()}/pull/${pull.number}#pullrequestreview-${id}`,
          pull_request_url: `${args.origin.url}${repo}/pulls/${pull.number}`,
          comments,
        };
        reviews.push(review);
        for (const comment of comments) {
          const at = githubTime();
          const commentId = args.ids.next++;
          reviewComments.push({
            id: commentId,
            number: pull.number,
            user: bot,
            body: comment.body,
            path: comment.path,
            line: comment.line ?? null,
            created_at: at,
            updated_at: at,
            html_url: `${web()}/pull/${pull.number}#discussion_r${commentId}`,
          });
        }
        const { comments: _comments, number: _number, ...answer } = review;
        return { body: answer };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/(\\d+)/comments$`),
      credential: "installation",
      handle: ({ match, query }) => {
        const number = pullOf(match[1]).number;
        return {
          body: page(
            reviewComments.filter((comment) => comment.number === number),
            query,
          ).map((comment) => restComment(comment, "review")),
        };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/pulls/comments$`),
      credential: "installation",
      handle: ({ query }) => ({
        body: page(sinceSorted(reviewComments, query), query).map((comment) =>
          restComment(comment, "review"),
        ),
      }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/comments$`),
      credential: "installation",
      handle: ({ query }) => ({
        body: page(sinceSorted(issueComments, query), query).map((comment) =>
          restComment(comment, "issue"),
        ),
      }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/(\\d+)$`),
      credential: "installation",
      handle: ({ match }) => {
        const pull = pullOf(match[1]);
        return {
          body: {
            number: pull.number,
            title: pull.title,
            state: pull.state,
            html_url: `${web()}/pull/${pull.number}`,
            pull_request: {
              url: `${args.origin.url}${repo}/pulls/${pull.number}`,
            },
          },
        };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/comments$`),
      credential: "installation",
      handle: ({ match, query }) => {
        const number = pullOf(match[1]).number;
        return {
          body: page(
            issueComments.filter((comment) => comment.number === number),
            query,
          ).map((comment) => restComment(comment, "issue")),
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/issues/(\\d+)/comments$`),
      credential: "installation",
      handle: ({ match, body }) => {
        const pull = pullOf(match[1]);
        const comment = addComment({
          number: pull.number,
          body: String(body.body ?? ""),
          author: bot,
        });
        return { status: 201, body: restComment(comment, "issue") };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^${repo}/check-runs$`),
      credential: "installation",
      handle: ({ body }) => {
        const id = args.ids.next++;
        const run: StandInCheckRun = {
          id,
          name: String(body.name ?? ""),
          head_sha: String(body.head_sha ?? ""),
          external_id:
            typeof body.external_id === "string" ? body.external_id : null,
          status: typeof body.status === "string" ? body.status : "queued",
          conclusion:
            typeof body.conclusion === "string" ? body.conclusion : null,
          output: body.output ?? null,
          app: { slug: args.appSlug },
          html_url: `${web()}/runs/${id}`,
        };
        checkRuns.push(run);
        return { status: 201, body: run };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^${repo}/commits/([0-9a-f]{40})/check-runs$`),
      credential: "installation",
      handle: ({ match, query }) => {
        const name = query.get("check_name");
        const runs = checkRuns.filter(
          (run) =>
            run.head_sha === match[1] && (name === null || run.name === name),
        );
        return {
          body: { total_count: runs.length, check_runs: page(runs, query) },
        };
      },
    },
  ];

  /** Comments changed at or after `since`, in GitHub's order for the list. */
  function sinceSorted(
    comments: readonly StandInComment[],
    query: URLSearchParams,
  ): StandInComment[] {
    const since = query.get("since");
    return comments
      .filter((comment) => since === null || comment.updated_at >= since)
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at));
  }

  function addComment(comment: {
    number: number;
    body: string;
    author: GithubActor;
  }): StandInComment {
    const at = githubTime();
    const id = args.ids.next++;
    const added: StandInComment = {
      id,
      number: comment.number,
      user: comment.author,
      body: comment.body,
      created_at: at,
      updated_at: at,
      html_url: `${web()}/pull/${comment.number}#issuecomment-${id}`,
    };
    issueComments.push(added);
    return added;
  }

  const handle: StandInRepository = {
    fullName,
    gitDirectory,
    pulls,
    checkRuns,
    reviews,
    issueComments,
    reviewComments,
    writes: () =>
      args.calls.filter(
        (call) =>
          isWrite(call) &&
          (call.path.startsWith(`${repo}/`) ||
            call.path.startsWith(`/${fullName}.git/`)),
      ),
    openPullRequest: async (input) => {
      const at = githubTime();
      const pull: StandInPull = {
        number: input.number,
        title: input.title,
        body: input.body,
        state: "open",
        draft: false,
        user: input.author,
        requestedReviewers: input.reviewers ?? [],
        head: {
          sha: await git(["rev-parse", `refs/pull/${input.number}/head`]),
          ref: input.headRef,
        },
        base: { sha: await git(["rev-parse", "main"]), ref: "main" },
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        mergedAt: null,
      };
      pulls.set(input.number, pull);
      return pull;
    },
    pushed: async (input) => {
      const pull = pullOf(String(input.number));
      pull.head = {
        ...pull.head,
        sha: await git(["rev-parse", `refs/pull/${input.number}/head`]),
      };
      pull.updatedAt = githubTime();
      return pull;
    },
    close: (input) => {
      const pull = pullOf(String(input.number));
      const at = githubTime();
      pull.state = "closed";
      pull.closedAt = at;
      pull.updatedAt = at;
      return pull;
    },
    comment: addComment,
  };
  return { handle, routes };
}

class NotFound extends Error {}

/** A Git push, or the start of one. */
function isPush(call: GithubCall): boolean {
  return (
    call.path.endsWith("/git-receive-pack") ||
    call.query.service === "git-receive-pack"
  );
}

/**
 * A call that changes GitHub or tries to: every method but GET and HEAD
 * other than reads over POST (Git fetches, GraphQL queries), and pushes.
 */
function isWrite(call: GithubCall): boolean {
  return (
    isPush(call) ||
    (!["GET", "HEAD"].includes(call.method) &&
      !call.path.endsWith("/git-upload-pack") &&
      call.path !== "/graphql")
  );
}

/** Git smart HTTP for the repositories under `projectRoot`. */
function gitHttpBackend(args: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  projectRoot: string;
}): void {
  const { request, response } = args;
  const url = new URL(request.url ?? "/", "http://stand-in");
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : "";
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_PROJECT_ROOT: args.projectRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    REMOTE_USER: "x-access-token",
    REQUEST_METHOD: request.method ?? "GET",
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: header("content-type"),
  };
  if (header("content-encoding"))
    env.HTTP_CONTENT_ENCODING = header("content-encoding");
  if (header("git-protocol")) env.GIT_PROTOCOL = header("git-protocol");
  const child = spawn("git", ["http-backend"], { env });
  request.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (started) {
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const separator = line.indexOf(":");
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
      else headers[key] = value;
    }
    response.writeHead(status, headers);
    started = true;
    const rest = head.subarray(end + 4);
    if (rest.length > 0) response.write(rest);
  });
  child.stdout.on("end", () => {
    // A backend that printed no headers failed: answer rather than hang.
    if (!started) response.writeHead(500);
    response.end();
  });
  child.on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
}
