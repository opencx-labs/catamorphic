import type { CatamorphicCore, CodeHostCredential } from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import { matchesAllWhere } from "@catamorphic/parser";
import { webhook } from "@catamorphic/server-sdk";
import { describe, expect, it, vi } from "vitest";
import { desktopGithubProvider } from "./github.js";
import {
  githubPollingEventSource,
  githubWebhookEvent,
  webhookEventName,
} from "./github-events.js";

/** The filters of the GitHub trigger library in the writing-workflows skill. */
const PULL_REQUEST = {
  payload: { headers: { "x-github-event": "pull_request" } },
};
const ISSUE_COMMENT = {
  payload: {
    headers: { "x-github-event": "issue_comment" },
    body: { action: "created" },
  },
};
const MERGED = {
  payload: { body: { action: "closed", pull_request: { merged: true } } },
};

/** What the project-event dispatcher hands a trigger (ADR 0171). */
function envelope(payload: Json) {
  return {
    id: crypto.randomUUID(),
    sequence: 1,
    projectId: crypto.randomUUID(),
    source: "webhook",
    kind: "webhook",
    externalId: "github:1",
    occurredAt: "2026-09-27T00:00:00.000Z",
    receivedAt: "2026-09-27T00:00:01.000Z",
    payload,
  };
}

const repository = { owner: "octo", name: "hello" };

describe("the desktop's GitHub poller (ADR 0177)", () => {
  it("records pull request snapshots as github webhook deliveries the trigger library matches", () => {
    const merged = envelope(
      githubWebhookEvent({
        repository,
        event: {
          id: "pull_request:9:2026-09-27T00:00:00Z",
          type: "PullRequestEvent",
          actor: "mona",
          createdAt: "2026-09-27T00:00:00Z",
          payload: {
            action: "updated",
            number: 9,
            pull_request: {
              number: 9,
              title: "Fix",
              html_url: "https://github.com/octo/hello/pull/9",
              state: "closed",
              merged_at: "2026-09-27T00:00:00Z",
              created_at: "2026-09-26T00:00:00Z",
              updated_at: "2026-09-27T00:00:00Z",
              draft: false,
            },
          },
        },
      }),
    );
    // The same kind, name, and shape a signed delivery has.
    expect(webhook.validatePayload(merged)).toMatchObject({ ok: true });
    expect(
      webhook.matches?.({ config: { name: "github" }, payload: merged }),
    ).toBe(true);
    expect(merged.payload).toMatchObject({
      name: "github",
      hostVerified: true,
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "pull_request:9:2026-09-27T00:00:00Z",
      },
      body: {
        action: "closed",
        number: 9,
        pull_request: { merged: true, title: "Fix" },
        repository: { full_name: "octo/hello" },
        sender: { login: "mona" },
      },
    });
    expect(matchesAllWhere([PULL_REQUEST, MERGED], merged)).toBe(true);
    expect(matchesAllWhere([ISSUE_COMMENT], merged)).toBe(false);

    const opened = envelope(
      githubWebhookEvent({
        repository,
        event: {
          id: "pull_request:10:t",
          type: "PullRequestEvent",
          actor: null,
          createdAt: "2026-09-27T00:00:00Z",
          payload: {
            action: "updated",
            pull_request: {
              state: "open",
              merged_at: null,
              created_at: "2026-09-27T00:00:00Z",
              updated_at: "2026-09-27T00:00:00Z",
            },
          },
        },
      }),
    );
    expect(opened.payload).toMatchObject({
      body: { action: "opened", pull_request: { merged: false } },
    });
    expect(matchesAllWhere([PULL_REQUEST, MERGED], opened)).toBe(false);
  });

  it("keeps Events API payloads as GitHub sent them", () => {
    const comment = envelope(
      githubWebhookEvent({
        repository,
        event: {
          id: "123",
          type: "IssueCommentEvent",
          actor: "mona",
          createdAt: "2026-09-27T00:00:00Z",
          payload: {
            action: "created",
            issue: { number: 4, title: "Bug" },
            comment: { body: "@work look", user: { login: "mona" } },
          },
        },
      }),
    );
    expect(matchesAllWhere([ISSUE_COMMENT], comment)).toBe(true);
    expect(webhookEventName("PullRequestReviewCommentEvent")).toBe(
      "pull_request_review_comment",
    );
    expect(webhookEventName("CheckRunEvent")).toBe("check_run");
  });

  it("starts at the newest activity and appends only what came after, oldest first", async () => {
    let events: Array<Record<string, unknown>> = [
      {
        id: "e2",
        type: "IssueCommentEvent",
        actor: { login: "mona" },
        created_at: "2026-09-27T00:00:02Z",
        payload: { action: "created", comment: { body: "two" } },
      },
    ];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname === "/user")
        return Response.json({
          login: "mona",
          id: 3,
          avatar_url: "",
          name: null,
        });
      if (url.pathname === "/repos/octo/hello/events")
        return Response.json(events);
      // Pulls, runs, and checks are optional slices.
      return Response.json({ message: "Not Found" }, { status: 404 });
    });
    const provider = desktopGithubProvider({ fetch: fetchImpl });
    const authorized = await provider.authorizeUser({
      tokens: {
        accessToken: "ghu_member",
        expiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      },
    });
    const credential: CodeHostCredential = {
      connection: { id: "c", revision: 1 },
      principalKind: "member",
      account: authorized.account ?? {},
      material: authorized.material,
    };
    const appended: Array<Record<string, unknown>> = [];
    const core = {
      codeHosts: {
        withOrigin: async ({
          use,
        }: {
          use: (input: unknown) => Promise<unknown>;
        }) =>
          use({
            provider: { kind: "github" },
            credential,
            remoteUrl: "https://github.com/octo/hello.git",
          }),
      },
      projectEvents: {
        append: async (event: Record<string, unknown>) => {
          appended.push(event);
          return { created: true };
        },
      },
    } as unknown as CatamorphicCore;
    const source = githubPollingEventSource({ core: () => core, provider });
    expect(source.eventKinds).toEqual(["webhook"]);
    const identity = { tenantId: "t", externalUserId: "desktop-user" };
    const started = await source.start?.({
      identity,
      projectId: "p",
      config: {},
      signal: AbortSignal.timeout(5_000),
    });
    expect(started?.cursor).toEqual({ externalId: "e2" });

    events = [
      {
        id: "e4",
        type: "IssueCommentEvent",
        actor: { login: "mona" },
        created_at: "2026-09-27T00:00:04Z",
        payload: { action: "created", comment: { body: "four" } },
      },
      {
        id: "e3",
        type: "PushEvent",
        actor: { login: "mona" },
        created_at: "2026-09-27T00:00:03Z",
        payload: { ref: "refs/heads/main" },
      },
      ...events,
    ];
    const polled = await source.poll({
      identity,
      signal: AbortSignal.timeout(5_000),
      monitor: {
        id: "m",
        projectId: "p",
        sourceKind: "github",
        sourceKey: "p",
        ownerExternalUserId: "desktop-user",
        placement: "local",
        config: {},
        cursor: started?.cursor ?? null,
        pollIntervalSeconds: 30,
        leaseToken: "l",
      },
    });
    expect(polled.cursor).toEqual({ externalId: "e4" });
    expect(appended.map((event) => event.externalId)).toEqual([
      "github:e3",
      "github:e4",
    ]);
    expect(appended[0]).toMatchObject({
      source: "webhook",
      kind: "webhook",
      payload: { headers: { "x-github-event": "push" }, hostVerified: true },
    });
    // The member's own token read the repository.
    const eventsCall = fetchImpl.mock.calls.find(([input]) =>
      String(input).includes("/repos/octo/hello/events"),
    );
    expect(eventsCall).toBeDefined();
  });
});
