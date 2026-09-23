import { describe, expect, it } from "vitest";
import { type Identity, TEAM_PRINCIPAL_ID, teamIdentity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { wakeAudience } from "../services/wake-audience.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const tenantId = "tenant";
const alice: Identity = {
  tenantId,
  externalUserId: "alice",
  scope: [{ kind: "agent", projectId, name: "assistant" }],
};
const builder: Identity = {
  tenantId,
  externalUserId: "builder",
  scope: [{ kind: "project", projectId }],
};
const bob: Identity = { ...alice, externalUserId: "bob" };
const teamCaller = teamIdentity({
  tenantId,
  projectId,
  environment: "production",
  connections: [{ alias: "github" }],
});
const resolveMember = async ({ externalUserId }: { externalUserId: string }) =>
  externalUserId === "bob" ? bob : null;
const wake = (
  input: Pick<
    Parameters<typeof wakeAudience>[0],
    "caller" | "audience" | "enablement"
  >,
) =>
  wakeAudience({
    ...input,
    projectId,
    environment: "production",
    resolveMember,
  });

describe("wakeAudience", () => {
  it("a member's automation wakes only that member", async () => {
    const enablement = {
      owner_kind: "member",
      owner_external_user_id: "alice",
    };
    await expect(
      wake({ caller: alice, audience: undefined, enablement }),
    ).resolves.toBe(alice);
    await expect(
      wake({ caller: alice, audience: { member: "alice" }, enablement }),
    ).resolves.toBe(alice);
    await expect(
      wake({ caller: alice, audience: "team", enablement }),
    ).rejects.toThrow("enable it for the team");
    await expect(
      wake({ caller: alice, audience: { member: "bob" }, enablement }),
    ).rejects.toThrow("only that member's chat");
  });

  it("a team automation wakes the team's chat with its connections, or a named member", async () => {
    const enablement = { owner_kind: "team", owner_external_user_id: null };
    await expect(
      wake({ caller: teamCaller, audience: undefined, enablement }),
    ).resolves.toBe(teamCaller);
    expect(teamCaller.connectionScope).toEqual([
      { projectId, environment: "production", alias: "github" },
    ]);
    await expect(
      wake({ caller: teamCaller, audience: { member: "bob" }, enablement }),
    ).resolves.toBe(bob);
    await expect(
      wake({ caller: teamCaller, audience: { member: "mallory" }, enablement }),
    ).rejects.toThrow("mallory is not a member");
  });

  it("a hand-started run wakes its caller; only a builder wakes the team", async () => {
    await expect(
      wake({ caller: alice, audience: undefined, enablement: undefined }),
    ).resolves.toBe(alice);
    await expect(
      wake({ caller: alice, audience: "team", enablement: undefined }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      wake({
        caller: alice,
        audience: { member: "bob" },
        enablement: undefined,
      }),
    ).rejects.toThrow("only its caller's chat");
    await expect(
      wake({ caller: builder, audience: "team", enablement: undefined }),
    ).resolves.toMatchObject({
      externalUserId: TEAM_PRINCIPAL_ID,
      scope: [{ kind: "project", projectId }],
      executionScope: [{ projectId, name: "production" }],
    });
  });
});
