import type {
  CatamorphicCore,
  ProjectEventSourceProvider,
} from "@catamorphic/core";
import type { Json, JsonObject } from "@catamorphic/db";
import type { GithubRepositoryEvent } from "@catamorphic/github";
import { GithubApi } from "@catamorphic/github";
import type { GithubConnectionProvider } from "@catamorphic/server-sdk";

/** The webhook name the project's GitHub trigger library binds. */
export const GITHUB_WEBHOOK_NAME = "github";

/**
 * GitHub for a desktop without a public webhook URL (ADR 0177). A session
 * watcher that names this source polls the project's repository with the
 * person's GitHub connection and records each new activity as the Project
 * Event a signed delivery to the project's `github` webhook would have
 * become: `x-github-event` and `x-github-delivery` headers, and a body in
 * the webhook payload's shape. The same trigger library (`.work/triggers/
 * github.ts` on `trigger("webhook", { name: "github" })`) and `where`
 * filters then match on the desktop and on a server. The host fetched the
 * event itself, so it carries `hostVerified: true` instead of a signature.
 */
export function githubPollingEventSource(args: {
  core: () => CatamorphicCore;
  provider: GithubConnectionProvider;
}): ProjectEventSourceProvider {
  const observe = (input: {
    identity: { tenantId: string; externalUserId: string };
    projectId: string;
    signal: AbortSignal;
  }) =>
    args.core().codeHosts.withOrigin({
      identity: input.identity,
      projectId: input.projectId,
      principal: "either",
      capability: "watching repository events",
      use: async ({ provider, credential, remoteUrl }) => {
        if (provider.kind !== args.provider.kind)
          throw new Error("This project's repository is not on GitHub");
        const repository = args.provider.repositoryOf(remoteUrl);
        const token = await args.provider.accessToken({
          material: credential.material,
          repository,
        });
        const api = new GithubApi(token, {
          fetch: args.provider.api.fetch,
          baseUrl: args.provider.api.baseUrl,
          signal: input.signal,
        });
        const fullName = `${repository.owner}/${repository.name}`;
        return {
          repository,
          // Newest first.
          events: await api.listRepositoryWatchEvents(fullName),
        };
      },
    });

  return {
    kind: "github",
    eventKinds: ["webhook"],
    start: async ({ identity, projectId, signal }) => {
      // Reading the repository checks access now; what it shows already is
      // where this watcher starts.
      const { events } = await observe({ identity, projectId, signal });
      return {
        cursor: toJson(
          planPoll({ cursor: startCursor(new Date()), events }).cursor,
        ),
      };
    },
    poll: async ({ monitor, identity, signal }) => {
      const { events, repository } = await observe({
        identity,
        projectId: monitor.projectId,
        signal,
      });
      const plan = planPoll({
        cursor: parsePollCursor(monitor.cursor) ?? startCursor(new Date()),
        events,
      });
      for (const { event, action } of plan.record) {
        await args.core().projectEvents.append({
          projectId: monitor.projectId,
          source: "webhook",
          kind: "webhook",
          externalId: `${GITHUB_WEBHOOK_NAME}:${event.id}`,
          occurredAt: event.createdAt,
          payload: githubWebhookEvent({ event, repository, action }),
        });
      }
      return { cursor: toJson(plan.cursor) };
    },
  };
}

/**
 * Where a GitHub watcher is (ADR 0177). Polled activity has no stable order
 * (snapshot ids change with every update, and the Events API delivers late),
 * so the watcher remembers what it has seen rather than a position, never
 * reaches back before it started, and remembers each recent pull request's
 * head and state to tell a push from a comment.
 */
export interface GithubPollCursor {
  /** When watching started: older activity is never recorded. */
  since: string;
  /** Recently seen activity ids, newest first. */
  seen: string[];
  /** Recent pull requests by id: their head commit and state. */
  pulls: Record<string, { number: number; head: string; state: string }>;
  /** Recently recorded pull request transitions, so each is recorded once. */
  transitions: string[];
}

const SEEN_LIMIT = 2_000;
const PULLS_LIMIT = 200;
const TRANSITIONS_LIMIT = 500;

function startCursor(now: Date): GithubPollCursor {
  return { since: now.toISOString(), seen: [], pulls: {}, transitions: [] };
}

/**
 * What a poll records, oldest first, and the cursor after it. Pull request
 * snapshots become the transition their change implies (`opened`, `closed`,
 * `reopened`, `synchronize` on a new head); a snapshot that says only that
 * something else changed (a comment, a label) records nothing, and a
 * transition the Events API also reports is recorded once.
 */
export function planPoll(input: {
  cursor: GithubPollCursor;
  events: readonly GithubRepositoryEvent[];
}): {
  record: Array<{ event: GithubRepositoryEvent; action?: string }>;
  cursor: GithubPollCursor;
} {
  const seen = new Set(input.cursor.seen);
  const pulls = { ...input.cursor.pulls };
  const transitions = new Set(input.cursor.transitions);
  const recorded: Array<{ event: GithubRepositoryEvent; action?: string }> = [];
  // Oldest first, so replay reads in order.
  for (const event of [...input.events].reverse()) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const payload = record(event.payload) ?? {};
    const pull = record(payload.pull_request);
    if (event.type === "PullRequestEvent" && payload.action === "updated") {
      if (!pull) continue;
      const id = String(pull.id ?? "");
      const number = Number(pull.number ?? payload.number);
      const head = String(record(pull.head)?.sha ?? "");
      const state = String(pull.state ?? "");
      const before = pulls[id];
      pulls[id] = { number, head, state };
      const created =
        typeof pull.created_at === "string" ? pull.created_at : "";
      const action = !before
        ? created >= input.cursor.since
          ? state === "closed"
            ? "closed"
            : "opened"
          : undefined
        : before.state !== "closed" && state === "closed"
          ? "closed"
          : before.state === "closed" && state !== "closed"
            ? "reopened"
            : state !== "closed" && head && head !== before.head
              ? "synchronize"
              : undefined;
      if (!action) continue;
      const key = transitionKey({ number, action, head });
      if (transitions.has(key) || reportedByEvents(input.events, key)) continue;
      transitions.add(key);
      recorded.push({
        event: {
          ...event,
          id: `pull_request:${id}:${action}:${action === "synchronize" ? head : event.createdAt}`,
        },
        action,
      });
      continue;
    }
    if (event.createdAt < input.cursor.since) continue;
    if (event.type === "PullRequestEvent" && pull) {
      const action = typeof payload.action === "string" ? payload.action : "";
      const key = transitionKey({
        number: Number(pull.number ?? payload.number),
        action,
        head: String(record(pull.head)?.sha ?? ""),
      });
      if (transitions.has(key)) continue;
      transitions.add(key);
    }
    recorded.push({ event });
  }
  const recent = input.events.map((event) => event.id);
  return {
    record: recorded,
    cursor: {
      since: input.cursor.since,
      seen: [...new Set([...recent, ...input.cursor.seen])].slice(
        0,
        SEEN_LIMIT,
      ),
      pulls: Object.fromEntries(Object.entries(pulls).slice(-PULLS_LIMIT)),
      transitions: [...transitions].slice(-TRANSITIONS_LIMIT),
    },
  };
}

/** A pull request transition: a push names its head, the rest do not. */
function transitionKey(input: {
  number: number;
  action: string;
  head: string;
}): string {
  return `${input.number}:${input.action}${input.action === "synchronize" ? `:${input.head}` : ""}`;
}

/** Whether the Events API reports this transition in the same listing. */
function reportedByEvents(
  events: readonly GithubRepositoryEvent[],
  key: string,
): boolean {
  return events.some((event) => {
    if (event.type !== "PullRequestEvent") return false;
    const payload = record(event.payload) ?? {};
    if (payload.action === "updated") return false;
    const pull = record(payload.pull_request);
    return (
      transitionKey({
        number: Number(pull?.number ?? payload.number),
        action: typeof payload.action === "string" ? payload.action : "",
        head: String(record(pull?.head)?.sha ?? ""),
      }) === key
    );
  });
}

function parsePollCursor(value: Json | null): GithubPollCursor | null {
  const cursor = record(value);
  if (!cursor || typeof cursor.since !== "string") return null;
  const strings = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string")
      : [];
  const pulls: GithubPollCursor["pulls"] = {};
  for (const [id, pull] of Object.entries(record(cursor.pulls) ?? {})) {
    const entry = record(pull);
    if (
      entry &&
      typeof entry.number === "number" &&
      typeof entry.head === "string" &&
      typeof entry.state === "string"
    )
      pulls[id] = {
        number: entry.number,
        head: entry.head,
        state: entry.state,
      };
  }
  return {
    since: cursor.since,
    seen: strings(cursor.seen),
    pulls,
    transitions: strings(cursor.transitions),
  };
}

/**
 * One polled GitHub activity as a stored `github` webhook request. Events
 * API payloads already carry the webhook's `action`, `pull_request`,
 * `review`, `comment`, and `issue`; snapshots of pull requests, checks, and
 * workflow runs get the webhook action their state implies.
 */
export function githubWebhookEvent(args: {
  event: GithubRepositoryEvent;
  repository: { owner: string; name: string };
  /** The transition a pull request snapshot stands for. */
  action?: string;
}): JsonObject {
  const event = webhookEventName(args.event.type);
  const payload = record(args.event.payload) ?? {};
  const pullRequest = record(payload.pull_request);
  const body: Record<string, unknown> = {
    ...payload,
    ...(pullRequest
      ? {
          pull_request: {
            ...pullRequest,
            merged:
              typeof pullRequest.merged === "boolean"
                ? pullRequest.merged
                : pullRequest.merged_at !== null &&
                  pullRequest.merged_at !== undefined,
          },
        }
      : {}),
    repository: {
      ...record(payload.repository),
      full_name: `${args.repository.owner}/${args.repository.name}`,
      name: args.repository.name,
      owner: { login: args.repository.owner },
    },
    ...(args.event.actor ? { sender: { login: args.event.actor } } : {}),
  };
  const action = args.action ?? webhookAction({ event, payload });
  if (action) body.action = action;
  return {
    name: GITHUB_WEBHOOK_NAME,
    headers: {
      "content-type": "application/json",
      "user-agent": "Work-Desktop-GitHub-Poller",
      "x-github-event": event,
      "x-github-delivery": args.event.id,
    },
    query: {},
    contentType: "application/json",
    body: toJson(body),
    hostVerified: true,
  };
}

/** `PullRequestReviewEvent` → `pull_request_review`, as webhooks name it. */
export function webhookEventName(eventType: string): string {
  return (
    eventType
      .replace(/Event$/, "")
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .toLowerCase() || "event"
  );
}

function webhookAction(args: {
  event: string;
  payload: Record<string, unknown>;
}): string | undefined {
  const action =
    typeof args.payload.action === "string" ? args.payload.action : undefined;
  switch (args.event) {
    case "check_run":
      return action === "completed" ? "completed" : "created";
    case "check_suite":
      return action === "completed" ? "completed" : "requested";
    case "workflow_run":
      return action === "queued" ? "requested" : action;
    default:
      return action;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
}

function toJson(value: unknown): Json {
  const json: Json = JSON.parse(JSON.stringify(value));
  return json;
}
