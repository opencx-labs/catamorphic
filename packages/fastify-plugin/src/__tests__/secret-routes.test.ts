import {
  SecretMemberNotFoundError,
  SecretValueInvalidError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, TEST_IDENTITY } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const STATUS = {
  name: "CLICKHOUSE_API_KEY",
  description: "Your ClickHouse key",
  required: false,
  source: "project",
  environments: ["dev"],
  shared: true,
  updatedAt: "2026-10-06T00:00:00.000Z",
  setBy: "mia",
  own: false,
  ownUpdatedAt: null,
  members: [
    { member: "bob", updatedAt: "2026-10-06T00:00:00.000Z", setBy: "mia" },
  ],
};

function appWithSecrets(
  overrides: Record<string, (input: never) => Promise<unknown>> = {},
) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const record =
    (method: string, result: unknown) => async (input: unknown) => {
      calls.push({ method, input });
      return result;
    };
  const app = createTestApp({
    core: {
      secrets: {
        list: record("list", [STATUS]),
        upsert: record("upsert", STATUS),
        delete: record("delete", true),
        setMember: record("setMember", {
          name: "CLICKHOUSE_API_KEY",
          member: TEST_IDENTITY.externalUserId,
          updatedAt: "2026-10-06T00:00:00.000Z",
        }),
        deleteMember: record("deleteMember", true),
        ...overrides,
      },
    } as never,
  });
  apps.push(app);
  return { app, calls };
}

describe("project secret routes (ADR 0205)", () => {
  it("lists secrets with their Environments and values' metadata, never a value", async () => {
    const { app } = appWithSecrets();
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/secrets`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([STATUS]);
  });

  it("sets and clears the caller's own value at members/me", async () => {
    const { app, calls } = appWithSecrets();
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${PROJECT_ID}/secrets/CLICKHOUSE_API_KEY/members/me`,
      payload: { value: "own-key" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      name: "CLICKHOUSE_API_KEY",
      member: TEST_IDENTITY.externalUserId,
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "setMember",
      input: {
        projectId: PROJECT_ID,
        name: "CLICKHOUSE_API_KEY",
        member: TEST_IDENTITY.externalUserId,
        value: "own-key",
      },
    });
    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/projects/${PROJECT_ID}/secrets/CLICKHOUSE_API_KEY/members/bob`,
    });
    expect(cleared.json()).toEqual({ deleted: true });
    expect(calls.at(-1)).toMatchObject({
      method: "deleteMember",
      input: { member: "bob", name: "CLICKHOUSE_API_KEY" },
    });
  });

  it("refuses a stranger and a value that cannot be set, as the person's to fix", async () => {
    const stranger = appWithSecrets({
      setMember: async () => {
        throw new SecretMemberNotFoundError("eve");
      },
    });
    const missing = await stranger.app.inject({
      method: "PUT",
      url: `/api/projects/${PROJECT_ID}/secrets/CLICKHOUSE_API_KEY/members/eve`,
      payload: { value: "x" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toContain("eve is not a member");
    const invalid = appWithSecrets({
      upsert: async () => {
        throw new SecretValueInvalidError("too large");
      },
    });
    const refused = await invalid.app.inject({
      method: "PUT",
      url: `/api/projects/${PROJECT_ID}/secrets/CLICKHOUSE_API_KEY`,
      payload: { value: "x" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "too large" });
  });
});
