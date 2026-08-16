import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Identity, narrowIdentity } from "../identity.js";
import { AppPoliciesService } from "../services/app-policies-service.js";
import {
  AccessDeniedError,
  assertFullIdentity,
  assertScopeAllowsWorkflow,
  resolveScope,
} from "../services/artifact-scope.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_scope_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });

const tenantId = crypto.randomUUID();
const otherTenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const appId = crypto.randomUUID();
const activeVersionId = crypto.randomUUID();
const retiredVersionId = crypto.randomUUID();

const builder: Identity = { tenantId, externalUserId: "builder" };
const viewer: Identity = {
  tenantId,
  externalUserId: "viewer",
  scope: [{ kind: "app", projectId, name: "dashboard" }],
};

describeIf("artifact scope enforcement", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    await db
      .insertInto("tenants")
      .values([
        { id: tenantId, name: "Audience tenant" },
        { id: otherTenantId, name: "Other tenant" },
      ])
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Audience project" })
      .execute();
    await db
      .insertInto("apps")
      .values({ id: appId, project_id: projectId, name: "dashboard" })
      .execute();
    await db
      .insertInto("app_versions")
      .values([
        {
          id: activeVersionId,
          app_id: appId,
          kind: "published",
          status: "ready",
          commit_sha: "a".repeat(40),
          built_by_external_user_id: "builder",
          bundle_key: "k1",
          css_key: "k2",
          allowed_workflows: JSON.stringify(["listOrders", "getOrderDetail"]),
          is_active: true,
          published_at: new Date(),
        },
        {
          id: retiredVersionId,
          app_id: appId,
          kind: "published",
          status: "ready",
          commit_sha: "b".repeat(40),
          built_by_external_user_id: "builder",
          bundle_key: "k3",
          css_key: "k4",
          allowed_workflows: JSON.stringify([
            "listOrders",
            "dangerousOldWorkflow",
          ]),
          is_active: false,
          // Newer than the active build: the builder's latest dev build.
          created_at: new Date(Date.now() + 60_000),
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await db.destroy();
  });

  it("full identities pass every gate untouched", async () => {
    expect(() => assertFullIdentity(builder)).not.toThrow();
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: builder,
        projectId,
        workflowName: "anythingAtAll",
      }),
    ).resolves.toBeUndefined();
    expect(await resolveScope({ db, identity: builder, projectId })).toBeNull();
  });

  it("scoped identities are rejected from every project surface", () => {
    expect(() => assertFullIdentity(viewer)).toThrow(AccessDeniedError);
    // Even an empty scope is a scoped identity — a viewer of nothing is
    // still not a builder.
    expect(() => assertFullIdentity({ ...builder, scope: [] })).toThrow(
      AccessDeniedError,
    );
  });

  it("an app ref allows exactly the active version's frozen set", async () => {
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: viewer,
        projectId,
        workflowName: "listOrders",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: viewer,
        projectId,
        workflowName: "deleteAllData",
      }),
    ).rejects.toThrow(AccessDeniedError);
    // The retired version's wider set is unreachable: refs name apps, not
    // versions, and only the active version resolves.
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: viewer,
        projectId,
        workflowName: "dangerousOldWorkflow",
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("a workflow ref allows exactly that workflow in that project", async () => {
    const direct: Identity = {
      ...builder,
      scope: [{ kind: "workflow", projectId, name: "exportReport" }],
    };
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: direct,
        projectId,
        workflowName: "exportReport",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: direct,
        projectId,
        workflowName: "listOrders",
      }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: direct,
        projectId: crypto.randomUUID(),
        workflowName: "exportReport",
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("refs to another project, an unknown app, or another tenant resolve to nothing", async () => {
    const otherProject: Identity = {
      ...viewer,
      scope: [
        { kind: "app", projectId: crypto.randomUUID(), name: "dashboard" },
      ],
    };
    expect(
      (await resolveScope({ db, identity: otherProject, projectId }))
        ?.allowedWorkflows.size,
    ).toBe(0);

    const unknownApp: Identity = {
      ...viewer,
      scope: [{ kind: "app", projectId, name: "no-such-app" }],
    };
    expect(
      (await resolveScope({ db, identity: unknownApp, projectId }))
        ?.allowedWorkflows.size,
    ).toBe(0);

    const crossTenant: Identity = {
      tenantId: otherTenantId,
      externalUserId: "viewer",
      scope: [{ kind: "app", projectId, name: "dashboard" }],
    };
    expect(
      (await resolveScope({ db, identity: crossTenant, projectId }))
        ?.allowedWorkflows.size,
    ).toBe(0);
  });

  it("a dev ref resolves only to the caller's own latest build", async () => {
    // The builder narrowed onto the dev channel of their own app: the retired
    // (newer, non-active) build is theirs, so it resolves.
    const ownDev = narrowIdentity(builder, {
      kind: "app",
      projectId,
      name: "dashboard",
      channel: "dev",
    });
    await expect(
      assertScopeAllowsWorkflow({
        db,
        identity: ownDev,
        projectId,
        workflowName: "dangerousOldWorkflow",
      }),
    ).resolves.toBeUndefined();
    // A viewer asking for dev gets nothing — not the published set either.
    const viewerDev = narrowIdentity(viewer, {
      kind: "app",
      projectId,
      name: "dashboard",
      channel: "dev",
    });
    expect(
      (await resolveScope({ db, identity: viewerDev, projectId }))
        ?.allowedWorkflows.size,
    ).toBe(0);
  });

  it("narrowing intersects: a foreign artifact leaves an empty scope", async () => {
    const narrowed = narrowIdentity(viewer, {
      kind: "app",
      projectId,
      name: "other-app",
    });
    expect(narrowed.scope).toEqual([]);
    const kept = narrowIdentity(viewer, {
      kind: "app",
      projectId,
      name: "dashboard",
    });
    expect(kept.scope).toHaveLength(1);
    const confined = narrowIdentity(builder, {
      kind: "workflow",
      projectId,
      name: "listOrders",
    });
    expect(confined.scope).toEqual([
      { kind: "workflow", projectId, name: "listOrders" },
    ]);
  });

  it("the tenant workflow allowlist narrows but never widens", async () => {
    const policies = new AppPoliciesService(db);
    await policies.upsert({
      tenantId,
      workflowAllowlist: ["listOrders", "notInFrozenSet"],
    });
    try {
      const context = await resolveScope({
        db,
        identity: viewer,
        projectId,
        policies,
      });
      // Intersection: getOrderDetail (frozen but not allowlisted) is out,
      // notInFrozenSet (allowlisted but not frozen) never enters.
      expect([...(context?.allowedWorkflows ?? [])].sort()).toEqual([
        "listOrders",
      ]);
    } finally {
      await policies.upsert({ tenantId, workflowAllowlist: null });
    }
  });

  it("the tenant kill switch denies app scopes outright", async () => {
    const policies = new AppPoliciesService(db);
    await policies.upsert({ tenantId, appsEnabled: false });
    try {
      await expect(
        resolveScope({ db, identity: viewer, projectId, policies }),
      ).rejects.toThrow(AccessDeniedError);
    } finally {
      await policies.upsert({ tenantId, appsEnabled: true });
    }
  });

  it("policy upsert merges: omitted fields keep their stored values", async () => {
    const policies = new AppPoliciesService(db);
    await policies.upsert({
      tenantId,
      appsEnabled: false,
      workflowAllowlist: ["listOrders"],
      maxBundleBytes: 1024,
    });
    try {
      // A one-field tweak must not resurrect apps or drop the allowlist.
      const after = await policies.upsert({ tenantId, maxAppsPerProject: 3 });
      expect(after.appsEnabled).toBe(false);
      expect(after.workflowAllowlist).toEqual(["listOrders"]);
      expect(after.maxBundleBytes).toBe(1024);
      expect(after.maxAppsPerProject).toBe(3);

      // Explicit null clears a nullable field.
      const cleared = await policies.upsert({
        tenantId,
        workflowAllowlist: null,
        maxBundleBytes: null,
        maxAppsPerProject: null,
      });
      expect(cleared.workflowAllowlist).toBeUndefined();
      expect(cleared.maxBundleBytes).toBeUndefined();
      expect(cleared.appsEnabled).toBe(false);
    } finally {
      await policies.upsert({ tenantId, appsEnabled: true });
    }
  });

  it("a corrupt frozen set denies everything instead of erroring", async () => {
    await db
      .updateTable("app_versions")
      .set({ allowed_workflows: sql`'"not-an-array"'::jsonb` })
      .where("id", "=", activeVersionId)
      .execute();
    try {
      await expect(
        assertScopeAllowsWorkflow({
          db,
          identity: viewer,
          projectId,
          workflowName: "listOrders",
        }),
      ).rejects.toThrow(AccessDeniedError);
    } finally {
      await db
        .updateTable("app_versions")
        .set({
          allowed_workflows: JSON.stringify(["listOrders", "getOrderDetail"]),
        })
        .where("id", "=", activeVersionId)
        .execute();
    }
  });
});
