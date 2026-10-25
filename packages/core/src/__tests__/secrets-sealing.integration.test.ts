import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ProjectNotFoundError } from "../services/projects-service.js";
import {
  SecretDeclarationConflictError,
  SecretsService,
} from "../services/secrets-service.js";

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
  const secrets = new SecretsService({
    db,
    projectDeclarations: async () => [
      { name: "API_KEY", required: true },
      { name: "WEBHOOK_SECRET", required: false },
      { name: "SIGNING_SECRET", required: true, use: "webhook" as const },
    ],
    vault,
  });
  const row = (name: string) =>
    db
      .selectFrom("project_secrets")
      .select(["credential_ref"])
      .where("project_id", "=", projectId)
      .where("name", "=", name)
      .where("member_external_user_id", "is", null)
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
      name: "API_KEY",
      value: "sk-live-123",
    });
    const stored = await row("API_KEY");
    expect(stored).not.toHaveProperty("value");
    expect(stored?.credential_ref).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain("sk-live-123");

    const loaded = await secrets.loadForRun({
      identity: owner,
      projectId,
    });
    expect(loaded).toEqual({
      values: { API_KEY: "sk-live-123" },
      missingRequired: [],
    });
  });

  it("keeps webhook signing secrets out of runs but readable for verification", async () => {
    await secrets.upsert({
      identity: owner,
      projectId,
      name: "SIGNING_SECRET",
      value: "whsec-456",
    });
    const loaded = await secrets.loadForRun({ identity: owner, projectId });
    expect(loaded.values).not.toHaveProperty("SIGNING_SECRET");
    expect(loaded.missingRequired).not.toContain("SIGNING_SECRET");
    await expect(
      secrets.value({ tenantId, projectId, name: "SIGNING_SECRET" }),
    ).resolves.toBe("whsec-456");
  });

  it("drops the replaced vault record on overwrite and delete", async () => {
    const before = (await row("API_KEY"))?.credential_ref ?? "";
    await secrets.upsert({
      identity: owner,
      projectId,
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
        name: "API_KEY",
      }),
    ).toBe("sk-live-456");

    expect(
      await secrets.delete({
        identity: owner,
        projectId,
        name: "API_KEY",
      }),
    ).toBe(true);
    await expect(
      vault.withMaterial({ tenantId, ref: { id: replaced }, use: () => 1 }),
    ).rejects.toThrow();
  });

  it("refuses writes without a vault instead of storing plaintext", async () => {
    const service = new SecretsService({
      db,
      projectDeclarations: async () => [
        { name: "NO_VAULT_KEY", required: true },
      ],
    });
    await expect(
      service.upsert({
        identity: owner,
        projectId,
        name: "NO_VAULT_KEY",
        value: "must-never-be-stored",
      }),
    ).rejects.toThrow("Secret vault is not configured");
    expect(await row("NO_VAULT_KEY")).toBeUndefined();
  });

  it("refuses a different tenant before reading secret values", async () => {
    const name = "TENANT_KEY";
    const wrongTenant = { ...owner, tenantId: crypto.randomUUID() };
    // A host's declaration reader is not an authorization boundary.
    const service = new SecretsService({
      db,
      vault,
      projectDeclarations: async () => [{ name, required: true }],
    });
    await service.upsert({
      identity: owner,
      projectId,
      name,
      value: "tenant-secret",
    });
    const before = await row(name);
    await expect(
      service.value({ tenantId: wrongTenant.tenantId, projectId, name }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      service.loadForRun({ identity: wrongTenant, projectId }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      service.valuesForMasking({
        identity: wrongTenant,
        projectId,
        owners: [],
        sessionIds: [],
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await row(name)).toEqual(before);
  });

  it("refuses a scoped outsider before resolving a run's secret values", async () => {
    const service = new SecretsService({
      db,
      projectDeclarations: async () => [{ name: "TENANT_KEY", required: true }],
    });
    await expect(
      service.loadForRun({ identity: { ...owner, scope: [] }, projectId }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  describe("a plugin secret named like a project webhook secret", () => {
    const plugin = (name: string) => ({
      getDeclaredSecrets: async () =>
        new Map([
          [name, { name, label: name, description: "", required: true }],
        ]),
    });
    const project = async () => [
      { name: "SIGNING_SECRET", required: true, use: "webhook" as const },
      { name: "API_KEY", required: false },
    ];

    it("is refused a value and refuses runs instead of reaching them", async () => {
      const secrets = new SecretsService({
        db,
        plugins: plugin("SIGNING_SECRET"),
        projectDeclarations: project,
      });
      await expect(
        secrets.upsert({
          identity: owner,
          projectId,
          name: "SIGNING_SECRET",
          value: "whsec-new",
        }),
      ).rejects.toBeInstanceOf(SecretDeclarationConflictError);
      await expect(
        secrets.loadForRun({ identity: owner, projectId }),
      ).rejects.toThrow(
        "Secret 'SIGNING_SECRET' is declared webhook-only by the project and also by an attached plugin; rename one of them",
      );
    });

    it("still wins over a project run secret of the same name", async () => {
      const secrets = new SecretsService({
        db,
        plugins: plugin("API_KEY"),
        projectDeclarations: project,
      });
      const [status] = (
        await secrets.list({ identity: owner, projectId })
      ).filter((secret) => secret.name === "API_KEY");
      expect(status?.source).toBe("plugin");
    });
  });
});
