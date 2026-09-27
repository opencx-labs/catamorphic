import type { Identity, Project, ProjectRoleEntry } from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import {
  ProvisionWorkProjectInputSchema,
  provisionWorkProject,
} from "./provision-project.js";

const operatorIdentity: Identity = {
  tenantId: "00000000-0000-4000-8000-0000000005e1",
  externalUserId: "work-setup-agent",
};

const MEMBER = { version: 1 as const, name: "Member", agents: ["assistant"] };
const MANAGER = {
  version: 1 as const,
  name: "Manager",
  permissions: ["memberships:write", "roles:write"],
};

function project(over: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    tenantId: operatorIdentity.tenantId,
    name: "Brain",
    storageType: "managed",
    remoteUrl: null,
    remoteOwnership: null,
    remoteDivergedAt: null,
    defaultBranch: "main",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...over,
  };
}

const imported = project({
  remoteUrl: "https://github.com/acme/brain.git",
  remoteOwnership: "attached",
});

function services(repositoryRoles: ProjectRoleEntry[] = []) {
  return {
    codeHosts: { importRepository: vi.fn(async () => imported) },
    projects: { create: vi.fn(async () => project()) },
    deployment: { deploy: vi.fn(async () => ({ commitSha: "abc123" })) },
    roles: {
      list: vi.fn(async () => repositoryRoles),
      invalidate: vi.fn(),
    },
    proposals: {
      propose: vi.fn(async () => ({
        branch: "work/proposals/work-setup-agent/configure-work-roles-1",
        pullRequest: { url: "https://github.com/acme/brain/pull/3", number: 3 },
      })),
    },
    admission: { setPolicy: vi.fn(async () => undefined) },
  };
}

const admission = {
  mode: "invitation_only" as const,
  defaultRole: "member",
  approvedDomains: [],
};

describe("provisionWorkProject", () => {
  it("creates a project, commits explicit roles, and configures admission", async () => {
    const provided = services();

    const result = await provisionWorkProject({
      services: provided,
      operatorIdentity,
      input: {
        name: "Brain",
        roles: [
          { slug: "member", definition: MEMBER },
          { slug: "manager", definition: MANAGER },
        ],
        admission,
      },
    });

    expect(provided.projects.create).toHaveBeenCalledWith(operatorIdentity, {
      name: "Brain",
    });
    expect(provided.deployment.deploy).toHaveBeenCalledWith(
      operatorIdentity.tenantId,
      "project-1",
      operatorIdentity.externalUserId,
      {
        message: "Configure project roles",
        files: {
          ".work/roles/manager.json": expect.stringContaining('"Manager"'),
          ".work/roles/member.json": expect.stringContaining('"Member"'),
        },
      },
    );
    expect(provided.roles.invalidate).toHaveBeenCalledWith("project-1");
    expect(provided.admission.setPolicy).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: "project-1",
      mode: "invitation_only",
      defaultRole: "member",
      approvedDomains: [],
      directoryRoles: [],
    });
    expect(result.project).toMatchObject({ id: "project-1", name: "Brain" });
    expect(result.roles).toEqual({
      source: "committed",
      slugs: ["manager", "member"],
    });
  });

  it("proposes roles to an attached repository instead of committing to it", async () => {
    const provided = services();

    const result = await provisionWorkProject({
      services: provided,
      operatorIdentity,
      input: {
        name: "Brain",
        repository: "acme/brain",
        roles: [
          { slug: "member", definition: MEMBER },
          { slug: "manager", definition: MANAGER },
        ],
        admission,
      },
    });

    // The organization's service connection clones it (ADR 0177).
    expect(provided.codeHosts.importRepository).toHaveBeenCalledWith({
      identity: operatorIdentity,
      provider: "github",
      name: "Brain",
      fullName: "acme/brain",
      principal: "service",
    });
    // Nothing is committed to the repository's default branch.
    expect(provided.deployment.deploy).not.toHaveBeenCalled();
    expect(provided.proposals.propose).toHaveBeenCalledWith({
      identity: operatorIdentity,
      projectId: "project-1",
      title: "Configure Work roles",
      body: expect.stringContaining(".work/roles/"),
      changes: [
        {
          path: ".work/roles/manager.json",
          content: expect.stringContaining('"Manager"'),
        },
        {
          path: ".work/roles/member.json",
          content: expect.stringContaining('"Member"'),
        },
      ],
    });
    // The policy names roles that take effect when the pull request merges.
    expect(provided.admission.setPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        defaultRole: "member",
        pendingRoles: { manager: MANAGER, member: MEMBER },
      }),
    );
    expect(result.roles).toEqual({
      source: "proposed",
      slugs: ["manager", "member"],
      branch: "work/proposals/work-setup-agent/configure-work-roles-1",
      pullRequest: { url: "https://github.com/acme/brain/pull/3", number: 3 },
    });
  });

  it("uses the roles an attached repository already defines as they are", async () => {
    const provided = services([
      { slug: "member", definition: MEMBER },
      { slug: "broken", invalid: { error: "bad" } },
    ]);

    const result = await provisionWorkProject({
      services: provided,
      operatorIdentity,
      input: { name: "Brain", repository: "acme/brain", admission },
    });

    expect(provided.deployment.deploy).not.toHaveBeenCalled();
    expect(provided.proposals.propose).not.toHaveBeenCalled();
    expect(provided.admission.setPolicy).toHaveBeenCalledWith(
      expect.not.objectContaining({ pendingRoles: expect.anything() }),
    );
    expect(result.roles).toEqual({ source: "repository", slugs: ["member"] });
  });

  it("asks for roles when an attached repository defines none", async () => {
    const provided = services();

    await expect(
      provisionWorkProject({
        services: provided,
        operatorIdentity,
        input: { name: "Brain", repository: "acme/brain", admission },
      }),
    ).rejects.toThrow("defines no roles");
    expect(provided.deployment.deploy).not.toHaveBeenCalled();
    expect(provided.proposals.propose).not.toHaveBeenCalled();
  });

  it("requires roles for a project the server creates", () => {
    expect(
      ProvisionWorkProjectInputSchema.safeParse({ name: "Brain", admission })
        .success,
    ).toBe(false);
    expect(
      ProvisionWorkProjectInputSchema.safeParse({
        name: "Brain",
        repository: "acme/brain",
        admission,
      }).success,
    ).toBe(true);
  });

  it("rejects an admission role that is not supplied", async () => {
    const provided = services();

    await expect(
      provisionWorkProject({
        services: provided,
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
    expect(provided.projects.create).not.toHaveBeenCalled();
  });
});
