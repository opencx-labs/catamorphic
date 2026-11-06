import { describe, expect, it } from "vitest";
import {
  type ArtifactRef,
  documentRefCovers,
  effectiveProjectPermissions,
  hasProjectPermission,
  type Identity,
  intersectProjectPermissions,
  intersectScope,
  narrowIdentity,
  permissionCovers,
  projectPrincipalIdentity,
  scopeCovers,
} from "../identity.js";
import { projectAdmin } from "./project-admin.js";

const projectId = "p1";
const base = { tenantId: "t", externalUserId: "u" };
const grants = (...permissions: string[]) =>
  permissions.map((permission) => ({ projectId, permission }));

describe("project permissions (ADR 0158)", () => {
  it("write and publish read; wildcards cover; nothing else implies", () => {
    expect(permissionCovers("program:write", "program:read")).toBe(true);
    expect(permissionCovers("program:publish", "program:read")).toBe(true);
    expect(permissionCovers("program:write", "program:publish")).toBe(false);
    expect(permissionCovers("program:publish", "program:write")).toBe(false);
    expect(permissionCovers("program:read", "program:write")).toBe(false);
    expect(permissionCovers("sessions:write", "program:read")).toBe(false);
    expect(permissionCovers("program:*", "program:publish")).toBe(true);
    expect(permissionCovers("program:*", "secrets:read")).toBe(false);
    expect(permissionCovers("*", "acme:approve_deals")).toBe(true);
    expect(permissionCovers("acme:approve", "acme:approve")).toBe(true);
  });

  it("root holds every permission; a scoped identity what its grants cover", () => {
    expect(hasProjectPermission(base, projectId, "roles:write")).toBe(true);
    const member: Identity = {
      ...base,
      scope: [],
      projectPermissions: grants("program:write"),
    };
    expect(hasProjectPermission(member, projectId, "program:read")).toBe(true);
    expect(hasProjectPermission(member, "p2", "program:read")).toBe(false);
    expect(hasProjectPermission(member, projectId, "secrets:read")).toBe(false);
    const admin: Identity = { ...base, ...projectAdmin(projectId) };
    expect(hasProjectPermission(admin, projectId, "roles:write")).toBe(true);
    expect(hasProjectPermission(admin, "p2", "roles:write")).toBe(false);
  });

  it("reports concrete effective permissions for clients", () => {
    const member: Identity = {
      ...base,
      scope: [],
      projectPermissions: grants("sessions:*", "program:write", "acme:ship"),
    };
    expect(effectiveProjectPermissions(member, projectId).sort()).toEqual(
      [
        "acme:ship",
        "program:read",
        "program:write",
        "sessions:read",
        "sessions:write",
      ].sort(),
    );
  });

  it("intersecting keeps what both hold and never widens", () => {
    const holder: Identity = {
      ...base,
      scope: [],
      projectPermissions: grants("program:read", "sessions:write"),
    };
    expect(
      intersectProjectPermissions(
        grants("program:write", "sessions:write", "secrets:read"),
        holder,
      ),
    ).toEqual(grants("program:read", "sessions:write"));
    expect(intersectProjectPermissions(grants("*"), holder)).toEqual(
      grants("program:read", "sessions:write"),
    );
    expect(
      intersectProjectPermissions(grants("sessions:read"), holder),
    ).toEqual(grants("sessions:read"));
  });

  it("intersecting a scope expands a `*` to the refs actually held", () => {
    const held: Identity = {
      ...base,
      scope: [
        { kind: "agent", projectId, name: "csm" },
        { kind: "workflow", projectId, name: "sync" },
      ],
    };
    expect(
      intersectScope(
        [
          { kind: "agent", projectId, name: "*", toolPolicies: {} },
          { kind: "workflow", projectId, name: "sync" },
          { kind: "app", projectId, name: "*" },
        ],
        held,
      ),
    ).toEqual([
      { kind: "agent", projectId, name: "csm", toolPolicies: {} },
      { kind: "workflow", projectId, name: "sync" },
    ]);
  });

  it("the project principal holds exactly its consented set", () => {
    const principal = projectPrincipalIdentity({
      tenantId: "t",
      projectId,
      environment: "production",
      workflowName: "triage",
      permissions: ["sessions:write"],
    });
    expect(hasProjectPermission(principal, projectId, "sessions:write")).toBe(
      true,
    );
    expect(hasProjectPermission(principal, projectId, "program:read")).toBe(
      false,
    );
    expect(
      scopeCovers(principal.scope ?? [], {
        kind: "workflow",
        projectId,
        name: "triage",
      }),
    ).toBe(true);
    expect(
      scopeCovers(principal.scope ?? [], {
        kind: "workflow",
        projectId,
        name: "other",
      }),
    ).toBe(false);
  });
});

describe("identity scope (ADR 0053 / 0055)", () => {
  it("agent refs cover by name, and `*` covers every agent of one project", () => {
    const scope: ArtifactRef[] = [
      { kind: "agent", projectId, name: "csm", toolPolicies: {} },
      { kind: "agent", projectId: "p2", name: "*" },
    ];
    expect(scopeCovers(scope, { kind: "agent", projectId, name: "csm" })).toBe(
      true,
    );
    expect(
      scopeCovers(scope, { kind: "agent", projectId, name: "sales" }),
    ).toBe(false);
    expect(
      scopeCovers(scope, { kind: "agent", projectId: "p2", name: "csm" }),
    ).toBe(true);
    expect(
      scopeCovers(scope, { kind: "workflow", projectId: "p2", name: "x" }),
    ).toBe(false);
  });

  it("a sessions ref covers the caller's sessions in one project only (ADR 0148)", () => {
    const scope = [
      { kind: "app" as const, projectId, name: "activity" },
      { kind: "sessions" as const, projectId },
    ];
    expect(scopeCovers(scope, { kind: "sessions", projectId })).toBe(true);
    expect(scopeCovers(scope, { kind: "sessions", projectId: "p2" })).toBe(
      false,
    );
    // It is not an agent ref: nothing about it names an agent or a project.
    expect(scopeCovers(scope, { kind: "agent", projectId, name: "csm" })).toBe(
      false,
    );
  });

  it("document refs cover subtrees, and write implies read", () => {
    const tree = {
      kind: "document" as const,
      projectId,
      path: "store/customers/acme/**",
      access: "write" as const,
    };
    const file = {
      kind: "document" as const,
      projectId,
      path: "docs/handbook.md",
    };
    const doc = (path: string, access?: "read" | "write") => ({
      kind: "document" as const,
      projectId,
      path,
      ...(access ? { access } : {}),
    });
    // Subtree: the folder itself and anything below it.
    expect(documentRefCovers(tree, doc("store/customers/acme"))).toBe(true);
    expect(documentRefCovers(tree, doc("store/customers/acme/notes.md"))).toBe(
      true,
    );
    expect(
      documentRefCovers(tree, doc("store/customers/acme/2026/q1.md", "write")),
    ).toBe(true);
    // Not a sibling that merely shares a prefix string.
    expect(documentRefCovers(tree, doc("store/customers/acme-corp/x.md"))).toBe(
      false,
    );
    expect(documentRefCovers(tree, doc("store/customers/globex/x.md"))).toBe(
      false,
    );
    // A single-file ref covers that file, read only.
    expect(documentRefCovers(file, doc("docs/handbook.md"))).toBe(true);
    expect(documentRefCovers(file, doc("docs/handbook.md", "write"))).toBe(
      false,
    );
    expect(documentRefCovers(file, doc("docs/handbook.md/x"))).toBe(false);
    // Another project never matches.
    expect(
      documentRefCovers(tree, {
        ...doc("store/customers/acme/a"),
        projectId: "p2",
      }),
    ).toBe(false);
    // scopeCovers routes document refs through subtree semantics.
    expect(scopeCovers([tree, file], doc("store/customers/acme/a.md"))).toBe(
      true,
    );
    expect(scopeCovers([tree, file], doc("docs/other.md"))).toBe(false);
  });

  it("narrowing keeps working with the new kinds", () => {
    const admin: Identity = {
      ...base,
      ...projectAdmin(projectId),
    };
    const inApp = narrowIdentity(admin, { kind: "app", projectId, name: "x" });
    // An admin narrowed into an app is confined to it: no `*` refs left.
    expect(inApp.scope).toEqual([{ kind: "app", projectId, name: "x" }]);
    expect(
      scopeCovers(inApp.scope ?? [], { kind: "agent", projectId, name: "csm" }),
    ).toBe(false);
  });
});
