import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EVERY_ARTIFACT,
  type Identity,
  identityCovers,
  PROJECT_PRINCIPAL_ID,
} from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import {
  WorkflowEnablementConflictError,
  WorkflowEnablementConsentRequiredError,
  WorkflowEnablementSuspendedError,
  WorkflowEnablementsService,
} from "../services/workflow-enablements-service.js";
import { projectAdmin } from "./project-admin.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_workflow_enablements";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const memberA: Identity = {
  tenantId,
  externalUserId: "member-a",
  scope: [{ kind: "workflow", projectId, name: "watchInbox" }],
  executionScope: [{ projectId, name: "local" }],
};
const memberB: Identity = {
  ...memberA,
  externalUserId: "member-b",
};
let artifact = {
  id: crypto.randomUUID(),
  projectId,
  commitSha: "a".repeat(40),
  artifactDigest: "artifact-a",
  pluginDigest: "plugins",
  runtimeVersion: "test",
  transformVersion: "test",
  status: "ready" as const,
  createdAt: new Date().toISOString(),
  readyAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
};
let service: WorkflowEnablementsService;
let resolvedMemberA: Identity | null = memberA;
/** What the workflow under test declares in `permissions`. */
let declared: string[] = [];

beforeAll(async () => {
  await migrateToLatest({ db, schema });
  await db.insertInto("tenants").values({ id: tenantId, name: "T" }).execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: tenantId, name: "P" })
    .execute();
  await insertArtifact(artifact);
  service = new WorkflowEnablementsService(db, {
    executionEnvironments: {
      admit: vi.fn(async () => ({ environmentName: "local" })),
    } as unknown as ExecutionEnvironmentsService,
    resolveTarget: vi.fn(async () => ({
      artifact,
      requirements: [],
      permissions: declared,
    })),
    ensureTriggerDefinitions: vi.fn(async () => undefined),
    assertWorkflowAccess: vi.fn(async ({ identity, workflowName }) => {
      if (
        !identityCovers(identity, {
          kind: "workflow",
          projectId,
          name: workflowName,
        })
      ) {
        throw new AccessDeniedError();
      }
    }),
    resolveMemberIdentity: vi.fn(async ({ externalUserId }) =>
      externalUserId === "member-a" ? resolvedMemberA : memberB,
    ),
  });
});

afterAll(async () => {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
  await db.destroy();
});

async function insertArtifact(value: typeof artifact) {
  await db
    .insertInto("deployment_artifacts")
    .values({
      id: value.id,
      project_id: projectId,
      commit_sha: value.commitSha,
      artifact_digest: value.artifactDigest,
      plugin_digest: value.pluginDigest,
      runtime_version: value.runtimeVersion,
      transform_version: value.transformVersion,
    })
    .execute();
}

describe("WorkflowEnablementsService", () => {
  it("requires the exact preview consent and isolates member ownership", async () => {
    const preview = await service.preview({
      identity: memberA,
      projectId,
      workflowName: "watchInbox",
      remoteBranch: "release",
    });
    await expect(
      service.create({
        identity: memberA,
        projectId,
        workflowName: "watchInbox",
        remoteBranch: "release",
        consentDigest: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(WorkflowEnablementConsentRequiredError);

    await expect(
      service.create({
        identity: memberA,
        projectId,
        workflowName: "watchInbox",
        remoteBranch: "release",
        consentDigest: preview.consentDigest,
        onCreate: async ({ transaction, enablement }) => {
          expect(
            await transaction
              .selectFrom("workflow_enablement_events")
              .select("event_type")
              .where("enablement_id", "=", enablement.id)
              .execute(),
          ).toEqual([{ event_type: "created" }]);
          throw new Error("Owner was archived during preparation");
        },
      }),
    ).rejects.toThrow("Owner was archived during preparation");
    expect(await service.list({ identity: memberA, projectId })).toEqual([]);
    expect(
      await db
        .selectFrom("workflow_enablement_events")
        .select("enablement_id")
        .execute(),
    ).toEqual([]);

    const created = await service.create({
      identity: memberA,
      projectId,
      workflowName: "watchInbox",
      remoteBranch: "release",
      consentDigest: preview.consentDigest,
    });
    expect(created.owner).toEqual({
      type: "member",
      externalUserId: "member-a",
    });
    await expect(
      service.create({
        identity: memberA,
        projectId,
        workflowName: "watchInbox",
        remoteBranch: "release",
        consentDigest: preview.consentDigest,
      }),
    ).rejects.toBeInstanceOf(WorkflowEnablementConflictError);
    await expect(
      service.get({ identity: memberB, enablementId: created.id }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      service.preview({
        identity: memberB,
        projectId,
        workflowName: "watchInbox",
        owner: { type: "member", externalUserId: "member-a" },
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("keeps the pinned revision until a freshly consented update", async () => {
    const [created] = await service.list({ identity: memberA, projectId });
    expect(created?.commitSha).toBe("a".repeat(40));

    artifact = {
      ...artifact,
      id: crypto.randomUUID(),
      commitSha: "b".repeat(40),
      artifactDigest: "artifact-b",
    };
    await insertArtifact(artifact);
    await service.markUpdateAvailable({
      projectId,
      commitSha: artifact.commitSha,
    });
    const stillPinned = await service.get({
      identity: memberA,
      enablementId: created!.id,
    });
    expect(stillPinned).toMatchObject({
      commitSha: "a".repeat(40),
      updateAvailable: true,
    });

    const preview = await service.preview({
      identity: memberA,
      projectId,
      workflowName: "watchInbox",
      remoteBranch: "release",
    });
    const updated = await service.updateDeployment({
      identity: memberA,
      enablementId: created!.id,
      consentDigest: preview.consentDigest,
    });
    expect(updated).toMatchObject({
      commitSha: "b".repeat(40),
      remoteBranch: "release",
      updateAvailable: false,
      revision: 2,
    });
  });

  it("suspends after workflow access is removed and reenables after it returns", async () => {
    const [created] = await service.list({ identity: memberA, projectId });
    resolvedMemberA = { ...memberA, scope: [] };
    await expect(
      service.revalidate({
        identity: memberA,
        enablementId: created!.id,
      }),
    ).rejects.toBeInstanceOf(WorkflowEnablementSuspendedError);
    expect(
      await service.get({ identity: memberA, enablementId: created!.id }),
    ).toMatchObject({
      status: "suspended",
      suspensionReason: "workflow_denied",
    });

    resolvedMemberA = memberA;
    expect(
      await service.reenable({
        identity: memberA,
        enablementId: created!.id,
      }),
    ).toMatchObject({ status: "active", suspensionReason: null });
  });

  it("project automations: admins enable them, members see them, runs are the project's", async () => {
    const builder: Identity = {
      tenantId,
      externalUserId: "builder",
      ...projectAdmin(projectId),
      executionScope: [{ projectId, name: "local" }],
    };
    const forProject = { type: "project" as const };
    expect(
      service.mayManageProjectAutomations({ identity: memberA, projectId }),
    ).toBe(false);
    expect(
      service.mayManageProjectAutomations({ identity: builder, projectId }),
    ).toBe(true);
    await expect(
      service.preview({
        identity: memberA,
        projectId,
        workflowName: "watchInbox",
        owner: forProject,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const preview = await service.preview({
      identity: builder,
      projectId,
      workflowName: "watchInbox",
      owner: forProject,
    });
    const created = await service.create({
      identity: builder,
      projectId,
      workflowName: "watchInbox",
      owner: forProject,
      consentDigest: preview.consentDigest,
    });
    expect(created.owner).toEqual(forProject);

    // Everyone sees the project's automation; only its managers change it.
    for (const member of [memberA, memberB]) {
      expect(
        (await service.list({ identity: member, projectId })).map(
          (item) => item.id,
        ),
      ).toContain(created.id);
    }
    await expect(
      service.disable({ identity: memberA, enablementId: created.id }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // It runs as the project, never as the admin who switched it on.
    const revalidated = await service.revalidate({
      identity: builder,
      enablementId: created.id,
    });
    expect(revalidated.ownerIdentity).toEqual({
      tenantId,
      externalUserId: PROJECT_PRINCIPAL_ID,
      scope: [
        { kind: "workflow", projectId, name: "watchInbox" },
        { kind: "agent", projectId, name: EVERY_ARTIFACT },
      ],
      executionScope: [{ projectId, name: "local" }],
      projectPermissions: [],
      connectionScope: [],
    });
    expect(
      await service.disable({ identity: builder, enablementId: created.id }),
    ).toMatchObject({ status: "disabled" });
  });

  it("declared permissions: only a holder turns it on, and a member's runs keep them only while held", async () => {
    declared = ["sessions:write"];
    try {
      const holder: Identity = {
        ...memberA,
        externalUserId: "holder",
        projectPermissions: [{ projectId, permission: "sessions:*" }],
      };
      await expect(
        service.preview({
          identity: memberA,
          projectId,
          workflowName: "watchInbox",
        }),
      ).rejects.toThrow("permissions you do not have: sessions:write");

      const preview = await service.preview({
        identity: holder,
        projectId,
        workflowName: "watchInbox",
      });
      expect(preview.permissions).toEqual(["sessions:write"]);
      const created = await service.create({
        identity: holder,
        projectId,
        workflowName: "watchInbox",
        consentDigest: preview.consentDigest,
      });
      expect(created.permissions).toEqual(["sessions:write"]);

      // Still held: the run is admitted.
      let current: Identity = holder;
      const resolving = new WorkflowEnablementsService(db, {
        executionEnvironments: {
          admit: vi.fn(async () => ({ environmentName: "local" })),
        } as unknown as ExecutionEnvironmentsService,
        resolveTarget: vi.fn(async () => ({
          artifact,
          requirements: [],
          permissions: declared,
        })),
        ensureTriggerDefinitions: vi.fn(async () => undefined),
        assertWorkflowAccess: vi.fn(async () => undefined),
        resolveMemberIdentity: vi.fn(async () => current),
      });
      await expect(
        resolving.revalidate({ identity: holder, enablementId: created.id }),
      ).resolves.toMatchObject({ ownerIdentity: holder });

      // The member's role lost it: the automation suspends.
      current = { ...holder, projectPermissions: [] };
      await expect(
        resolving.revalidate({ identity: holder, enablementId: created.id }),
      ).rejects.toBeInstanceOf(WorkflowEnablementSuspendedError);
      expect(
        await resolving.get({ identity: holder, enablementId: created.id }),
      ).toMatchObject({
        status: "suspended",
        suspensionReason: "permission_revoked",
      });

      // A project automation keeps what was consented, not tied to the enabler.
      const admin: Identity = {
        tenantId,
        externalUserId: "admin",
        ...projectAdmin(projectId),
        executionScope: [{ projectId, name: "local" }],
      };
      const projectPreview = await service.preview({
        identity: admin,
        projectId,
        workflowName: "triageRequests",
        owner: { type: "project" },
        environment: "local",
      });
      const project = await service.create({
        identity: admin,
        projectId,
        workflowName: "triageRequests",
        owner: { type: "project" },
        environment: "local",
        consentDigest: projectPreview.consentDigest,
      });
      const run = await service.revalidate({
        identity: admin,
        enablementId: project.id,
      });
      expect(run.ownerIdentity.projectPermissions).toEqual([
        { projectId, permission: "sessions:write" },
      ]);
    } finally {
      declared = [];
    }
  });
});
