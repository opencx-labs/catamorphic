import { describe, expect, it } from "vitest";
import {
  type Identity,
  PROJECT_PRINCIPAL_ID,
  projectPrincipalIdentity,
} from "../identity.js";
import { queuedRunOwner } from "../services/runs-service.js";

/*
 * Who starts a queued run that has no enablement (ADR 0325): never more
 * than the identity that enrolled it held, and never more than its member
 * holds now.
 */

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

describe("queuedRunOwner", () => {
  it("narrows a member's current identity to what the enrolling identity held", () => {
    // An agent acting for Ada enrolled the run: one workflow, the default
    // Environment, no connection.
    const owner = {
      scope: [{ kind: "workflow" as const, projectId, name: "publish" }],
      executionScope: [{ projectId, name: "default" }],
      connectionScope: [],
      projectPermissions: [{ projectId, permission: "runs:read" }],
    };
    // Ada herself, now, holds much more.
    const live: Identity = {
      tenantId,
      externalUserId: "ada",
      scope: [
        { kind: "workflow", projectId, name: "*" },
        { kind: "agent", projectId, name: "*" },
      ],
      executionScope: [{ projectId, name: "*" }],
      connectionScope: [{ projectId, environment: "*", alias: "*" }],
      projectPermissions: [{ projectId, permission: "*" }],
    };
    expect(
      queuedRunOwner({ tenantId, externalUserId: "ada", owner, live }),
    ).toEqual({
      tenantId,
      externalUserId: "ada",
      scope: owner.scope,
      executionScope: owner.executionScope,
      connectionScope: [],
      projectPermissions: owner.projectPermissions,
    });
  });

  it("gives no Environment or connection to a run whose scoped enroller held none", () => {
    // An identity scoped to one workflow, with no Environment or
    // connection of its own, queued the run.
    const owner = {
      scope: [{ kind: "workflow" as const, projectId, name: "publish" }],
    };
    const live: Identity = {
      tenantId,
      externalUserId: "ada",
      scope: [{ kind: "workflow", projectId, name: "*" }],
      executionScope: [{ projectId, name: "*" }],
      connectionScope: [{ projectId, environment: "*", alias: "*" }],
    };
    expect(
      queuedRunOwner({ tenantId, externalUserId: "ada", owner, live }),
    ).toMatchObject({ executionScope: [], connectionScope: [] });
  });

  it("drops what the member lost since enrolling", () => {
    const owner = {
      scope: [{ kind: "workflow" as const, projectId, name: "publish" }],
      executionScope: [{ projectId, name: "review" }],
      connectionScope: [{ projectId, environment: "review", alias: "github" }],
    };
    const live: Identity = {
      tenantId,
      externalUserId: "ada",
      scope: [{ kind: "workflow", projectId, name: "publish" }],
      executionScope: [{ projectId, name: "default" }],
      connectionScope: [],
    };
    expect(
      queuedRunOwner({ tenantId, externalUserId: "ada", owner, live }),
    ).toMatchObject({ executionScope: [], connectionScope: [] });
    // A member who may no longer act, or someone else, starts nothing.
    expect(
      queuedRunOwner({ tenantId, externalUserId: "ada", owner, live: null }),
    ).toBeNull();
    expect(
      queuedRunOwner({
        tenantId,
        externalUserId: "ada",
        owner,
        live: { ...live, externalUserId: "grace" },
      }),
    ).toBeNull();
  });

  it("starts a project automation as the project principal it enrolled as", () => {
    const principal = projectPrincipalIdentity({
      tenantId,
      projectId,
      environment: "github-poster",
      workflowName: "publish",
      connections: [{ alias: "github", capabilities: ["create_review"] }],
      permissions: ["sessions:read"],
    });
    const { tenantId: _tenant, externalUserId: _id, ...owner } = principal;
    expect(
      queuedRunOwner({
        tenantId,
        externalUserId: PROJECT_PRINCIPAL_ID,
        owner,
        live: undefined,
      }),
    ).toEqual(principal);
  });

  it("starts the host root's run as the host root", () => {
    expect(
      queuedRunOwner({
        tenantId,
        externalUserId: "host",
        owner: undefined,
        live: undefined,
      }),
    ).toEqual({ tenantId, externalUserId: "host" });
  });
});
