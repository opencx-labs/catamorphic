import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { UndeclaredSecretError } from "../services/plugins-service.js";
import { parseProjectEnvironmentPolicy } from "../services/project-environments-service.js";
import {
  SecretMemberNotFoundError,
  SecretsService,
  SecretValueInvalidError,
  secretFingerprint,
} from "../services/secrets-service.js";

/*
 * Project secrets with a value per member (ADR 0206) on PGlite, the
 * desktop's and stock server's database: one shared value and one per
 * member under the same name, write-only, set by the member or by whoever
 * manages secrets, and resolved per sandbox owner.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();

/** A member of the project with the given permissions. */
function member(externalUserId: string, permissions: string[] = []): Identity {
  return {
    tenantId,
    externalUserId,
    scope: [{ kind: "agent", projectId, name: "*" }],
    projectPermissions: permissions.map((permission) => ({
      projectId,
      permission,
    })),
  };
}
const ada = member("ada");
const manager = member("mia", ["secrets:read", "secrets:write"]);
const reader = member("rex", ["secrets:read"]);
const outsider: Identity = { tenantId, externalUserId: "eve", scope: [] };
const MEMBERS = new Set(["ada", "bob", "mia", "rex"]);

const POLICY = parseProjectEnvironmentPolicy({
  secrets: {
    CLICKHOUSE_API_KEY: { description: "Your ClickHouse key" },
    SENTRY_DSN: {},
    PATH: {},
  },
  environments: {
    dev: {
      workloads: ["agent"],
      secrets: [
        "CLICKHOUSE_API_KEY",
        "SENTRY_DSN",
        "STRIPE_KEY",
        "SIGNING_SECRET",
        "PATH",
        "TYPO_KEY",
      ],
    },
    ci: { workloads: ["workflow"], secrets: ["SENTRY_DSN"] },
  },
});

describe("project secrets with a value per member (ADR 0206)", () => {
  const vault = new MemoryCredentialVault();
  const secrets = new SecretsService({
    db,
    projectDeclarations: async () => [
      { name: "STRIPE_KEY", required: false, default: "sk_test_default" },
      { name: "API_KEY", required: true },
      { name: "SIGNING_SECRET", required: true, use: "webhook" as const },
    ],
    vault,
    environments: { list: async () => POLICY },
    isMember: async ({ externalUserId }) => MEMBERS.has(externalUserId),
  });
  const rows = () =>
    db
      .selectFrom("project_secrets")
      .selectAll()
      .where("project_id", "=", projectId)
      .execute();

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

  it("keeps one shared value and one per member under a name", async () => {
    await secrets.upsert({
      identity: manager,
      projectId,
      name: "CLICKHOUSE_API_KEY",
      value: "shared-ch-key",
    });
    // Replacing the shared value keeps it one row (NULLS NOT DISTINCT).
    await secrets.upsert({
      identity: manager,
      projectId,
      name: "CLICKHOUSE_API_KEY",
      value: "shared-ch-key-2",
    });
    // A member sets their own without `secrets:write`.
    const own = await secrets.setMember({
      identity: ada,
      projectId,
      name: "CLICKHOUSE_API_KEY",
      member: "ada",
      value: "ada-ch-key",
    });
    expect(own).toMatchObject({ name: "CLICKHOUSE_API_KEY", member: "ada" });
    // Someone who manages secrets onboards a colleague.
    await secrets.setMember({
      identity: manager,
      projectId,
      name: "CLICKHOUSE_API_KEY",
      member: "bob",
      value: "bob-ch-key",
    });
    const stored = await rows();
    expect(
      stored
        .map((row) => [row.name, row.member_external_user_id, row.set_by])
        .sort(),
    ).toEqual(
      [
        ["CLICKHOUSE_API_KEY", null, "mia"],
        ["CLICKHOUSE_API_KEY", "ada", "ada"],
        ["CLICKHOUSE_API_KEY", "bob", "mia"],
      ].sort(),
    );
    // Sealed: the rows hold vault references only.
    expect(JSON.stringify(stored)).not.toContain("ch-key");
    expect(stored.every((row) => row.value === null)).toBe(true);
  });

  it("lets members change only their own value, and only for members", async () => {
    await expect(
      secrets.setMember({
        identity: ada,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: "bob",
        value: "not-yours",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      secrets.upsert({
        identity: ada,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        value: "not-shared",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      secrets.setMember({
        identity: outsider,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: "eve",
        value: "outside",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      secrets.setMember({
        identity: manager,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: "eve",
        value: "outside",
      }),
    ).rejects.toBeInstanceOf(SecretMemberNotFoundError);
    await expect(
      secrets.setMember({
        identity: manager,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: PROJECT_PRINCIPAL_ID,
        value: "project",
      }),
    ).rejects.toBeInstanceOf(SecretValueInvalidError);
    await expect(
      secrets.setMember({
        identity: ada,
        projectId,
        name: "NOT_DECLARED",
        member: "ada",
        value: "x",
      }),
    ).rejects.toBeInstanceOf(UndeclaredSecretError);
    await expect(
      secrets.setMember({
        identity: manager,
        projectId,
        name: "SIGNING_SECRET",
        member: "ada",
        value: "webhook",
      }),
    ).rejects.toThrow("holds only a shared value");
    await expect(
      secrets.setMember({
        identity: ada,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: "ada",
        value: "x".repeat(64 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(SecretValueInvalidError);
  });

  it("reports presence, never a value, and members only to readers", async () => {
    const forAda = await secrets.list({ identity: ada, projectId });
    const ch = forAda.find((entry) => entry.name === "CLICKHOUSE_API_KEY");
    expect(ch).toMatchObject({
      description: "Your ClickHouse key",
      source: "project",
      environments: ["dev"],
      shared: true,
      setBy: "mia",
      own: true,
      members: [],
    });
    // Webhook signing secrets are no member's business.
    expect(forAda.map((entry) => entry.name)).not.toContain("SIGNING_SECRET");
    expect(
      forAda.find((entry) => entry.name === "SENTRY_DSN")?.environments,
    ).toEqual(["ci", "dev"]);
    const forReader = await secrets.list({ identity: reader, projectId });
    expect(
      forReader
        .find((entry) => entry.name === "CLICKHOUSE_API_KEY")
        ?.members.map((value) => [value.member, value.setBy]),
    ).toEqual([
      ["ada", "ada"],
      ["bob", "mia"],
    ]);
    expect(forReader.map((entry) => entry.name)).toContain("SIGNING_SECRET");
    expect(JSON.stringify([forAda, forReader])).not.toContain("ch-key");
    await expect(
      secrets.list({ identity: outsider, projectId }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("resolves an Environment's secrets for each owner, with what is missing and why", async () => {
    const forAda = await secrets.resolveForSandbox({
      identity: ada,
      projectId,
      environment: "dev",
      owner: "ada",
    });
    expect(forAda.variables).toEqual({
      CLICKHOUSE_API_KEY: "ada-ch-key",
      STRIPE_KEY: "sk_test_default",
    });
    expect(forAda.delivered).toEqual([
      {
        name: "CLICKHOUSE_API_KEY",
        source: "member",
        fingerprint: secretFingerprint("ada-ch-key"),
      },
      {
        name: "STRIPE_KEY",
        source: "default",
        fingerprint: secretFingerprint("sk_test_default"),
      },
    ]);
    expect(forAda.missing).toEqual([
      { name: "SIGNING_SECRET", reason: "webhook" },
      { name: "PATH", reason: "reserved" },
      { name: "TYPO_KEY", reason: "undeclared" },
      { name: "SENTRY_DSN", reason: "unset" },
    ]);
    // A member with no value of their own gets the shared one.
    const forRex = await secrets.resolveForSandbox({
      identity: reader,
      projectId,
      environment: "dev",
      owner: "rex",
    });
    expect(forRex.variables.CLICKHOUSE_API_KEY).toBe("shared-ch-key-2");
    // The project's own chats get shared values only.
    const forProject = await secrets.resolveForSandbox({
      identity: ada,
      projectId,
      environment: "dev",
      owner: null,
    });
    expect(forProject.variables.CLICKHOUSE_API_KEY).toBe("shared-ch-key-2");
    expect(
      await secrets.environmentSecrets({
        identity: ada,
        projectId,
        environment: "ci",
      }),
    ).toEqual(["SENTRY_DSN"]);
    expect(forAda.unmasked).toEqual([]);
    // What a chat that held secrets masks: its owners' and the shared
    // values, and declared defaults, never anyone else's.
    expect(
      await secrets.valuesForMasking({
        identity: ada,
        projectId,
        owners: ["ada", null],
        sessionIds: [],
      }),
    ).toEqual({
      STRIPE_KEY: ["sk_test_default"],
      CLICKHOUSE_API_KEY: expect.arrayContaining([
        "ada-ch-key",
        "shared-ch-key-2",
      ]),
    });
    expect(
      (
        await secrets.valuesForMasking({
          identity: ada,
          projectId,
          owners: ["ada"],
          sessionIds: [],
        })
      ).CLICKHOUSE_API_KEY,
    ).not.toContain("bob-ch-key");
  });

  it("remembers every value delivered to a chat, so a rotated one stays masked", async () => {
    const sessionId = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({ id: sessionId, project_id: projectId, external_user_id: "ada" })
      .execute();
    const held = () =>
      db
        .selectFrom("agent_sessions")
        .select(["secrets_held_at", "secrets_delivered_ref"])
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
    expect((await held()).secrets_held_at).toBeNull();
    await secrets.rememberDelivery({
      tenantId,
      sessionId,
      variables: { CLICKHOUSE_API_KEY: "ada-old-key-0001" },
    });
    const first = await held();
    expect(first.secrets_held_at).not.toBeNull();
    // The record is sealed: the row holds only a vault reference.
    expect(JSON.stringify(first)).not.toContain("ada-old-key");
    // The same delivery again changes nothing.
    await secrets.rememberDelivery({
      tenantId,
      sessionId,
      variables: { CLICKHOUSE_API_KEY: "ada-old-key-0001" },
    });
    expect((await held()).secrets_delivered_ref).toBe(
      first.secrets_delivered_ref,
    );
    // Rotated: the new value is delivered, the old one is no longer stored.
    await secrets.rememberDelivery({
      tenantId,
      sessionId,
      variables: { CLICKHOUSE_API_KEY: "ada-new-key-0002" },
    });
    const second = await held();
    expect(second.secrets_delivered_ref).not.toBe(first.secrets_delivered_ref);
    await expect(
      vault.withMaterial({
        tenantId,
        ref: { id: first.secrets_delivered_ref ?? "" },
        use: () => 1,
      }),
    ).rejects.toThrow();
    const masked = await secrets.valuesForMasking({
      identity: ada,
      projectId,
      owners: [],
      sessionIds: [sessionId],
    });
    expect(masked.CLICKHOUSE_API_KEY).toEqual(
      expect.arrayContaining(["ada-old-key-0001", "ada-new-key-0002"]),
    );
  });

  it("keeps runs on shared values and declared code secrets", async () => {
    await secrets.upsert({
      identity: manager,
      projectId,
      name: "API_KEY",
      value: "run-api-key",
    });
    await secrets.upsert({
      identity: manager,
      projectId,
      name: "SENTRY_DSN",
      value: "https://sentry.example",
    });
    const loaded = await secrets.loadForRun({ identity: ada, projectId });
    // `project.json` declarations are for Environments; members' values
    // never reach runs.
    expect(loaded).toEqual({
      values: { STRIPE_KEY: "sk_test_default", API_KEY: "run-api-key" },
      missingRequired: [],
    });
    expect(
      await secrets.value({ tenantId, projectId, name: "CLICKHOUSE_API_KEY" }),
    ).toBe("shared-ch-key-2");
  });

  it("removes one value at a time and audits by name and fingerprint", async () => {
    const before = (await rows()).find(
      (row) => row.member_external_user_id === "ada",
    )?.credential_ref;
    expect(
      await secrets.deleteMember({
        identity: ada,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: "ada",
      }),
    ).toBe(true);
    await expect(
      vault.withMaterial({ tenantId, ref: { id: before ?? "" }, use: () => 1 }),
    ).rejects.toThrow();
    expect(
      await secrets.deleteMember({
        identity: ada,
        projectId,
        name: "CLICKHOUSE_API_KEY",
        member: "ada",
      }),
    ).toBe(false);
    // Bob's and the shared value stay.
    expect(
      (await rows())
        .filter((row) => row.name === "CLICKHOUSE_API_KEY")
        .map((row) => row.member_external_user_id)
        .sort(),
    ).toEqual(["bob", null].sort());
    await secrets.auditDelivery({
      identity: ada,
      projectId,
      sessionId: crypto.randomUUID(),
      delivered: [
        {
          name: "CLICKHOUSE_API_KEY",
          source: "shared",
          fingerprint: secretFingerprint("shared-ch-key-2"),
        },
      ],
      missing: [{ name: "SENTRY_DSN", reason: "unset" }],
    });
    const audit = await db
      .selectFrom("connection_audit_events")
      .select(["event_type", "actor_external_user_id", "metadata"])
      .where("project_id", "=", projectId)
      .execute();
    expect(audit.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        "project_secrets.set",
        "project_secrets.delete",
        "project_secrets.deliver",
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("ch-key");
    expect(JSON.stringify(audit)).toContain(
      secretFingerprint("shared-ch-key-2"),
    );
  });
});
