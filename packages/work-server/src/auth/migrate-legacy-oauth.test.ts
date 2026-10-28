import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { symmetricDecrypt } from "better-auth/crypto";
import Fastify from "fastify";
import { Kysely, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { openWorkAuthDatabase } from "./auth-database.js";
import { registerWorkAuthRoutes } from "./fastify-auth.js";
import { createWorkAuth } from "./work-auth.js";
import type { WorkAuth } from "./work-auth-types.js";

const BASE_URL = "http://127.0.0.1:4700";
const RESOURCE = `${BASE_URL}/api`;
const SECRET = "legacy-oauth-migration-test-secret-at-least-32-characters";
const PASSWORD = "correct horse battery staple";
// Generated with better-auth 1.6.26 hashPassword(PASSWORD), not the new code.
const PASSWORD_HASH =
  "28842c485592581d2c150d3c8e80dc05:2b4e811c775b3a2fec79be8aeb33c0a9ff1ea6e1ca625651c7b8f8277d0823a09148b1beab71d7d3d6a3f80be35b83adfb2f37696c0b8201dbfe99bcbd3d30de";
const USER_ID = "legacy-user";
const SESSION_TOKEN = "legacy-browser-session-token";
const CLIENT_SECRET = "legacy-confidential-client-secret";
const SCOPES = ["openid", "profile", "email", "offline_access"];
const GRANTS = [
  {
    id: "legacy-public-grant",
    clientId: "legacy-public-client",
    accessToken: "legacy-public-access-token",
    refreshToken: "legacy-public-refresh-token",
  },
  {
    id: "legacy-confidential-grant",
    clientId: "legacy-confidential-client",
    accessToken: "legacy-confidential-access-token",
    refreshToken: "legacy-confidential-refresh-token",
  },
];
const legacySchema = fs.readFileSync(
  new URL("./fixtures/better-auth-1.6.26.sql", import.meta.url),
  "utf8",
);

interface FixtureConnection {
  db: Kysely<unknown>;
  auth: WorkAuth;
}

async function withLegacyDatabase(args: {
  databaseUrl?: string;
  run(
    fixture: FixtureConnection & {
      reopen(): Promise<FixtureConnection>;
    },
  ): Promise<void>;
}) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "work-auth-legacy-oauth-"),
  );
  const authSchema = `auth_legacy_${randomUUID().replaceAll("-", "")}`;
  const admin = args.databaseUrl
    ? new Pool({ connectionString: args.databaseUrl })
    : undefined;
  const openOptions = {
    dataDir,
    databaseUrl: args.databaseUrl,
    authSchema,
  };
  let database = await openWorkAuthDatabase(openOptions);
  const queryDatabase = () => {
    const config = database.database;
    if (!("dialect" in config)) throw new Error("Expected a Kysely dialect");
    return new Kysely<unknown>({ dialect: config.dialect });
  };
  const connection = (): FixtureConnection => {
    return {
      db: queryDatabase(),
      auth: createWorkAuth({
        database,
        baseURL: BASE_URL,
        secret: SECRET,
        rateLimit: false,
      }),
    };
  };
  try {
    const legacyDb = queryDatabase();
    for (const statement of legacySchema.split(";").filter((s) => s.trim())) {
      await sql.raw(statement).execute(legacyDb);
    }
    await seedLegacyRows(legacyDb);
    const first = connection();
    await args.run({
      ...first,
      reopen: async () => {
        await database.close();
        database = await openWorkAuthDatabase(openOptions);
        return connection();
      },
    });
  } finally {
    await database.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${authSchema}" CASCADE`);
      await admin.end();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function seedLegacyRows(db: Kysely<unknown>) {
  const createdAt = new Date(Date.now() - 60_000);
  const accessExpiresAt = new Date(Date.now() + 3_600_000);
  const refreshExpiresAt = new Date(Date.now() + 7 * 24 * 3_600_000);
  await sql`INSERT INTO "user"
    ("id", "name", "email", "emailVerified", "username", "displayUsername", "createdAt", "updatedAt")
    VALUES (${USER_ID}, 'Legacy Ada', 'ada@local.invalid', true, 'ada', 'Ada', ${createdAt}, ${createdAt})`.execute(
    db,
  );
  await sql`INSERT INTO "account"
    ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
    VALUES ('legacy-password-account', ${USER_ID}, 'credential', ${USER_ID}, ${PASSWORD_HASH}, ${createdAt}, ${createdAt})`.execute(
    db,
  );
  await sql`INSERT INTO "account"
    ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "scope", "createdAt", "updatedAt")
    VALUES ('legacy-oidc-account', 'upstream-ada', 'company-oidc', ${USER_ID}, 'upstream-access', 'upstream-refresh', 'openid email', ${createdAt}, ${createdAt})`.execute(
    db,
  );
  await sql`INSERT INTO "session"
    ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt", "ipAddress", "userAgent")
    VALUES ('legacy-browser-session', ${SESSION_TOKEN}, ${USER_ID}, ${accessExpiresAt}, ${createdAt}, ${createdAt}, '127.0.0.1', 'legacy-browser')`.execute(
    db,
  );
  for (const [index, grant] of GRANTS.entries()) {
    await sql`INSERT INTO "oauthApplication"
      ("id", "clientId", "clientSecret", "name", "icon", "metadata", "redirectUrls", "type", "disabled", "userId", "createdAt", "updatedAt")
      VALUES (${`legacy-application-${index}`}, ${grant.clientId}, ${index === 0 ? "" : CLIENT_SECRET}, ${index === 0 ? "Work desktop" : "Legacy integration"}, 'https://example.invalid/icon.png', '{"team":"legacy"}', 'http://127.0.0.1:49152/callback,http://localhost:49153/callback', ${index === 0 ? "public" : "web"}, false, ${USER_ID}, ${createdAt}, ${createdAt})`.execute(
      db,
    );
    await sql`INSERT INTO "oauthAccessToken"
      ("id", "clientId", "userId", "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scopes", "createdAt", "updatedAt")
      VALUES (${grant.id}, ${grant.clientId}, ${USER_ID}, ${grant.accessToken}, ${grant.refreshToken}, ${accessExpiresAt}, ${refreshExpiresAt}, 'openid  profile\temail offline_access ', ${createdAt}, ${createdAt})`.execute(
      db,
    );
    await sql`INSERT INTO "oauthConsent"
      ("id", "clientId", "userId", "scopes", "consentGiven", "createdAt", "updatedAt")
      VALUES (${`legacy-consent-${index}`}, ${grant.clientId}, ${USER_ID}, 'openid  profile\temail offline_access ', ${index === 0}, ${createdAt}, ${createdAt})`.execute(
      db,
    );
  }
  await sql`INSERT INTO "oauthApplication"
    ("id", "clientId", "clientSecret", "name", "metadata", "redirectUrls", "type", "disabled", "createdAt", "updatedAt")
    VALUES ('legacy-disabled-application', 'legacy-disabled-client', '', 'Disabled desktop', NULL, 'http://localhost:49154/callback', 'public', true, ${createdAt}, ${createdAt})`.execute(
    db,
  );
  await sql`INSERT INTO "verification"
    ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
    VALUES ('legacy-verification', 'unrelated-verification', 'keep-me', ${accessExpiresAt}, ${createdAt}, ${createdAt})`.execute(
    db,
  );
  await sql`INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest")
    VALUES ('legacy-rate-limit', 'legacy-ip-address', 2, ${Date.now()})`.execute(
    db,
  );
}

async function rows(db: Kysely<unknown>, table: string) {
  return (
    await sql<
      Record<string, unknown>
    >`SELECT * FROM ${sql.table(table)} ORDER BY "id"`.execute(db)
  ).rows;
}

async function snapshot(db: Kysely<unknown>, tables: string[]) {
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [table, await rows(db, table)]),
    ),
  );
}

const UNCHANGED_TABLES = [
  "user",
  "account",
  "session",
  "verification",
  "rateLimit",
];
const LEGACY_TABLES = [
  ...UNCHANGED_TABLES,
  "oauthApplication",
  "oauthAccessToken",
  "oauthConsent",
];
const MIGRATED_TABLES = [
  ...UNCHANGED_TABLES,
  "oauthClient",
  "oauthResource",
  "oauthClientResource",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
];

async function schemaSnapshot(db: Kysely<unknown>) {
  const columns =
    await sql`SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema = current_schema()
    ORDER BY table_name, ordinal_position`.execute(db);
  const indexes = await sql`SELECT tablename, indexname, indexdef
    FROM pg_indexes WHERE schemaname = current_schema()
    ORDER BY tablename, indexname`.execute(db);
  return { columns: columns.rows, indexes: indexes.rows };
}

async function expectConverted(db: Kysely<unknown>) {
  const clients = await rows(db, "oauthClient");
  expect(clients).toHaveLength(3);
  expect(
    clients.find((row) => row.clientId === GRANTS[0]?.clientId),
  ).toMatchObject({
    id: "legacy-application-0",
    clientSecret: null,
    tokenEndpointAuthMethod: "none",
    requirePKCE: true,
    disabled: false,
    name: "Work desktop",
    metadata: { team: "legacy" },
    redirectUris: [
      "http://127.0.0.1:49152/callback",
      "http://localhost:49153/callback",
    ],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    userId: USER_ID,
  });
  const confidential = clients.find(
    (row) => row.clientId === GRANTS[1]?.clientId,
  );
  expect(confidential).toMatchObject({
    id: "legacy-application-1",
    tokenEndpointAuthMethod: "client_secret_basic",
    requirePKCE: true,
    disabled: false,
  });
  if (typeof confidential?.clientSecret !== "string") {
    throw new Error("The confidential client secret was lost");
  }
  expect(confidential.clientSecret).not.toBe(CLIENT_SECRET);
  expect(
    await symmetricDecrypt({ key: SECRET, data: confidential.clientSecret }),
  ).toBe(CLIENT_SECRET);
  expect(
    clients.find((row) => row.clientId === "legacy-disabled-client"),
  ).toMatchObject({ disabled: true, userId: null, metadata: null });

  const access = await rows(db, "oauthAccessToken");
  const refresh = await rows(db, "oauthRefreshToken");
  expect(access).toHaveLength(GRANTS.length);
  expect(refresh).toHaveLength(GRANTS.length);
  for (const grant of GRANTS) {
    const common = {
      id: grant.id,
      userId: USER_ID,
      clientId: grant.clientId,
      sessionId: null,
      scopes: SCOPES,
      resources: [RESOURCE],
    };
    expect(access.find((row) => row.id === grant.id)).toMatchObject({
      ...common,
      token: hash(grant.accessToken),
      refreshId: grant.id,
    });
    expect(refresh.find((row) => row.id === grant.id)).toMatchObject({
      ...common,
      token: hash(grant.refreshToken),
    });
  }
  expect(await rows(db, "oauthConsent")).toEqual([
    expect.objectContaining({
      id: "legacy-consent-0",
      clientId: "legacy-public-client",
      userId: USER_ID,
      scopes: SCOPES,
      resources: [RESOURCE],
    }),
  ]);
  expect(await rows(db, "oauthResource")).toEqual([
    expect.objectContaining({ identifier: RESOURCE, disabled: false }),
  ]);
  expect(await rows(db, "oauthClientResource")).toHaveLength(3);
  for (const link of await rows(db, "oauthClientResource")) {
    expect(link.resourceId).toBe(RESOURCE);
    expect(clients.some((client) => client.clientId === link.clientId)).toBe(
      true,
    );
  }
  expect(
    (await db.introspection.getTables()).map((table) => table.name),
  ).not.toContain("oauthApplication");
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function legacyCookie() {
  const signature = createHmac("sha256", SECRET)
    .update(SESSION_TOKEN)
    .digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${SESSION_TOKEN}.${signature}`)}`;
}

function migrationTests(databaseUrl?: string) {
  it("preserves 1.6 users, sessions, clients, grants and consent across repeat migrations and reopen", async () => {
    await withLegacyDatabase({
      databaseUrl,
      run: async ({ db, auth, reopen }) => {
        const unchanged = await snapshot(db, UNCHANGED_TABLES);
        const legacyGrants = await rows(db, "oauthAccessToken");
        await auth.migrate();
        await expectConverted(db);
        const accessGrants = await rows(db, "oauthAccessToken");
        const refreshGrants = await rows(db, "oauthRefreshToken");
        for (const legacy of legacyGrants) {
          expect(
            accessGrants.find((grant) => grant.id === legacy.id),
          ).toMatchObject({
            createdAt: legacy.createdAt,
            expiresAt: legacy.accessTokenExpiresAt,
          });
          expect(
            refreshGrants.find((grant) => grant.id === legacy.id),
          ).toMatchObject({
            createdAt: legacy.createdAt,
            expiresAt: legacy.refreshTokenExpiresAt,
          });
        }
        expect(await snapshot(db, UNCHANGED_TABLES)).toEqual(unchanged);
        const migrated = await snapshot(db, MIGRATED_TABLES);
        await auth.migrate();
        expect(await snapshot(db, MIGRATED_TABLES)).toEqual(migrated);

        const reopened = await reopen();
        await reopened.auth.migrate();
        expect(await snapshot(reopened.db, MIGRATED_TABLES)).toEqual(migrated);
        await expectConverted(reopened.db);
        expect(
          await reopened.auth.findUserById({ userId: USER_ID }),
        ).toMatchObject({
          id: USER_ID,
          username: "ada",
          email: "ada@local.invalid",
          emailVerified: true,
        });
        expect(
          await reopened.auth.sessionFromCookies({ cookie: legacyCookie() }),
        ).toMatchObject({ id: USER_ID });
        expect(
          await reopened.auth.resolveSession({ token: SESSION_TOKEN }),
        ).toMatchObject({ id: USER_ID });
        expect(await reopened.auth.accountsFor({ userId: USER_ID })).toEqual(
          expect.arrayContaining([
            { providerId: "credential", accountId: USER_ID },
            { providerId: "company-oidc", accountId: "upstream-ada" },
          ]),
        );
        const login = await reopened.auth.signInUsername({
          username: "ada",
          password: PASSWORD,
        });
        expect(login.user.id).toBe(USER_ID);
        expect(
          await reopened.auth.resolveSession({ token: login.token }),
        ).toMatchObject({ id: USER_ID });

        for (const grant of GRANTS) {
          expect(
            await reopened.auth.resolveAccessToken({
              authorization: `Bearer ${grant.accessToken}`,
            }),
          ).toEqual({
            userId: USER_ID,
            email: "ada@local.invalid",
            emailVerified: true,
            scopes: SCOPES,
          });
          const expectedGrant = {
            id: grant.id,
            userId: USER_ID,
            clientId: grant.clientId,
          };
          expect(await reopened.auth.grantByAccessToken(grant)).toEqual(
            expectedGrant,
          );
          expect(await reopened.auth.grantByRefreshToken(grant)).toEqual(
            expectedGrant,
          );
        }
      },
    });
  });

  it("refreshes saved public and confidential connections through the legacy token URL with resource binding", async () => {
    await withLegacyDatabase({
      databaseUrl,
      run: async ({ db, auth }) => {
        await auth.migrate();
        // OAuth grants outlive the browser session used to authorize them.
        await sql`DELETE FROM "session"`.execute(db);
        const app = Fastify();
        registerWorkAuthRoutes(app, {
          auth,
          baseURL: BASE_URL,
          methods: { local: true, providers: [] },
        });
        try {
          for (const [index, grant] of GRANTS.entries()) {
            const headers = {
              "content-type": "application/x-www-form-urlencoded",
              ...(index === 1
                ? {
                    authorization: `Basic ${Buffer.from(`${grant.clientId}:${CLIENT_SECRET}`).toString("base64")}`,
                  }
                : {}),
            };
            const form = {
              grant_type: "refresh_token",
              client_id: grant.clientId,
              refresh_token: grant.refreshToken,
            };
            const wrongResource = await app.inject({
              method: "POST",
              url: "/api/auth/mcp/token",
              headers,
              payload: new URLSearchParams({
                ...form,
                resource: "https://other.invalid/api",
              }).toString(),
            });
            expect(wrongResource.statusCode, wrongResource.body).toBe(400);
            expect(wrongResource.json()).toMatchObject({
              error: "invalid_target",
            });
            const response = await app.inject({
              method: "POST",
              url: "/api/auth/mcp/token",
              headers,
              payload: new URLSearchParams({
                ...form,
                resource: RESOURCE,
              }).toString(),
            });
            expect(response.statusCode, response.body).toBe(200);
            const result: unknown = response.json();
            expect(result).toMatchObject({
              access_token: expect.any(String),
              refresh_token: expect.any(String),
              token_type: "Bearer",
            });
            if (
              typeof result !== "object" ||
              result === null ||
              !("access_token" in result) ||
              typeof result.access_token !== "string" ||
              !("refresh_token" in result) ||
              typeof result.refresh_token !== "string"
            )
              throw new Error("Refresh response did not contain a token pair");
            expect(result.access_token).not.toBe(grant.accessToken);
            expect(result.refresh_token).not.toBe(grant.refreshToken);
            expect(
              await auth.resolveAccessToken({
                authorization: `Bearer ${result.access_token}`,
              }),
            ).toMatchObject({ userId: USER_ID, scopes: SCOPES });
            expect(
              await auth.grantByRefreshToken({
                refreshToken: result.refresh_token,
              }),
            ).toMatchObject({ userId: USER_ID, clientId: grant.clientId });
            if (index === 1) {
              const postSecret = new URLSearchParams({
                grant_type: "refresh_token",
                client_id: grant.clientId,
                client_secret: CLIENT_SECRET,
                refresh_token: result.refresh_token,
              }).toString();
              const canonical = await app.inject({
                method: "POST",
                url: "/api/auth/oauth2/token",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                payload: postSecret,
              });
              expect(canonical.statusCode).toBe(400);
              expect(canonical.json().error).toBe("invalid_client");
              const legacyPost = await app.inject({
                method: "POST",
                url: "/api/auth/mcp/token",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                },
                payload: postSecret,
              });
              expect(legacyPost.statusCode, legacyPost.body).toBe(200);
              expect(legacyPost.json()).toMatchObject({
                access_token: expect.any(String),
                refresh_token: expect.any(String),
              });
            }
          }
        } finally {
          await app.close();
        }
      },
    });
  });

  it("rejects another resource's tokens and proof-bound tokens as Work bearer credentials", async () => {
    await withLegacyDatabase({
      databaseUrl,
      run: async ({ db, auth }) => {
        await auth.migrate();
        const grant = GRANTS[0];
        if (!grant) throw new Error("Missing legacy grant fixture");
        const resolve = () =>
          auth.resolveAccessToken({
            authorization: `Bearer ${grant.accessToken}`,
          });
        expect(await resolve()).toMatchObject({ userId: USER_ID });
        await sql`UPDATE "oauthAccessToken" SET "resources" = ${JSON.stringify([`${BASE_URL}/api/auth/oauth2/userinfo`])}::jsonb WHERE "id" = ${grant.id}`.execute(
          db,
        );
        expect(await resolve()).toBeNull();
        await sql`UPDATE "oauthAccessToken" SET "resources" = NULL WHERE "id" = ${grant.id}`.execute(
          db,
        );
        expect(await resolve()).toBeNull();
        await sql`UPDATE "oauthAccessToken" SET "resources" = ${JSON.stringify([RESOURCE])}::jsonb, "confirmation" = '{"jkt":"proof-thumbprint"}'::jsonb WHERE "id" = ${grant.id}`.execute(
          db,
        );
        expect(await resolve()).toBeNull();
        await sql`UPDATE "oauthAccessToken" SET "confirmation" = NULL WHERE "id" = ${grant.id}`.execute(
          db,
        );
        expect(await resolve()).toMatchObject({ userId: USER_ID });
      },
    });
  });

  it("rolls back old data and indexes after conversion fails following DDL, then retries successfully", async () => {
    await withLegacyDatabase({
      databaseUrl,
      run: async ({ db, auth, reopen }) => {
        // Nullable in 1.6, but not convertible to a new user refresh grant.
        // This fails during restore, after old tables were dropped and the
        // replacement schema and clients were created.
        await sql`UPDATE "oauthAccessToken" SET "userId" = NULL
          WHERE "id" = 'legacy-confidential-grant'`.execute(db);
        const before = await snapshot(db, LEGACY_TABLES);
        const schemaBefore = await schemaSnapshot(db);
        await expect(auth.migrate()).rejects.toThrow(
          "Legacy OAuth grant has no user",
        );
        expect(await snapshot(db, LEGACY_TABLES)).toEqual(before);
        expect(await schemaSnapshot(db)).toEqual(schemaBefore);

        const reopened = await reopen();
        expect(await snapshot(reopened.db, LEGACY_TABLES)).toEqual(before);
        expect(await schemaSnapshot(reopened.db)).toEqual(schemaBefore);
        await sql`UPDATE "oauthAccessToken" SET "userId" = ${USER_ID}
          WHERE "id" = 'legacy-confidential-grant'`.execute(reopened.db);
        await reopened.auth.migrate();
        await expectConverted(reopened.db);
        expect(await snapshot(reopened.db, UNCHANGED_TABLES)).toEqual(
          Object.fromEntries(
            UNCHANGED_TABLES.map((table) => [table, before[table]]),
          ),
        );
      },
    });
  });
}

describe("legacy OAuth migration with PGlite", () => migrationTests());
const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
describePostgres("legacy OAuth migration with Postgres", () =>
  migrationTests(databaseUrl),
);
