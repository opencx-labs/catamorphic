import type { Identity } from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import { provisionStockProject } from "./provision-project.js";

const operatorIdentity: Identity = {
  tenantId: "00000000-0000-4000-8000-0000000005e1",
  externalUserId: "stock-setup-agent",
};

describe("provisionStockProject", () => {
  it("creates a project, commits explicit roles, and configures admission", async () => {
    const create = vi.fn(async () => ({
      id: "project-1",
      tenantId: operatorIdentity.tenantId,
      name: "Brain",
      storageType: "managed" as const,
      remoteUrl: null,
      defaultBranch: "main",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    }));
    const deploy = vi.fn(async () => ({ commitSha: "abc123" }));
    const invalidate = vi.fn();
    const setPolicy = vi.fn(async () => undefined);

    const result = await provisionStockProject({
      services: {
        projects: { create },
        deployment: { deploy },
        roles: { invalidate },
        admission: { setPolicy },
      },
      operatorIdentity,
      input: {
        name: "Brain",
        roles: [
          {
            slug: "member",
            definition: {
              version: 1,
              name: "Member",
              agents: ["assistant"],
            },
          },
          {
            slug: "manager",
            definition: {
              version: 1,
              name: "Manager",
              permissions: ["memberships:manage", "roles:manage"],
            },
          },
        ],
        admission: {
          mode: "invitation_only",
          defaultRole: "member",
          approvedDomains: [],
        },
      },
    });

    expect(create).toHaveBeenCalledWith(operatorIdentity, { name: "Brain" });
    expect(deploy).toHaveBeenCalledWith(
      operatorIdentity.tenantId,
      "project-1",
      operatorIdentity.externalUserId,
      {
        message: "Configure project roles",
        files: {
          "roles/manager.json": expect.stringContaining('"Manager"'),
          "roles/member.json": expect.stringContaining('"Member"'),
        },
      },
    );
    expect(invalidate).toHaveBeenCalledWith("project-1");
    expect(setPolicy).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: "project-1",
      mode: "invitation_only",
      defaultRole: "member",
      approvedDomains: [],
    });
    expect(result.project).toMatchObject({ id: "project-1", name: "Brain" });
  });

  it("rejects an admission role that is not supplied", async () => {
    const create = vi.fn();

    await expect(
      provisionStockProject({
        services: {
          projects: { create },
          deployment: { deploy: vi.fn() },
          roles: { invalidate: vi.fn() },
          admission: { setPolicy: vi.fn() },
        },
        operatorIdentity,
        input: {
          name: "Brain",
          roles: [
            {
              slug: "manager",
              definition: { version: 1, name: "Manager" },
            },
          ],
          admission: {
            mode: "open",
            defaultRole: "member",
            approvedDomains: [],
          },
        },
      }),
    ).rejects.toThrow("Admission default role");
    expect(create).not.toHaveBeenCalled();
  });
});
