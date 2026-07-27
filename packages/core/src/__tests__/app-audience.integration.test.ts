import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  AppAccessDeniedError,
  assertProjectSurface,
  assertWorkflowAllowed,
  resolveAppAudience,
} from "../services/app-audience.js";
import { AppPoliciesService } from "../services/app-policies-service.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_audience_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema });

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
  appAudience: { appId, appVersionId: activeVersionId },
};

describeIf("app audience enforcement", () => {
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
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await db.destroy();
  });

  it("full identities pass every gate untouched", async () => {
    expect(() => assertProjectSurface(builder)).not.toThrow();
    await expect(
      assertWorkflowAllowed({
        db,
        identity: builder,
        projectId,
        workflowName: "anythingAtAll",
      }),
    ).resolves.toBeUndefined();
    expect(
      await resolveAppAudience({ db, identity: builder, projectId }),
    ).toBeNull();
  });

  it("audience identities are rejected from every project surface", () => {
    expect(() => assertProjectSurface(viewer)).toThrow(AppAccessDeniedError);
  });

  it("allows exactly the frozen workflow set", async () => {
    await expect(
      assertWorkflowAllowed({
        db,
        identity: viewer,
        projectId,
        workflowName: "listOrders",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertWorkflowAllowed({
        db,
        identity: viewer,
        projectId,
        workflowName: "deleteAllData",
      }),
    ).rejects.toThrow(AppAccessDeniedError);
  });

  it("a retired version id is a denial, not its old wider set", async () => {
    const stale: Identity = {
      ...viewer,
      appAudience: { appId, appVersionId: retiredVersionId },
    };
    await expect(
      assertWorkflowAllowed({
        db,
        identity: stale,
        projectId,
        workflowName: "dangerousOldWorkflow",
      }),
    ).rejects.toThrow(AppAccessDeniedError);
  });

  it("a forged version id from another app or tenant is a denial", async () => {
    const forgedApp: Identity = {
      ...viewer,
      appAudience: {
        appId: crypto.randomUUID(),
        appVersionId: activeVersionId,
      },
    };
    await expect(
      resolveAppAudience({ db, identity: forgedApp, projectId }),
    ).rejects.toThrow(AppAccessDeniedError);

    const crossTenant: Identity = {
      tenantId: otherTenantId,
      externalUserId: "viewer",
      appAudience: { appId, appVersionId: activeVersionId },
    };
    await expect(
      resolveAppAudience({ db, identity: crossTenant, projectId }),
    ).rejects.toThrow(AppAccessDeniedError);
  });

  it("the tenant workflow allowlist narrows but never widens", async () => {
    const policies = new AppPoliciesService(db);
    await policies.upsert({
      tenantId,
      workflowAllowlist: ["listOrders", "notInFrozenSet"],
    });
    try {
      const context = await resolveAppAudience({
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

  it("the tenant kill switch denies audiences outright", async () => {
    const policies = new AppPoliciesService(db);
    await policies.upsert({ tenantId, appsEnabled: false });
    try {
      await expect(
        resolveAppAudience({ db, identity: viewer, projectId, policies }),
      ).rejects.toThrow(AppAccessDeniedError);
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
        assertWorkflowAllowed({
          db,
          identity: viewer,
          projectId,
          workflowName: "listOrders",
        }),
      ).rejects.toThrow(AppAccessDeniedError);
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
