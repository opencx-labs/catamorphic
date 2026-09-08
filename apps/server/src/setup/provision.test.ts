import type { Identity, ProjectRoleEntry } from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import type { StockAuthUser } from "../auth/stock-auth.js";
import { provisionStockUser } from "./provision.js";

const operatorIdentity: Identity = {
  tenantId: "00000000-0000-4000-8000-0000000005e1",
  externalUserId: "stock-operator",
};

const user: StockAuthUser = {
  id: "better-auth-user-id",
  email: "ada@local.invalid",
  emailVerified: false,
  name: "Ada Lovelace",
  username: "ada",
};

describe("provisionStockUser", () => {
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

    const result = await provisionStockUser({
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
      provisionStockUser({
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
