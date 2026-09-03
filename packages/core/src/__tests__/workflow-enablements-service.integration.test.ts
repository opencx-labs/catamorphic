import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ArtifactRef, Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import {
  WorkflowEnablementConflictError,
  WorkflowEnablementConsentRequiredError,
  WorkflowEnablementSuspendedError,
  WorkflowEnablementsService,
} from "../services/workflow-enablements-service.js";

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
    resolveTarget: vi.fn(async () => ({ artifact, requirements: [] })),
    ensureTriggerDefinitions: vi.fn(async () => undefined),
    assertWorkflowAccess: vi.fn(async ({ identity, workflowName }) => {
      if (
        identity.scope !== undefined &&
        !identity.scope.some(
          (ref: ArtifactRef) =>
            (ref.kind === "project" ||
              (ref.kind === "workflow" && ref.name === workflowName)) &&
            ref.projectId === projectId,
        )
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
    });
    await expect(
      service.create({
        identity: memberA,
        projectId,
        workflowName: "watchInbox",
        consentDigest: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(WorkflowEnablementConsentRequiredError);

    const created = await service.create({
      identity: memberA,
      projectId,
      workflowName: "watchInbox",
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
    });
    const updated = await service.updateDeployment({
      identity: memberA,
      enablementId: created!.id,
      consentDigest: preview.consentDigest,
    });
    expect(updated).toMatchObject({
      commitSha: "b".repeat(40),
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
});
