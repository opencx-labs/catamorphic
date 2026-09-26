import type { Identity, ProjectRoleEntry } from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import type { WorkAuthUser } from "../auth/work-auth.js";
import { grantWorkMembership, provisionWorkUser } from "./provision.js";

const operatorIdentity: Identity = {
  tenantId: "00000000-0000-4000-8000-0000000005e1",
  externalUserId: "work-operator",
};

const user: WorkAuthUser = {
  id: "better-auth-user-id",
  email: "ada@local.invalid",
  emailVerified: false,
  name: "Ada Lovelace",
  username: "ada",
};

describe("provisionWorkUser", () => {
  it("creates one auth user and grants existing committed roles", async () => {
    const createLocalUser = vi.fn(async () => user);
    const roles: ProjectRoleEntry[] = [
      { slug: "builder", definition: { version: 1, name: "Builder" } },
    ];
    const listRoles = vi.fn(async () => roles);
    const grantMembership = vi.fn(async (input) => ({
      ...input,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    }));

    const result = await provisionWorkUser({
      auth: { createLocalUser },
      services: {
        roles: { list: listRoles },
        memberships: { grant: grantMembership },
      },
      operatorIdentity,
      input: {
        username: "ada",
        name: "Ada Lovelace",
        password: "correct horse battery staple",
        memberships: [
          {
            projectId: "project-1",
            roles: ["builder"],
            grants: { user: ["ada"] },
          },
        ],
      },
    });

    expect(createLocalUser).toHaveBeenCalledOnce();
    expect(grantMembership).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: "project-1",
      externalUserId: user.id,
      roles: ["builder"],
      grants: { user: ["ada"] },
    });
    expect(result.user.id).toBe(user.id);
    expect(result.memberships).toHaveLength(1);
  });

  it("rejects an unknown role before creating the auth user", async () => {
    const createLocalUser = vi.fn(async () => user);

    await expect(
      provisionWorkUser({
        auth: { createLocalUser },
        services: {
          roles: { list: async () => [] },
          memberships: { grant: vi.fn() },
        },
        operatorIdentity,
        input: {
          username: "ada",
          name: "Ada Lovelace",
          password: "correct horse battery staple",
          memberships: [{ projectId: "project-1", roles: ["builder"] }],
        },
      }),
    ).rejects.toThrow(
      'Project project-1 has no valid committed role "builder"',
    );
    expect(createLocalUser).not.toHaveBeenCalled();
  });
});

describe("grantWorkMembership", () => {
  const roles: ProjectRoleEntry[] = [
    { slug: "admin", definition: { version: 1, name: "Admin" } },
  ];
  const services = (grant = vi.fn(async (input) => ({ ...input }))) => ({
    roles: { list: vi.fn(async () => roles) },
    memberships: { grant },
  });

  it("binds a signed-in user found by verified email", async () => {
    const grant = vi.fn(async (input) => ({ ...input }));
    const verified = { ...user, email: "ada@example.com", emailVerified: true };
    const result = await grantWorkMembership({
      auth: { findUserByEmail: vi.fn(async () => verified) },
      services: services(grant),
      operatorIdentity,
      input: {
        email: "ada@example.com",
        projectId: "project-1",
        roles: ["admin"],
      },
    });
    expect(result.user.id).toBe(user.id);
    expect(grant).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: "project-1",
      externalUserId: user.id,
      roles: ["admin"],
    });
  });

  it("refuses unverified or unknown emails and uncommitted roles", async () => {
    const input = {
      email: "ada@example.com",
      projectId: "project-1",
      roles: ["admin"],
    };
    await expect(
      grantWorkMembership({
        auth: { findUserByEmail: vi.fn(async () => user) },
        services: services(),
        operatorIdentity,
        input,
      }),
    ).rejects.toThrow(/signed in/);
    await expect(
      grantWorkMembership({
        auth: { findUserByEmail: vi.fn(async () => null) },
        services: services(),
        operatorIdentity,
        input,
      }),
    ).rejects.toThrow(/signed in/);
    await expect(
      grantWorkMembership({
        auth: { findUserByEmail: vi.fn(async () => user) },
        services: services(),
        operatorIdentity,
        input: { ...input, roles: ["owner"] },
      }),
    ).rejects.toThrow(/no valid committed role "owner"/);
  });
});
