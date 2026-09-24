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
  WebhookNotFoundError,
  WebhookRejectedError,
  WebhooksService,
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
      environment_name: "local",
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
      webhooks.ingest({
        projectId,
        name: "deploys",
        token: urlToken(endpoint?.path ?? ""),
        headers: {},
        body: Buffer.from("{}"),
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
      webhooks.ingest({
        projectId,
        name: "ping",
        token: `${token}x`,
        headers: {},
        body: Buffer.from(""),
      }),
    ).rejects.toBeInstanceOf(WebhookNotFoundError);

    const request = {
      projectId,
      name: "ping",
      token,
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer secret",
        cookie: "a=b",
        "webhook-id": "delivery-1",
      },
      body: Buffer.from(JSON.stringify({ status: "green" })),
    };
    const first = await webhooks.ingest(request);
    const again = await webhooks.ingest(request);
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ eventId: first.eventId, duplicate: true });
    const event = await db
      .selectFrom("project_events")
      .selectAll()
      .where("id", "=", first.eventId)
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
      body: { status: "green" },
    });
  });

  it("checks the declared signature against the project secret", async () => {
    await bind({
      workflowName: "onGithub",
      config: {
        name: "github",
        verify: {
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
    const send = (signature?: string) =>
      webhooks.ingest({
        projectId,
        name: "github",
        token: urlToken(endpoint?.path ?? ""),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
        body,
      });

    await expect(send(signed("key"))).rejects.toThrow(
      "The signing secret GITHUB_WEBHOOK_SECRET is not set",
    );
    secrets.set("GITHUB_WEBHOOK_SECRET", "key");
    await expect(send()).rejects.toBeInstanceOf(WebhookRejectedError);
    await expect(send(signed("wrong"))).rejects.toThrow(
      "Signature does not match",
    );
    const accepted = await send(signed("key"));
    const event = await db
      .selectFrom("project_events")
      .select("payload")
      .where("id", "=", accepted.eventId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      body: { action: "opened", number: "7" },
    });

    // Two workflows on one name that disagree on the check fail closed.
    await bind({
      workflowName: "onGithubToo",
      config: { name: "github" },
      enabled: true,
    });
    await expect(send(signed("key"))).rejects.toThrow(
      "declare different signature checks",
    );
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
      webhooks.ingest({
        projectId,
        name: "ping",
        token: urlToken(before?.path ?? ""),
        headers: {},
        body: Buffer.from(""),
      }),
    ).rejects.toBeInstanceOf(WebhookNotFoundError);
    await expect(
      webhooks.ingest({
        projectId,
        name: "ping",
        token: urlToken(rotated.path),
        headers: {},
        body: Buffer.from("hello"),
      }),
    ).resolves.toMatchObject({ duplicate: false });
  });
});
