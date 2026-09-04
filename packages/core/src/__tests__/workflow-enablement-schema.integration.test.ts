import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_workflow_enablement_schema";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const artifactId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const bindingId = crypto.randomUUID();

beforeAll(async () => {
  await migrateToLatest({ db, schema });
  await db.insertInto("tenants").values({ id: tenantId, name: "T" }).execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: tenantId, name: "P" })
    .execute();
  await db
    .insertInto("deployment_artifacts")
    .values({
      id: artifactId,
      project_id: projectId,
      commit_sha: "a".repeat(40),
      artifact_digest: "artifact",
      plugin_digest: "plugins",
      runtime_version: "test",
      transform_version: "test",
    })
    .execute();
  await db
    .insertInto("connections")
    .values({
      id: connectionId,
      tenant_id: tenantId,
      project_id: projectId,
      provider_kind: "mcp",
      principal_kind: "member",
      owner_external_user_id: "member-a",
      label: "Mail",
    })
    .execute();
  await db
    .insertInto("environment_connection_bindings")
    .values({
      id: bindingId,
      tenant_id: tenantId,
      project_id: projectId,
      environment_name: "local",
      alias: "mail",
      provider_kind: "mcp",
      principal_kinds: ["member"],
    })
    .execute();
});

afterAll(async () => {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
  await db.destroy();
});

function memberValues(externalUserId: string) {
  return {
    tenant_id: tenantId,
    project_id: projectId,
    workflow_name: "watchInbox",
    deployment_artifact_id: artifactId,
    commit_sha: "a".repeat(40),
    environment_name: "local",
    owner_kind: "member" as const,
    owner_external_user_id: externalUserId,
    owner_identity: { tenantId, externalUserId },
    capabilities: [],
    consent_digest: "d".repeat(64),
    created_by_external_user_id: externalUserId,
  };
}

describe("workflow enablement schema", () => {
  it("allows independent members to enable the same deployed workflow", async () => {
    const first = await db
      .insertInto("workflow_enablements")
      .values(memberValues("member-a"))
      .returningAll()
      .executeTakeFirstOrThrow();
    const second = await db
      .insertInto("workflow_enablements")
      .values(memberValues("member-b"))
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(first.owner_external_user_id).toBe("member-a");
    expect(second.owner_external_user_id).toBe("member-b");
  });

  it("rejects a member owner without a member identity", async () => {
    await expect(
      db
        .insertInto("workflow_enablements")
        .values({
          ...memberValues("member-c"),
          owner_external_user_id: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("rejects duplicate aliases inside one enablement", async () => {
    const enablement = await db
      .selectFrom("workflow_enablements")
      .select("id")
      .where("owner_external_user_id", "=", "member-a")
      .executeTakeFirstOrThrow();
    const selection = {
      enablement_id: enablement.id,
      alias: "mail",
      binding_id: bindingId,
      connection_id: connectionId,
      provider_kind: "mcp",
      principal_kind: "member" as const,
      capabilities: [],
    };
    await db
      .insertInto("workflow_enablement_connections")
      .values(selection)
      .execute();
    await expect(
      db
        .insertInto("workflow_enablement_connections")
        .values(selection)
        .execute(),
    ).rejects.toThrow();
  });
});
