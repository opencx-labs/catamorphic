import { describe, expect, it } from "vitest";
import {
  type Identity,
  PROJECT_PRINCIPAL_ID,
  projectPrincipalIdentity,
} from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import {
  chatOwner,
  defaultDeliveryKey,
  keyedChatOwnerId,
  parseChatDelivery,
  parseChatKey,
} from "../services/chat-delivery.js";
import { projectAdmin } from "./project-admin.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const tenantId = "tenant";
const alice: Identity = {
  tenantId,
  externalUserId: "alice",
  scope: [{ kind: "agent", projectId, name: "assistant" }],
};
const admin: Identity = {
  tenantId,
  externalUserId: "admin",
  ...projectAdmin(projectId),
};
const bob: Identity = { ...alice, externalUserId: "bob" };
const projectCaller = projectPrincipalIdentity({
  tenantId,
  projectId,
  environment: "production",
  connections: [{ alias: "github" }],
});
const resolveMember = async ({ externalUserId }: { externalUserId: string }) =>
  externalUserId === "bob" ? bob : null;
const owner = (
  input: Pick<
    Parameters<typeof chatOwner>[0],
    "caller" | "audience" | "enablement"
  >,
) => chatOwner({ ...input, projectId, resolveMember });

describe("parseChatDelivery", () => {
  it("names a chat by id or by key, never both or neither", () => {
    expect(
      parseChatDelivery({
        sessionId: "s1",
        content: "Hi",
        mode: "message_only",
      }),
    ).toEqual({ sessionId: "s1", content: "Hi", mode: "message_only" });
    expect(
      parseChatDelivery({
        key: " pr-7 ",
        audience: "project",
        agentSlug: "reviewer",
        content: "Review PR 7",
        notification: { title: "Review ready" },
      }),
    ).toEqual({
      key: "pr-7",
      audience: "project",
      agentSlug: "reviewer",
      content: "Review PR 7",
      mode: "next_turn",
      notification: { title: "Review ready" },
    });
    expect(() =>
      parseChatDelivery({ sessionId: "s1", key: "k", content: "x" }),
    ).toThrow("exactly one of sessionId or key");
    expect(() => parseChatDelivery({ content: "x" })).toThrow(
      "exactly one of sessionId or key",
    );
    expect(() =>
      parseChatDelivery({ sessionId: "s1", audience: "project", content: "x" }),
    ).toThrow("audience applies only to a chat named by key");
    expect(() =>
      parseChatDelivery({ key: "k", audience: "team", content: "x" }),
    ).toThrow('audience must be "project"');
  });

  it("keys are the project's names for chats: 1 to 200 characters, no control characters", () => {
    expect(parseChatKey("pr-42")).toBe("pr-42");
    expect(parseChatKey("incident/2026-09 #7")).toBe("incident/2026-09 #7");
    expect(() => parseChatKey("")).toThrow("must not be empty");
    expect(() => parseChatKey("x".repeat(201))).toThrow("at most 200");
    expect(() => parseChatKey("pr-\n42")).toThrow("control characters");
    expect(() => parseChatDelivery({ key: "a\u0000b", content: "x" })).toThrow(
      "control characters",
    );
  });

  it("a key lookup names the caller's chat, the project chat, or a member's", () => {
    expect(keyedChatOwnerId({ caller: alice, audience: undefined })).toBe(
      "alice",
    );
    expect(keyedChatOwnerId({ caller: alice, audience: "project" })).toBe(
      PROJECT_PRINCIPAL_ID,
    );
    expect(
      keyedChatOwnerId({ caller: projectCaller, audience: undefined }),
    ).toBe(PROJECT_PRINCIPAL_ID);
    expect(
      keyedChatOwnerId({ caller: alice, audience: { member: "bob" } }),
    ).toBe("bob");
  });

  it("defaults the idempotency key to one delivery per run, chat and content", () => {
    const key = (content: string) =>
      defaultDeliveryKey({ runId: "r1", chat: "pr-7", content });
    expect(key("Review PR 7")).toBe(key("Review PR 7"));
    expect(key("Review PR 7")).not.toBe(key("PR 7 was updated"));
  });
});

describe("delivery approvers (ADR 0176)", () => {
  it("names members and roles who answer an unattended chat's escalations", () => {
    expect(
      parseChatDelivery({
        key: "pr-42",
        content: "Review this pull request",
        audience: "project",
        approvers: {
          members: ["alice", "alice", " bob "],
          roles: ["reviewer"],
        },
      }),
    ).toMatchObject({
      approvers: { members: ["alice", "bob"], roles: ["reviewer"] },
    });
    expect(
      parseChatDelivery({
        sessionId: "s1",
        content: "Again",
        approvers: { roles: ["oncall"] },
      }),
    ).toMatchObject({ approvers: { roles: ["oncall"] } });
  });

  it.each([
    [{}, "at least one"],
    [{ members: [] }, "at least one"],
    [{ members: "alice" }, "approvers.members"],
    [{ roles: [""] }, "approvers.roles"],
    [["alice"], "approvers must be"],
  ])("rejects %j", (approvers, message) => {
    expect(() =>
      parseChatDelivery({ key: "k", content: "c", approvers }),
    ).toThrow(message);
  });
});

describe("chatOwner", () => {
  it("a member's automation reaches that member; others take declared permissions", async () => {
    const enablement = {
      owner_kind: "member",
      owner_external_user_id: "alice",
    };
    await expect(
      owner({ caller: alice, audience: undefined, enablement }),
    ).resolves.toBe(alice);
    await expect(
      owner({ caller: alice, audience: { member: "alice" }, enablement }),
    ).resolves.toBe(alice);
    await expect(
      owner({ caller: alice, audience: "project", enablement }),
    ).rejects.toThrow("automations:write");
    await expect(
      owner({ caller: alice, audience: { member: "bob" }, enablement }),
    ).rejects.toThrow("sessions:write");
    // The run holds sessions:write because the workflow declared it.
    const declaring: Identity = {
      ...alice,
      projectPermissions: [{ projectId, permission: "sessions:write" }],
    };
    await expect(
      owner({ caller: declaring, audience: { member: "bob" }, enablement }),
    ).resolves.toBe(bob);
    await expect(
      owner({
        caller: declaring,
        audience: { member: "mallory" },
        enablement,
      }),
    ).rejects.toThrow("mallory is not a member");
  });

  it("a project automation reaches the project chat with its connections, or a named member", async () => {
    const enablement = { owner_kind: "project", owner_external_user_id: null };
    // The chat is placed by its own Environment, not the automation's: the
    // project's own chats may run in any Environment the project declares.
    await expect(
      owner({ caller: projectCaller, audience: undefined, enablement }),
    ).resolves.toEqual({
      ...projectCaller,
      executionScope: [{ projectId, name: "*" }],
    });
    expect(projectCaller.connectionScope).toEqual([
      { projectId, environment: "production", alias: "github" },
    ]);
    await expect(
      owner({ caller: projectCaller, audience: { member: "bob" }, enablement }),
    ).resolves.toBe(bob);
    await expect(
      owner({
        caller: projectCaller,
        audience: { member: "mallory" },
        enablement,
      }),
    ).rejects.toThrow("mallory is not a member");
  });

  it("a hand-started run reaches its caller; the project chat takes automations:write", async () => {
    await expect(
      owner({ caller: alice, audience: undefined, enablement: undefined }),
    ).resolves.toBe(alice);
    await expect(
      owner({ caller: alice, audience: "project", enablement: undefined }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      owner({
        caller: alice,
        audience: { member: "bob" },
        enablement: undefined,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      owner({ caller: admin, audience: "project", enablement: undefined }),
    ).resolves.toMatchObject({
      externalUserId: PROJECT_PRINCIPAL_ID,
      scope: [{ kind: "agent", projectId, name: "*" }],
      executionScope: [{ projectId, name: "*" }],
      projectPermissions: [],
    });
  });
});
