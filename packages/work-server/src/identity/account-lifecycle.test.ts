import { randomUUID } from "node:crypto";
import { type DB, type JsonObject, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkAuthUser } from "../auth/work-auth.js";
import { FakeDirectory } from "../test-support.js";
import { AccountLifecycle } from "./account-lifecycle.js";

/**
 * Which account transitions become directory events (ADR 0209), against a
 * real schema: each transition is announced once with the account's next
 * revision, and nothing else is.
 */

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_account_lifecycle";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});

interface Announced {
  kind: string;
  externalId: string;
  payload: JsonObject;
}

function setup(options: { directory?: FakeDirectory; tracked?: string[] }) {
  const users = new Map<string, WorkAuthUser>();
  const announced: Announced[] = [];
  const accounts = new AccountLifecycle({
    db,
    auth: {
      accountsFor: async ({ userId }) =>
        options.directory
          ? [{ providerId: "credential", accountId: userId }]
          : [],
      findUserById: async ({ userId }) => users.get(userId) ?? null,
      grantByAccessToken: async () => null,
      deleteGrants: async () => {},
      signOutEverywhere: async () => {},
      // Nobody holds a live session: the sweep still finds members.
      usersSignedIn: async () => [],
    },
    directories: options.directory ? [options.directory] : [],
    sessions: {
      accessTokenSeconds: 900,
      idleSeconds: 3600,
      maxAgeSeconds: 7200,
    },
    directory: { checkIntervalMs: 300_000, graceMs: 1_800_000 },
    tenantId: randomUUID(),
    projectEvents: {
      appendToSubscribers: async (event) => {
        announced.push({
          kind: event.kind,
          externalId: event.externalId,
          payload: event.payload,
        });
        return { events: [] };
      },
    },
    mappedGroups: async () => options.tracked ?? [],
    reconcileRoles: async () => {},
    onDisabled: async () => {},
  });
  const user = (name: string) => {
    const id = randomUUID();
    users.set(id, {
      id,
      email: `${name}@example.com`,
      emailVerified: true,
      name,
      username: name,
    });
    return id;
  };
  return { accounts, announced, user };
}

beforeAll(async () => {
  await migrateToLatest({ db, schema });
}, 30_000);

afterAll(async () => {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
  await db.destroy();
});

describe("directory transitions", () => {
  it("without a directory, an account joins at its first sign-in and leaves when disabled", async () => {
    const { accounts, announced, user } = setup({});
    const ada = user("ada");
    expect(await accounts.refreshStanding({ userId: ada })).toBe("active");
    expect(announced).toEqual([]);
    await accounts.refreshStanding({ userId: ada, signIn: true });
    await accounts.refreshStanding({ userId: ada, signIn: true });
    await accounts.disable({ userId: ada, reason: "removed" });
    await accounts.disable({ userId: ada, reason: "removed" });
    expect(announced.map((event) => event.externalId)).toEqual([
      `directory.member-joined:${ada}:1`,
      `directory.member-left:${ada}:2`,
    ]);
    expect(announced[0]?.payload).toEqual({
      member: {
        id: ada,
        email: "ada@example.com",
        name: "ada",
        domain: "example.com",
      },
      groups: [],
    });
  });

  it("an account that never signed in neither joins nor leaves", async () => {
    const directory = new FakeDirectory();
    const { accounts, announced, user } = setup({
      directory,
      tracked: ["eng@example.com"],
    });
    const bob = user("bob");
    directory.accounts.set(bob, { active: true, groups: ["eng@example.com"] });
    await accounts.refreshStanding({ userId: bob, force: true });
    directory.accounts.set(bob, { active: true, groups: [] });
    await accounts.refreshStanding({ userId: bob, force: true });
    directory.accounts.set(bob, { active: false, reason: "deleted" });
    expect(await accounts.refreshStanding({ userId: bob, force: true })).toBe(
      "disabled",
    );
    expect(announced).toEqual([]);
  });

  it("a group the server starts asking about is not a change, and a later change is one", async () => {
    const directory = new FakeDirectory();
    const tracked = ["eng@example.com"];
    const { accounts, announced, user } = setup({ directory, tracked });
    const cy = user("cy");
    directory.accounts.set(cy, {
      active: true,
      groups: ["eng@example.com", "oncall@example.com"],
    });
    await accounts.refreshStanding({ userId: cy, signIn: true });
    // A role mapping starts naming oncall: the directory now reports it.
    tracked.push("oncall@example.com");
    await accounts.refreshStanding({ userId: cy, force: true });
    directory.accounts.set(cy, {
      active: true,
      groups: ["oncall@example.com"],
    });
    await accounts.refreshStanding({ userId: cy, force: true });
    expect(
      announced.map((event) => ({ id: event.externalId, ...event.payload })),
    ).toEqual([
      expect.objectContaining({
        id: `directory.member-joined:${cy}:1`,
        groups: ["eng@example.com"],
      }),
      expect.objectContaining({
        id: `directory.groups-changed:${cy}:2`,
        groups: ["oncall@example.com"],
        added: [],
        removed: ["eng@example.com"],
      }),
    ]);
  });

  it("the sweep notices a departure of a member who is not signed in", async () => {
    const directory = new FakeDirectory();
    const { accounts, announced, user } = setup({ directory });
    const dee = user("dee");
    await accounts.refreshStanding({ userId: dee, signIn: true });
    directory.accounts.set(dee, { active: false, reason: "suspended" });
    const sweep = await accounts.sweep();
    expect(sweep.disabled).toBeGreaterThanOrEqual(1);
    expect(announced.map((event) => event.externalId)).toContain(
      `directory.member-left:${dee}:2`,
    );
    // Restored, they join again at their next sign-in, not before.
    directory.accounts.delete(dee);
    await accounts.sweep();
    expect(announced).toHaveLength(2);
    await accounts.refreshStanding({ userId: dee, signIn: true });
    expect(announced.map((event) => event.externalId)).toEqual([
      `directory.member-joined:${dee}:1`,
      `directory.member-left:${dee}:2`,
      `directory.member-joined:${dee}:3`,
    ]);
  });
});
