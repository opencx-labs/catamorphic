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
      // Reading the repository checks access now, and the newest event is
      // where this watcher starts.
      const { events } = await observe({ identity, projectId, signal });
      return { cursor: events[0] ? { externalId: events[0].id } : null };
    },
    poll: async ({ monitor, identity, signal }) => {
      const after = cursorExternalId(monitor.cursor);
      const { events, repository } = await observe({
        identity,
        projectId: monitor.projectId,
        signal,
      });
      const seen = after ? events.findIndex((event) => event.id === after) : -1;
      const unseen = after && seen >= 0 ? events.slice(0, seen) : events;
      // Append oldest first, so replay reads in order.
      for (const event of [...unseen].reverse()) {
        await args.core().projectEvents.append({
          projectId: monitor.projectId,
          source: "webhook",
          kind: "webhook",
          externalId: `${GITHUB_WEBHOOK_NAME}:${event.id}`,
          occurredAt: event.createdAt,
          payload: githubWebhookEvent({ event, repository }),
        });
      }
      return {
        cursor: events[0] ? { externalId: events[0].id } : monitor.cursor,
      };
    },
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
  const action = webhookAction({ event, payload, pullRequest });
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
  pullRequest: Record<string, unknown> | undefined;
}): string | undefined {
  const action =
    typeof args.payload.action === "string" ? args.payload.action : undefined;
  switch (args.event) {
    case "pull_request":
      // A snapshot says only that the pull request changed.
      if (action !== "updated") return action;
      if (args.pullRequest?.state === "closed") return "closed";
      return args.pullRequest?.created_at === args.pullRequest?.updated_at
        ? "opened"
        : "synchronize";
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

function cursorExternalId(cursor: Json | null): string | null {
  const value = record(cursor);
  return typeof value?.externalId === "string" ? value.externalId : null;
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
