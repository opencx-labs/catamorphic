import crypto from "node:crypto";
import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { ProjectEventsService } from "../services/project-events-service.js";
import {
  WebhookMethodNotAllowedError,
  WebhookNotFoundError,
  WebhookRejectedError,
  WebhooksService,
  WebhookTooLargeError,
} from "../services/webhooks-service.js";
import { projectAdmin } from "./project-admin.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_webhooks";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const commitSha = "c".repeat(40);
const builder: Identity = {
  tenantId,
  externalUserId: "builder",
  ...projectAdmin(projectId),
};
const member: Identity = {
  tenantId,
  externalUserId: "member",
  scope: [{ kind: "workflow", projectId, name: "onGithub" }],
};
const secrets = new Map<string, string>();
let webhooks: WebhooksService;
let artifactId: string;

beforeAll(async () => {
  await migrateToLatest({ db, schema });
  await db.insertInto("tenants").values({ id: tenantId, name: "T" }).execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: tenantId, name: "P" })
    .execute();
  const artifact = await db
    .insertInto("deployment_artifacts")
    .values({
      project_id: projectId,
      commit_sha: commitSha,
      artifact_digest: "digest",
      plugin_digest: "plugins",
      runtime_version: "test",
      transform_version: "test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  artifactId = artifact.id;
  await db
    .insertInto("trigger_definition_scans")
    .values({ project_id: projectId, commit_sha: commitSha })
    .execute();
  webhooks = new WebhooksService(db, {
    events: new ProjectEventsService(db),
    secretValue: async ({ name }) => secrets.get(name),
  });
});

afterAll(async () => {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
  await db.destroy();
});

/** A deployed workflow bound to a webhook name, optionally switched on. */
async function bind(input: {
  workflowName: string;
  config: Record<string, unknown>;
  enabled: boolean;
}) {
  const definition = await db
    .insertInto("trigger_definitions")
    .values({
      project_id: projectId,
      commit_sha: commitSha,
      workflow_name: input.workflowName,
      trigger_kind: "webhook",
      config: JSON.stringify(input.config),
      input_parameters: JSON.stringify([]),
      can_suspend: false,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (!input.enabled) return;
  const enablement = await db
    .insertInto("workflow_enablements")
    .values({
      tenant_id: tenantId,
      project_id: projectId,
      workflow_name: input.workflowName,
      deployment_artifact_id: artifactId,
      commit_sha: commitSha,
      environment_name: "default",
      owner_kind: "project",
      owner_external_user_id: null,
      owner_identity: JSON.stringify(builder),
      consent_digest: "d".repeat(64),
      created_by_external_user_id: builder.externalUserId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("workflow_enablement_triggers")
    .values({
      enablement_id: enablement.id,
      trigger_definition_id: definition.id,
    })
    .execute();
}

const urlToken = (url: string) => url.split("/").at(-1) ?? "";

/** A request to a webhook URL; POST with no query unless stated. */
function receive(input: {
  name: string;
  token: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  method?: string;
  query?: Record<string, string>;
}) {
  return webhooks.receive({
    projectId,
    name: input.name,
    token: input.token,
    method: input.method ?? "POST",
    headers: input.headers ?? {},
    query: input.query ?? {},
    body: Buffer.isBuffer(input.body)
      ? input.body
      : Buffer.from(input.body ?? ""),
  });
}

async function tokenFor(name: string): Promise<string> {
  const endpoint = (await webhooks.list({ identity: builder, projectId })).find(
    (item) => item.name === name,
  );
  return urlToken(endpoint?.path ?? "");
}

async function storedPayload(receipt: { type: string } & object) {
  if (!("eventId" in receipt) || typeof receipt.eventId !== "string")
    throw new Error(`Expected an event, got ${JSON.stringify(receipt)}`);
  const event = await db
    .selectFrom("project_events")
    .select("payload")
    .where("id", "=", receipt.eventId)
    .executeTakeFirstOrThrow();
  return event.payload;
}

describe("WebhooksService", () => {
  it("lists a deployed webhook before it listens, and 404s until enabled", async () => {
    await bind({
      workflowName: "onDeploy",
      config: { name: "deploys" },
      enabled: false,
    });
    await expect(
      webhooks.list({ identity: member, projectId }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const [endpoint] = await webhooks.list({ identity: builder, projectId });
    expect(endpoint).toMatchObject({
      name: "deploys",
      workflows: ["onDeploy"],
      listening: false,
      verified: false,
    });
    expect(endpoint?.path).toMatch(
      new RegExp(`^/hooks/${projectId}/deploys/[A-Za-z0-9_-]{32}$`),
    );
    await expect(
      receive({
        name: "deploys",
        token: urlToken(endpoint?.path ?? ""),
        body: "{}",
      }),
    ).rejects.toBeInstanceOf(WebhookNotFoundError);
  });

  it("stores a request once per delivery id, parsed and without credentials", async () => {
    await bind({
      workflowName: "onPing",
      config: { name: "ping" },
      enabled: true,
    });
    const endpoint = (
      await webhooks.list({ identity: builder, projectId })
    ).find((item) => item.name === "ping");
    expect(endpoint).toMatchObject({ listening: true, workflows: ["onPing"] });
    const token = urlToken(endpoint?.path ?? "");
    await expect(
      receive({ name: "ping", token: `${token}x` }),
    ).rejects.toBeInstanceOf(WebhookNotFoundError);

    const request = {
      name: "ping",
      token,
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer secret",
        cookie: "a=b",
        "webhook-id": "delivery-1",
      },
      query: { source: "ci" },
      body: JSON.stringify({ status: "green" }),
    };
    const first = await receive(request);
    const again = await receive(request);
    expect(first).toMatchObject({ type: "event", duplicate: false });
    expect(again).toEqual({
      type: "event",
      eventId: "eventId" in first ? first.eventId : "",
      duplicate: true,
    });
    const event = await db
      .selectFrom("project_events")
      .selectAll()
      .where("id", "=", "eventId" in first ? first.eventId : "")
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      source: "webhook",
      kind: "webhook",
      external_id: "ping:delivery-1",
    });
    expect(event.payload).toEqual({
      name: "ping",
      contentType: "application/json",
      headers: {
        "content-type": "application/json",
        "webhook-id": "delivery-1",
      },
      query: { source: "ci" },
      body: { status: "green" },
    });
    // Only declared handshakes answer GET.
    await expect(
      receive({ name: "ping", token, method: "GET" }),
    ).rejects.toBeInstanceOf(WebhookMethodNotAllowedError);
  });

  it("checks the declared signature against the project secret", async () => {
    await bind({
      workflowName: "onGithub",
      config: {
        name: "github",
        verify: {
          scheme: "hmac",
          secret: "GITHUB_WEBHOOK_SECRET",
          header: "X-Hub-Signature-256",
          prefix: "sha256=",
        },
      },
      enabled: true,
    });
    const endpoint = (
      await webhooks.list({ identity: builder, projectId })
    ).find((item) => item.name === "github");
    expect(endpoint?.verified).toBe(true);
    const body = Buffer.from("action=opened&number=7");
    const signed = (key: string) =>
      `sha256=${crypto.createHmac("sha256", key).update(body).digest("hex")}`;
    const token = urlToken(endpoint?.path ?? "");
    const send = (signature?: string) =>
      receive({
        name: "github",
        token,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
        body,
      });

    await expect(send(signed("key"))).rejects.toThrow(
      "The webhook secret GITHUB_WEBHOOK_SECRET is not set",
    );
    secrets.set("GITHUB_WEBHOOK_SECRET", "key");
    await expect(send()).rejects.toBeInstanceOf(WebhookRejectedError);
    await expect(send(signed("wrong"))).rejects.toThrow(
      "Signature does not match",
    );
    expect(await storedPayload(await send(signed("key")))).toMatchObject({
      body: { action: "opened", number: "7" },
    });

    // Two workflows on one name that disagree on the settings fail closed.
    await bind({
      workflowName: "onGithubToo",
      config: { name: "github" },
      enabled: true,
    });
    await expect(send(signed("key"))).rejects.toThrow(
      "declare different settings",
    );
  });

  it("answers Slack's url_verification after checking its signature, storing nothing", async () => {
    secrets.set("SLACK_SIGNING_SECRET", "slack-key");
    await bind({
      workflowName: "onSlack",
      config: {
        name: "slack",
        verify: {
          scheme: "hmac",
          secret: "SLACK_SIGNING_SECRET",
          header: "x-slack-signature",
          prefix: "v0=",
          content: "v0:{timestamp}:{body}",
          timestamp: { header: "x-slack-request-timestamp" },
        },
        respond: [
          {
            when: { body: { type: "url_verification" } },
            echo: "body.challenge",
          },
        ],
        deliveryId: "body.event_id",
      },
      enabled: true,
    });
    const token = await tokenFor("slack");
    const post = (
      payload: object,
      key = "slack-key",
      headers: Record<string, string> = {},
    ) => {
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .createHmac("sha256", key)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
      return receive({
        name: "slack",
        token,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${signature}`,
          ...headers,
        },
        body,
      });
    };
    const before = await db
      .selectFrom("project_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    await expect(
      post({ type: "url_verification", challenge: "abc123" }),
    ).resolves.toEqual({ type: "handshake", answer: "abc123" });
    // A handshake is still a verified request.
    await expect(
      post({ type: "url_verification", challenge: "abc123" }, "wrong"),
    ).rejects.toThrow("Signature does not match");
    const after = await db
      .selectFrom("project_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));
    // Events still arrive as events.
    const callback = {
      type: "event_callback",
      event_id: "Ev0SLACK1",
      event: { type: "app_mention", text: "hi" },
    };
    const event = await post(callback);
    expect(event).toMatchObject({ type: "event", duplicate: false });
    expect(await storedPayload(event)).toMatchObject({
      body: { event: { type: "app_mention" } },
    });
    // Slack retries an event it thinks was lost with a fresh signature and
    // x-slack-retry-num; the declared delivery id stores it once.
    const retried = await post(callback, "slack-key", {
      "x-slack-retry-num": "1",
      "x-slack-retry-reason": "http_timeout",
    });
    expect(retried).toEqual({
      type: "event",
      eventId: "eventId" in event ? event.eventId : "",
      duplicate: true,
    });
    // Another event is another delivery.
    expect(await post({ ...callback, event_id: "Ev0SLACK2" })).toMatchObject({
      duplicate: false,
    });
  });

  it("answers a GET subscription handshake with its own token check", async () => {
    secrets.set("META_VERIFY_TOKEN", "meta-token");
    secrets.set("META_APP_SECRET", "meta-secret");
    await bind({
      workflowName: "onMeta",
      config: {
        name: "meta",
        verify: {
          scheme: "hmac",
          secret: "META_APP_SECRET",
          header: "x-hub-signature-256",
          prefix: "sha256=",
        },
        respond: [
          {
            when: { method: "GET", query: { "hub.mode": "subscribe" } },
            echo: "query.hub.challenge",
            token: { secret: "META_VERIFY_TOKEN", query: "hub.verify_token" },
          },
        ],
      },
      enabled: true,
    });
    const token = await tokenFor("meta");
    const subscribe = (verifyToken: string) =>
      receive({
        name: "meta",
        token,
        method: "GET",
        query: {
          "hub.mode": "subscribe",
          "hub.challenge": "1158201444",
          "hub.verify_token": verifyToken,
        },
      });
    await expect(subscribe("meta-token")).resolves.toEqual({
      type: "handshake",
      answer: "1158201444",
    });
    await expect(subscribe("guess")).rejects.toThrow("Token does not match");
  });

  it("checks a shared token and never stores it", async () => {
    secrets.set("GITLAB_TOKEN", "gitlab-token");
    await bind({
      workflowName: "onGitlab",
      config: {
        name: "gitlab",
        verify: {
          scheme: "token",
          secret: "GITLAB_TOKEN",
          header: "X-Gitlab-Token",
        },
      },
      enabled: true,
    });
    const token = await tokenFor("gitlab");
    const send = (value: string) =>
      receive({
        name: "gitlab",
        token,
        headers: {
          "content-type": "application/json",
          "x-gitlab-token": value,
          "x-gitlab-event": "Push Hook",
        },
        body: JSON.stringify({ object_kind: "push" }),
      });
    await expect(send("nope")).rejects.toThrow("Token does not match");
    expect(await storedPayload(await send("gitlab-token"))).toEqual({
      name: "gitlab",
      contentType: "application/json",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Push Hook",
      },
      query: {},
      body: { object_kind: "push" },
    });
  });

  it("caps bodies at the endpoint's limit within the host's maximum", async () => {
    await bind({
      workflowName: "onSmall",
      config: { name: "small", maxBodyBytes: 8 },
      enabled: true,
    });
    await bind({
      workflowName: "onLarge",
      config: { name: "large", maxBodyBytes: 64 * 1024 * 1024 },
      enabled: true,
    });
    const small = await tokenFor("small");
    await expect(
      receive({ name: "small", token: small, body: "12345678" }),
    ).resolves.toMatchObject({ type: "event" });
    await expect(
      receive({ name: "small", token: small, body: "123456789" }),
    ).rejects.toBeInstanceOf(WebhookTooLargeError);
    // The host's maximum (1 MiB here) wins over a larger declaration.
    await expect(
      receive({
        name: "large",
        token: await tokenFor("large"),
        body: Buffer.alloc(1024 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(WebhookTooLargeError);
  });

  it("rotates a URL: the old token stops working at once", async () => {
    const before = (await webhooks.list({ identity: builder, projectId })).find(
      (item) => item.name === "ping",
    );
    const rotated = await webhooks.rotate({
      identity: builder,
      projectId,
      name: "ping",
    });
    expect(rotated.path).not.toBe(before?.path);
    await expect(
      receive({ name: "ping", token: urlToken(before?.path ?? "") }),
    ).rejects.toBeInstanceOf(WebhookNotFoundError);
    await expect(
      receive({ name: "ping", token: urlToken(rotated.path), body: "hello" }),
    ).resolves.toMatchObject({ duplicate: false });
  });
});
