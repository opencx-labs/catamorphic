import { createHash, randomUUID } from "node:crypto";
import { jsonbText } from "@catamorphic/db";
import type { BetterAuthOptions } from "better-auth";
import { symmetricEncrypt } from "better-auth/crypto";
import { type Kysely, sql } from "kysely";
import { z } from "zod";

const LegacyClient = z.object({
  id: z.string(),
  clientId: z.string(),
  clientSecret: z.string().nullish(),
  name: z.string().nullish(),
  icon: z.string().nullish(),
  metadata: z.string().nullish(),
  redirectUrls: z.string(),
  type: z.string(),
  disabled: z.boolean().nullish(),
  userId: z.string().nullish(),
  createdAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date().nullable(),
});
const LegacyGrant = z.object({
  id: z.string(),
  clientId: z.string(),
  userId: z.string().nullable(),
  accessToken: z.string(),
  refreshToken: z.string(),
  accessTokenExpiresAt: z.coerce.date(),
  refreshTokenExpiresAt: z.coerce.date(),
  scopes: z.string(),
  createdAt: z.coerce.date(),
});
const LegacyConsent = z.object({
  id: z.string(),
  clientId: z.string(),
  userId: z.string(),
  scopes: z.string(),
  consentGiven: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

type OAuthMigrationTables = {
  oauthClient: {
    id: string;
    clientId: string;
    clientSecret: string | null;
    name: string | null;
    icon: string | null;
    metadata: unknown;
    redirectUris: unknown;
    tokenEndpointAuthMethod: string;
    requirePKCE: boolean;
    grantTypes: unknown;
    responseTypes: unknown;
    disabled: boolean;
    userId: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
  };
  oauthResource: {
    id: string;
    identifier: string;
    name: string;
    disabled: boolean;
  };
  oauthClientResource: { id: string; clientId: string; resourceId: string };
  oauthRefreshToken: TokenRow;
  oauthAccessToken: TokenRow & { refreshId: string };
  oauthConsent: {
    id: string;
    clientId: string;
    userId: string;
    resources: unknown;
    scopes: unknown;
    createdAt: Date;
    updatedAt: Date;
  };
};
interface TokenRow {
  id: string;
  token: string;
  clientId: string;
  userId: string | null;
  sessionId: null;
  resources: unknown;
  scopes: unknown;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Convert the private 1.6 OAuth schema in the caller's migration transaction.
 * Reading before dropping also validates every legacy row before any DDL.
 * Dropping the old tables releases their index names for the replacement schema.
 * A failure, including invalid legacy JSON, rolls back the entire upgrade.
 */
export async function migrateLegacyOAuth(args: {
  db: Kysely<unknown>;
  resource?: string;
  secret: BetterAuthOptions["secret"];
}): Promise<() => Promise<void>> {
  const tables = await args.db.introspection.getTables();
  if (!tables.some((table) => table.name === "oauthApplication")) {
    return async () => undefined;
  }
  const { resource, secret } = args;
  if (!resource || typeof secret !== "string") {
    throw new Error(
      "The OAuth upgrade requires Work's resource and auth secret",
    );
  }
  const clients = z
    .array(LegacyClient)
    .parse((await sql`SELECT * FROM "oauthApplication"`.execute(args.db)).rows);
  const grants = z
    .array(LegacyGrant)
    .parse((await sql`SELECT * FROM "oauthAccessToken"`.execute(args.db)).rows);
  const consents = z
    .array(LegacyConsent)
    .parse((await sql`SELECT * FROM "oauthConsent"`.execute(args.db)).rows);
  // Parse/encrypt before DDL as well: malformed metadata must never be discarded.
  const migratedClients = await Promise.all(
    clients.map(async (client) => {
      const metadata: unknown = client.metadata
        ? JSON.parse(client.metadata)
        : null;
      return {
        id: client.id,
        clientId: client.clientId,
        clientSecret:
          client.type === "public" || !client.clientSecret
            ? null
            : await symmetricEncrypt({
                key: secret,
                data: client.clientSecret,
              }),
        name: client.name ?? null,
        icon: client.icon ?? null,
        metadata: jsonColumn(metadata),
        redirectUris: jsonColumn(
          client.redirectUrls.split(",").filter(Boolean),
        ),
        tokenEndpointAuthMethod:
          client.type === "public" ? "none" : "client_secret_basic",
        requirePKCE: true,
        grantTypes: jsonColumn(["authorization_code", "refresh_token"]),
        responseTypes: jsonColumn(["code"]),
        disabled: client.disabled ?? false,
        userId: client.userId ?? null,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      };
    }),
  );
  await args.db.schema.dropTable("oauthAccessToken").execute();
  await args.db.schema.dropTable("oauthConsent").execute();
  await args.db.schema.dropTable("oauthApplication").execute();

  return async () => {
    const db = args.db.withTables<OAuthMigrationTables>();
    await db
      .insertInto("oauthResource")
      .values({
        id: randomUUID(),
        identifier: resource,
        name: "Work API",
        disabled: false,
      })
      .onConflict((conflict) => conflict.column("identifier").doNothing())
      .execute();
    for (const client of migratedClients) {
      await db.insertInto("oauthClient").values(client).execute();
      await db
        .insertInto("oauthClientResource")
        .values({
          id: randomUUID(),
          clientId: client.clientId,
          resourceId: resource,
        })
        .execute();
    }
    for (const grant of grants) {
      // Legacy grant IDs anchor Work's existing refresh-family ledger.
      // OAuth grants are independent of the short browser login session.
      const common = {
        id: grant.id,
        clientId: grant.clientId,
        userId: grant.userId,
        sessionId: null,
        resources: jsonColumn([resource]),
        scopes: jsonColumn(grant.scopes.split(/\s+/).filter(Boolean)),
        createdAt: grant.createdAt,
      };
      // Refresh tokens require a user; 1.6 Work only issued user grants.
      if (!grant.userId) throw new Error("Legacy OAuth grant has no user");
      await db
        .insertInto("oauthRefreshToken")
        .values({
          ...common,
          token: tokenHash(grant.refreshToken),
          expiresAt: grant.refreshTokenExpiresAt,
        })
        .execute();
      await db
        .insertInto("oauthAccessToken")
        .values({
          ...common,
          token: tokenHash(grant.accessToken),
          expiresAt: grant.accessTokenExpiresAt,
          refreshId: grant.id,
        })
        .execute();
    }
    for (const consent of consents.filter((row) => row.consentGiven)) {
      await db
        .insertInto("oauthConsent")
        .values({
          id: consent.id,
          clientId: consent.clientId,
          userId: consent.userId,
          scopes: jsonColumn(consent.scopes.split(/\s+/).filter(Boolean)),
          resources: jsonColumn([resource]),
          createdAt: consent.createdAt,
          updatedAt: consent.updatedAt,
        })
        .execute();
    }
  };
}

function jsonColumn(value: unknown) {
  return sql<unknown>`${jsonbText(value)}::jsonb`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
