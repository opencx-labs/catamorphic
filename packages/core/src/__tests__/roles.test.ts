import { describe, expect, it } from "vitest";
import {
  expandRole,
  expandRolePermissions,
  fillTemplate,
  validateRoleDefinition,
} from "../services/roles-service.js";

describe("roles as files (ADR 0055): expansion", () => {
  it("fills placeholders from grants, one ref per value, nothing when ungranted", () => {
    expect(fillTemplate("docs/**", {})).toEqual(["docs/**"]);
    expect(
      fillTemplate("store/customers/{customer}/**", {
        customer: ["acme", "globex"],
      }),
    ).toEqual(["store/customers/acme/**", "store/customers/globex/**"]);
    // An unfilled placeholder grants nothing — never a wildcard.
    expect(fillTemplate("store/customers/{customer}/**", {})).toEqual([]);
    expect(
      fillTemplate("store/customers/{customer}/**", { customer: [] }),
    ).toEqual([]);
    // Cartesian over several params; a repeated param fills consistently.
    expect(
      fillTemplate("{region}/{customer}/{customer}", {
        region: ["eu", "us"],
        customer: ["acme"],
      }),
    ).toEqual(["eu/acme/acme", "us/acme/acme"]);
  });

  it("expands a role into scope refs", () => {
    const csm = validateRoleDefinition({
      version: 1,
      name: "CSM",
      agents: [
        "csm-assistant",
        { name: "notifier", toolPolicies: { slack: { default: "ask" } } },
      ],
      workflows: ["crm.lookup", "docs.search"],
      apps: ["customer-tracker"],
      documents: [
        "docs/**",
        { path: "store/customers/{customer}/**", access: "write" },
      ],
    });
    if ("error" in csm) throw new Error(csm.error);
    expect(
      expandRole(csm.definition, "p1", { customer: ["acme", "globex"] }),
    ).toEqual([
      { kind: "agent", projectId: "p1", name: "csm-assistant" },
      {
        kind: "agent",
        projectId: "p1",
        name: "notifier",
        toolPolicies: { slack: { default: "ask" } },
      },
      { kind: "workflow", projectId: "p1", name: "crm.lookup" },
      { kind: "workflow", projectId: "p1", name: "docs.search" },
      { kind: "app", projectId: "p1", name: "customer-tracker" },
      { kind: "document", projectId: "p1", path: "docs/**" },
      {
        kind: "document",
        projectId: "p1",
        path: "store/customers/acme/**",
        access: "write",
      },
      {
        kind: "document",
        projectId: "p1",
        path: "store/customers/globex/**",
        access: "write",
      },
    ]);
    // Without a customer grant the CSM sees the docs and no customer at all.
    expect(
      expandRole(csm.definition, "p1", {}).filter((r) => r.kind === "document"),
    ).toEqual([{ kind: "document", projectId: "p1", path: "docs/**" }]);
  });

  it("an admin role is plain grants: `*` artifacts, `*` permissions, store by document refs", () => {
    const admin = validateRoleDefinition({
      version: 1,
      name: "Admin",
      agents: ["*"],
      workflows: ["*"],
      apps: ["*"],
      permissions: ["*"],
      documents: ["store/**"],
    });
    if ("error" in admin) throw new Error(admin.error);
    expect(expandRole(admin.definition, "p1", {})).toEqual([
      { kind: "agent", projectId: "p1", name: "*" },
      { kind: "workflow", projectId: "p1", name: "*" },
      { kind: "app", projectId: "p1", name: "*" },
      { kind: "document", projectId: "p1", path: "store/**" },
    ]);
    expect(expandRolePermissions(admin.definition, "p1")).toEqual([
      { projectId: "p1", permission: "*" },
    ]);
  });

  it("expands permissions as granted: concrete, `thing:*`, and embedder names", () => {
    const teamAdmin = validateRoleDefinition({
      version: 1,
      name: "Team admin",
      permissions: ["memberships:write", "roles:*", "brain:maintain"],
    });
    if ("error" in teamAdmin) throw new Error(teamAdmin.error);
    expect(expandRole(teamAdmin.definition, "p1", {})).toEqual([]);
    expect(expandRolePermissions(teamAdmin.definition, "p1")).toEqual([
      { projectId: "p1", permission: "memberships:write" },
      { projectId: "p1", permission: "roles:*" },
      { projectId: "p1", permission: "brain:maintain" },
    ]);
  });

  it("rejects the retired builder flag and malformed permissions", () => {
    expect(
      validateRoleDefinition({ version: 1, name: "Old", builder: true }),
    ).toMatchObject({ error: expect.stringMatching(/builder/) });
    for (const permission of [
      "program",
      "Program:read",
      "program:read:x",
      "*:read",
    ]) {
      expect(
        validateRoleDefinition({
          version: 1,
          name: "x",
          permissions: [permission],
        }),
      ).toMatchObject({ error: expect.stringMatching(/permission/i) });
    }
  });

  it("rejects unsupported versions and malformed files with a readable error", () => {
    expect(validateRoleDefinition({ version: 2, name: "x" })).toMatchObject({
      error: expect.stringMatching(/version 2/),
    });
    expect(validateRoleDefinition({ version: 1 })).toMatchObject({
      error: expect.stringMatching(/^name/),
    });
    expect(
      validateRoleDefinition({
        version: 1,
        name: "x",
        documents: [{ path: "a", access: "admin" }],
      }),
    ).toMatchObject({ error: expect.stringMatching(/documents\.0/) });
    expect(
      validateRoleDefinition({
        version: 1,
        name: "x",
        permissions: ["not-namespaced"],
      }),
    ).toMatchObject({ error: expect.stringMatching(/permissions\.0/) });
  });
});
