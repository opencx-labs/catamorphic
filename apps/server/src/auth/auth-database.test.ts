import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { openStockAuthDatabase } from "./auth-database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDataDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "catamorphic-stock-auth-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function optionsFor(
  database: BetterAuthOptions["database"],
): BetterAuthOptions {
  return {
    baseURL: "http://127.0.0.1:4700",
    secret: "stock-auth-database-test-secret-at-least-32-characters",
    database,
    emailAndPassword: { enabled: true },
  };
}

describe("openStockAuthDatabase", () => {
  it("migrates PGlite idempotently and persists Better Auth users", async () => {
    const dataDir = createDataDirectory();
    const first = await openStockAuthDatabase({ dataDir });
    const firstOptions = optionsFor(first.database);

    await first.migrate({ options: firstOptions });
    await first.migrate({ options: firstOptions });

    const firstAuth = betterAuth(firstOptions);
    const created = await firstAuth.api.signUpEmail({
      body: {
        email: "ada@local.invalid",
        name: "Ada",
        password: "correct horse battery staple",
      },
    });
    await first.close();

    const reopened = await openStockAuthDatabase({ dataDir });
    const reopenedOptions = optionsFor(reopened.database);
    await reopened.migrate({ options: reopenedOptions });
    const reopenedAuth = betterAuth(reopenedOptions);
    const signedIn = await reopenedAuth.api.signInEmail({
      body: {
        email: "ada@local.invalid",
        password: "correct horse battery staple",
      },
    });

    expect(signedIn.user.id).toBe(created.user.id);
    expect(signedIn.token).toBeTruthy();
    await reopened.close();
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("openStockAuthDatabase with Postgres", () => {
  it("migrates into the selected auth schema and nowhere else", async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const schema = `catamorphic_auth_test_${Date.now()}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const database = await openStockAuthDatabase({
      dataDir: createDataDirectory(),
      databaseUrl,
      authSchema: schema,
    });

    try {
      const authOptions = optionsFor(database.database);
      await database.migrate({ options: authOptions });
      await database.migrate({ options: authOptions });
      const tables = await admin.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'user'
        ) AS present`,
        [schema],
      );
      expect(tables.rows[0]?.present).toBe(true);
    } finally {
      await database.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
