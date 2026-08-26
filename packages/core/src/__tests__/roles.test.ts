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

  it("builder: true is a project ref; store access is still by document refs only", () => {
    const admin = validateRoleDefinition({
      version: 1,
      name: "Admin",
      builder: true,
      documents: ["store/**"],
    });
    if ("error" in admin) throw new Error(admin.error);
    expect(expandRole(admin.definition, "p1", {})).toEqual([
      { kind: "project", projectId: "p1" },
      { kind: "document", projectId: "p1", path: "store/**" },
    ]);
    const engineer = validateRoleDefinition({
      version: 1,
      name: "Engineer",
      builder: true,
    });
    if ("error" in engineer) throw new Error(engineer.error);
    // An admin who may not see the store gets no document refs at all.
    expect(expandRole(engineer.definition, "p1", {})).toEqual([
      { kind: "project", projectId: "p1" },
    ]);
  });

  it("expands project administration independently from builder access", () => {
    const teamAdmin = validateRoleDefinition({
      version: 1,
      name: "Team admin",
      permissions: ["memberships:manage", "roles:manage"],
    });
    if ("error" in teamAdmin) throw new Error(teamAdmin.error);
    expect(expandRole(teamAdmin.definition, "p1", {})).toEqual([]);
    expect(expandRolePermissions(teamAdmin.definition, "p1")).toEqual([
      { projectId: "p1", permission: "memberships:manage" },
      { projectId: "p1", permission: "roles:manage" },
    ]);

    const builder = validateRoleDefinition({
      version: 1,
      name: "Builder",
      builder: true,
    });
    if ("error" in builder) throw new Error(builder.error);
    expect(expandRolePermissions(builder.definition, "p1")).toEqual([]);
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
  });
});
