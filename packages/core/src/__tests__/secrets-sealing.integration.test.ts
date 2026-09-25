import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { SecretsService } from "../services/secrets-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const owner: Identity = { tenantId, externalUserId: "owner" };

describe("sealed project secrets (ADR 0162)", () => {
  const vault = new MemoryCredentialVault();
  const secrets = new SecretsService(
    db,
    undefined,
    async () => [
      { name: "API_KEY", required: true },
      { name: "WEBHOOK_SECRET", required: false },
    ],
    vault,
  );
  const row = (name: string) =>
    db
      .selectFrom("project_secrets")
      .select(["value", "credential_ref"])
      .where("project_id", "=", projectId)
      .where("name", "=", name)
      .executeTakeFirst();

  beforeAll(async () => {
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Brain" })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
  });

  it("stores only a vault reference and unseals for runs", async () => {
    await secrets.upsert({
      identity: owner,
      projectId,
      stage: "production",
      name: "API_KEY",
      value: "sk-live-123",
    });
    const stored = await row("API_KEY");
    expect(stored?.value).toBeNull();
    expect(stored?.credential_ref).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain("sk-live-123");

    const loaded = await secrets.loadForRun({
      identity: owner,
      projectId,
      stage: "production",
    });
    expect(loaded).toEqual({
      values: { API_KEY: "sk-live-123" },
      missingRequired: [],
    });
  });

  it("drops the replaced vault record on overwrite and delete", async () => {
    const before = (await row("API_KEY"))?.credential_ref ?? "";
    await secrets.upsert({
      identity: owner,
      projectId,
      stage: "production",
      name: "API_KEY",
      value: "sk-live-456",
    });
    await expect(
      vault.withMaterial({ tenantId, ref: { id: before }, use: () => 1 }),
    ).rejects.toThrow();
    const replaced = (await row("API_KEY"))?.credential_ref ?? "";
    expect(
      await secrets.value({
        tenantId,
        projectId,
        stage: "production",
        name: "API_KEY",
      }),
    ).toBe("sk-live-456");

    expect(
      await secrets.delete({
        identity: owner,
        projectId,
        stage: "production",
        name: "API_KEY",
      }),
    ).toBe(true);
    await expect(
      vault.withMaterial({ tenantId, ref: { id: replaced }, use: () => 1 }),
    ).rejects.toThrow();
  });

  it("seals a plaintext value written before sealing on first read", async () => {
    await db
      .insertInto("project_secrets")
      .values({
        project_id: projectId,
        stage: "production",
        name: "WEBHOOK_SECRET",
        value: "legacy-plaintext",
      })
      .execute();
    expect(
      await secrets.value({
        tenantId,
        projectId,
        stage: "production",
        name: "WEBHOOK_SECRET",
      }),
    ).toBe("legacy-plaintext");
    const sealed = await row("WEBHOOK_SECRET");
    expect(sealed?.value).toBeNull();
    expect(sealed?.credential_ref).toBeTruthy();
  });
});
