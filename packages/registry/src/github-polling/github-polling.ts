import {
  type BoundaryContext,
  type DocumentEntry,
  defineWorkflow,
  type RecordedEvent,
  type RecordedEventInput,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

// The repository this project polls, "acme/web": replace it with yours
// (owner/name), and the cursor document's name with it. Recorded events
// carry this name in `repository.full_name`, which the review workflows'
// `where` filters match.
const REPOSITORY = "acme/web";

/**
 * The project store document that keeps the cursor between polls. It must
 * stay under the folder the workflow declares in `documents` below.
 */
const CURSOR_PATH = "store/github-polling/acme-web.json";

/** Its folder: a list's prefix is a folder, never part of a name. */
const CURSOR_FOLDER = CURSOR_PATH.slice(0, CURSOR_PATH.lastIndexOf("/"));

/**
 * Pull requests read per poll, most recently updated first. GitHub's list
 * items are large (each carries both repositories), so keep a page well
 * under the connection's 1 MiB response; a full page continues on the next
 * page at the next poll.
 */
const PULL_PAGE = 20;

/** Comments read per poll, oldest change first. */
const COMMENT_PAGE = 50;

/** How long a closed pull request is remembered, to tell a reopen apart. */
const KEEP_CLOSED_DAYS = 30;

interface GithubUser {
  login: string;
  type: string;
}

/** A pull request as GitHub's REST list returns it (the fields compared). */
interface RestPull {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  html_url: string;
  draft: boolean;
  user: GithubUser;
  requested_reviewers: GithubUser[];
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

interface RestComment {
  id: number;
  body: string;
  html_url: string;
  user: GithubUser;
  created_at: string;
  updated_at: string;
}

interface RestIssueComment extends RestComment {
  issue_url: string;
}

interface RestReviewComment extends RestComment {
  pull_request_url: string;
  path: string;
  line: number | null;
}

/** What the poller remembers of a pull request. */
interface PullSnapshot {
  head: string;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  url: string;
  updatedAt: string;
  /** When it last closed: what tells one reopening from the next. */
  closedAt?: string | null;
}

/** The cursor document. */
export interface PollCursor {
  repository: string;
  /** When polling began: nothing from before it becomes an event. */
  baselineAt: string;
  pulls: {
    /** Pull requests updated at or after this were not all seen yet. */
    since: string;
    /** The list page the next poll reads, while a sweep is behind. */
    page: number;
    /** The newest change seen when the sweep began. */
    sweepTop: string;
    known: Record<string, PullSnapshot>;
  };
  issueComments: { since: string };
  reviewComments: { since: string };
}

type GithubEvent =
  | RecordedEventInput<"github.pull_request">
  | RecordedEventInput<"github.issue_comment">
  | RecordedEventInput<"github.pull_request_review_comment">;

/**
 * A list from the connection's `get` (`{ status, body, truncated? }`), or
 * why it is not one: the boundary fails and retries.
 */
function listOf<Item>(response: unknown, what: string): Item[] {
  const { status, body, truncated } = (response ?? {}) as {
    status?: number;
    body?: unknown;
    truncated?: boolean;
  };
  if (status !== 200)
    throw new Error(`GitHub answered ${status} listing ${what}`);
  if (truncated)
    throw new Error(
      `GitHub's list of ${what} exceeded one response; lower the page size`,
    );
  if (!Array.isArray(body))
    throw new Error(`GitHub did not return a list of ${what}`);
  return body as Item[];
}

/** The latest of ISO timestamps, which sort as text. */
const latest = (times: readonly string[], fallback: string) =>
  [fallback, ...times].sort().at(-1) ?? fallback;

/** The number at the end of an issue or pull request API URL. */
const numberOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/** The payload a webhook delivery of `event` would have stored. */
function delivery<Body extends object>(event: string, id: string, body: Body) {
  return {
    name: "github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": id,
    },
    query: {},
    contentType: "application/json",
    body,
  };
}

/**
 * The events a poll found and the cursor after it. Pure: everything it
 * compares comes from GitHub's REST API. The first poll records nothing and
 * remembers what exists (a baseline).
 */
export function planPoll(args: {
  cursor: PollCursor | null;
  startedAt: string;
  pulls: RestPull[];
  issueComments: RestIssueComment[];
  reviewComments: RestReviewComment[];
}): { events: GithubEvent[]; next: PollCursor } {
  const snapshot = (pull: RestPull): PullSnapshot => ({
    head: pull.head.sha,
    state: pull.state,
    draft: pull.draft,
    title: pull.title,
    url: pull.html_url,
    updatedAt: pull.updated_at,
    closedAt: pull.closed_at,
  });
  const newest = latest(
    args.pulls.map((pull) => pull.updated_at),
    args.cursor?.pulls.since ?? args.startedAt,
  );
  if (!args.cursor) {
    return {
      events: [],
      next: {
        repository: REPOSITORY,
        baselineAt: args.startedAt,
        pulls: {
          since: newest,
          page: 1,
          sweepTop: newest,
          known: Object.fromEntries(
            args.pulls.map((pull) => [String(pull.number), snapshot(pull)]),
          ),
        },
        issueComments: { since: args.startedAt },
        reviewComments: { since: args.startedAt },
      },
    };
  }
  const cursor = args.cursor;
  const known = { ...cursor.pulls.known };
  const events: GithubEvent[] = [];
  const repository = { full_name: REPOSITORY };

  // Pull requests, oldest change first: compare each with what was seen.
  const changed = args.pulls
    .filter((pull) => pull.updated_at >= cursor.pulls.since)
    .reverse();
  for (const pull of changed) {
    const before = known[String(pull.number)];
    // Ids name the change from what was remembered, never what changed
    // since: a poll that recorded and then lost its cursor write finds the
    // same change again, with the same id, however the pull request moved on.
    const recordPull = (
      action: string,
      key: string | null,
      extra: { before?: string; after?: string } = {},
    ) => {
      const eventId = `pull_request:${pull.number}:${action}${key === null ? "" : `:${key}`}`;
      events.push({
        kind: "github.pull_request",
        id: eventId,
        occurredAt: pull.updated_at,
        payload: delivery("pull_request", eventId, {
          action,
          number: pull.number,
          ...extra,
          pull_request: { ...pull, merged: pull.merged_at !== null },
          repository,
          // The REST list does not say who acted; the author stands in.
          sender: pull.user,
        }),
      });
    };
    const isNew = pull.created_at >= cursor.baselineAt;
    if (pull.state === "closed") {
      if (before?.state === "open" || (!before && isNew))
        recordPull("closed", pull.closed_at ?? pull.updated_at);
    } else if (!before) {
      // Opened since polling began; otherwise only learn its head.
      // A pull request opens once.
      if (isNew) recordPull("opened", null);
    } else if (before.state === "closed") {
      // Once per close it reopens from.
      recordPull("reopened", before.closedAt ?? before.updatedAt);
    } else {
      if (before.draft && !pull.draft)
        recordPull("ready_for_review", pull.head.sha);
      if (before.head !== pull.head.sha)
        recordPull("synchronize", pull.head.sha, {
          before: before.head,
          after: pull.head.sha,
        });
    }
    known[String(pull.number)] = snapshot(pull);
  }

  // A full page of changes may hide more on the next page: keep sweeping
  // older pages until one reaches what was already seen.
  const full =
    args.pulls.length === PULL_PAGE &&
    args.pulls.every((pull) => pull.updated_at >= cursor.pulls.since);
  const sweepTop = cursor.pulls.page === 1 ? newest : cursor.pulls.sweepTop;
  const pulls = full
    ? { since: cursor.pulls.since, page: cursor.pulls.page + 1, sweepTop }
    : { since: sweepTop, page: 1, sweepTop };

  // Comments created since polling began, by people. A comment is recorded
  // only on a pull request the poller knows: GitHub's comment lists do not
  // say whether an issue is a pull request, or its state.
  const human = (comment: RestComment) =>
    comment.user.type !== "Bot" && comment.created_at >= cursor.baselineAt;
  for (const comment of args.issueComments.filter(human)) {
    const number = numberOf(comment.issue_url);
    const pull = known[number];
    if (!pull) continue;
    const eventId = `issue_comment:${comment.id}`;
    events.push({
      kind: "github.issue_comment",
      id: eventId,
      occurredAt: comment.created_at,
      payload: delivery("issue_comment", eventId, {
        action: "created",
        issue: {
          number: Number(number),
          title: pull.title,
          state: pull.state,
          html_url: pull.url,
          pull_request: {
            url: `https://api.github.com/repos/${REPOSITORY}/pulls/${number}`,
          },
        },
        comment: {
          id: comment.id,
          body: comment.body,
          html_url: comment.html_url,
          user: comment.user,
        },
        repository,
        sender: comment.user,
      }),
    });
  }
  for (const comment of args.reviewComments.filter(human)) {
    const number = numberOf(comment.pull_request_url);
    const pull = known[number];
    if (!pull) continue;
    const eventId = `pull_request_review_comment:${comment.id}`;
    events.push({
      kind: "github.pull_request_review_comment",
      id: eventId,
      occurredAt: comment.created_at,
      payload: delivery("pull_request_review_comment", eventId, {
        action: "created",
        pull_request: {
          number: Number(number),
          title: pull.title,
          state: pull.state,
          html_url: pull.url,
        },
        comment: {
          id: comment.id,
          body: comment.body,
          html_url: comment.html_url,
          path: comment.path,
          line: comment.line,
          user: comment.user,
        },
        repository,
        sender: comment.user,
      }),
    });
  }

  // Forget pull requests closed long ago.
  const forgetBefore = new Date(
    Date.parse(args.startedAt) - KEEP_CLOSED_DAYS * 86_400_000,
  ).toISOString();
  for (const [number, pull] of Object.entries(known))
    if (pull.state === "closed" && pull.updatedAt < forgetBefore)
      delete known[number];

  return {
    events,
    next: {
      ...cursor,
      pulls: { ...pulls, known },
      // While a sweep is behind, a comment may be on a pull request it has
      // not reached yet, which was skipped: read the same comments again
      // until the sweep ends (the ones recorded are not recorded twice).
      issueComments: full
        ? cursor.issueComments
        : {
            since: latest(
              args.issueComments.map((comment) => comment.updated_at),
              cursor.issueComments.since,
            ),
          },
      reviewComments: full
        ? cursor.reviewComments
        : {
            since: latest(
              args.reviewComments.map((comment) => comment.updated_at),
              cursor.reviewComments.since,
            ),
          },
    },
  };
}

interface Poll {
  cursor: PollCursor | null;
  /** The cursor document's version; 0 before the first poll. */
  version: number;
  startedAt: string;
}

/** @displayname Poll GitHub */
export const pollGithub = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["events:write"],
  // The cursor's folder: the only store paths its runs reach (ADR 0335).
  documents: [{ path: "store/github-polling/", access: "write" }],
  // Every minute. Each poll is a run: shorter intervals cost runs and
  // GitHub requests; longer ones delay reviews by up to the interval.
  triggers: [trigger("schedule", { cron: "* * * * *", timezone: "UTC" })],
  connections: [
    { alias: "github", principal: "service", capabilities: ["get"] },
  ],
  steps: [
    /** @displayname Find the cursor */
    defineBoundary({
      run: ({ documents }: BoundaryContext<TriggerPayload<"schedule">>) =>
        documents.list({ prefix: CURSOR_FOLDER, source: "store" }),
    }),
    /** @displayname Read the cursor */
    defineBoundary({
      run: ({ input, documents }: BoundaryContext<DocumentEntry[]>) =>
        input.some((entry) => entry.path === CURSOR_PATH)
          ? documents.read({ path: CURSOR_PATH })
          : { version: 0 },
    }),
    /** @displayname List pull requests */
    defineBoundary({
      run: ({
        input,
        connections,
      }: BoundaryContext<{ version?: number; text?: string }>) => {
        const poll: Poll = {
          cursor: input.text ? (JSON.parse(input.text) as PollCursor) : null,
          version: input.version ?? 0,
          startedAt: new Date().toISOString(),
        };
        return connections.github.get(
          {
            path: `/repos/${REPOSITORY}/pulls`,
            query: {
              state: "all",
              sort: "updated",
              direction: "desc",
              per_page: String(PULL_PAGE),
              page: String(poll.cursor?.pulls.page ?? 1),
            },
          },
          { state: poll },
        );
      },
    }),
    /** @displayname List conversation comments */
    defineBoundary({
      run: ({
        input,
        connections,
      }: BoundaryContext<{ result: unknown; state: Poll }>) => {
        const poll = input.state;
        const pulls = listOf<RestPull>(input.result, "pull requests");
        return connections.github.get(
          {
            path: `/repos/${REPOSITORY}/issues/comments`,
            query: {
              since: poll.cursor?.issueComments.since ?? poll.startedAt,
              sort: "updated",
              direction: "asc",
              per_page: String(COMMENT_PAGE),
            },
          },
          { state: { poll, pulls } },
        );
      },
    }),
    /** @displayname List review comments */
    defineBoundary({
      run: ({
        input,
        connections,
      }: BoundaryContext<{
        result: unknown;
        state: { poll: Poll; pulls: RestPull[] };
      }>) => {
        const { poll } = input.state;
        const issueComments = listOf<RestIssueComment>(
          input.result,
          "comments",
        );
        return connections.github.get(
          {
            path: `/repos/${REPOSITORY}/pulls/comments`,
            query: {
              since: poll.cursor?.reviewComments.since ?? poll.startedAt,
              sort: "updated",
              direction: "asc",
              per_page: String(COMMENT_PAGE),
            },
          },
          { state: { ...input.state, issueComments } },
        );
      },
    }),
    /** @displayname Record what changed */
    defineBoundary({
      run: ({
        input,
        host,
      }: BoundaryContext<{
        result: unknown;
        state: {
          poll: Poll;
          pulls: RestPull[];
          issueComments: RestIssueComment[];
        };
      }>) => {
        const { poll, pulls, issueComments } = input.state;
        const { events, next } = planPoll({
          cursor: poll.cursor,
          startedAt: poll.startedAt,
          pulls,
          issueComments,
          reviewComments: listOf<RestReviewComment>(
            input.result,
            "review comments",
          ),
        });
        const state = { next, version: poll.version };
        const none: { events: RecordedEvent[] } = { events: [] };
        return events.length > 0
          ? host["catamorphic.events"].record({ events }, { state })
          : { result: none, state };
      },
    }),
    /** @displayname Advance the cursor */
    defineBoundary({
      run: ({
        input,
        documents,
      }: BoundaryContext<{
        result: { events: { created: boolean }[] };
        state: { next: PollCursor; version: number };
      }>) =>
        // A poll that overlapped another fails here instead of moving the
        // cursor back; the next poll records anything it missed.
        documents.write(
          {
            path: CURSOR_PATH,
            text: JSON.stringify(input.state.next),
            contentType: "application/json",
            ifVersion: input.state.version,
          },
          {
            state: {
              recorded: input.result.events.filter((event) => event.created)
                .length,
            },
          },
        ),
    }),
    /** @displayname Report the poll */
    defineBoundary({
      run: ({
        input,
      }: BoundaryContext<{
        result: DocumentEntry;
        state: { recorded: number };
      }>) => ({
        recorded: input.state.recorded,
        cursorVersion: input.result.version ?? 0,
      }),
    }),
  ],
}));
