import { describe, expect, it } from "vitest";
import {
  type ArtifactRef,
  documentRefCovers,
  type Identity,
  isBuilder,
  narrowIdentity,
  scopeCovers,
} from "../identity.js";

const projectId = "p1";
const base = { tenantId: "t", externalUserId: "u" };

describe("identity scope (ADR 0053 / 0055)", () => {
  it("isBuilder: root, or a project ref for that project", () => {
    expect(isBuilder(base, projectId)).toBe(true);
    const admin: Identity = {
      ...base,
      scope: [{ kind: "project", projectId }],
    };
    expect(isBuilder(admin, projectId)).toBe(true);
    expect(isBuilder(admin, "p2")).toBe(false);
    const viewer: Identity = {
      ...base,
      scope: [{ kind: "agent", projectId, name: "csm" }],
    };
    expect(isBuilder(viewer, projectId)).toBe(false);
    expect(isBuilder({ ...base, scope: [] }, projectId)).toBe(false);
  });

  it("agent and project refs cover by identity", () => {
    const scope: ArtifactRef[] = [
      { kind: "agent", projectId, name: "csm", toolPolicies: {} },
      { kind: "project", projectId: "p2" },
    ];
    expect(scopeCovers(scope, { kind: "agent", projectId, name: "csm" })).toBe(
      true,
    );
    expect(
      scopeCovers(scope, { kind: "agent", projectId, name: "sales" }),
    ).toBe(false);
    expect(
      scopeCovers(scope, { kind: "agent", projectId: "p2", name: "csm" }),
    ).toBe(false);
    expect(scopeCovers(scope, { kind: "project", projectId: "p2" })).toBe(true);
    expect(scopeCovers(scope, { kind: "project", projectId })).toBe(false);
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
      scope: [{ kind: "project", projectId }],
    };
    const inApp = narrowIdentity(admin, { kind: "app", projectId, name: "x" });
    // A builder narrowed into an app is confined to it — no project ref left.
    expect(inApp.scope).toEqual([{ kind: "app", projectId, name: "x" }]);
    expect(isBuilder(inApp, projectId)).toBe(false);
  });
});
