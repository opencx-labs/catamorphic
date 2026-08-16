import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatamorphicCore } from "../core.js";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import { RunNotFoundError } from "../services/runs-service.js";

/**
 * Read-side mirror of the trigger gate (ADR 0036). An app bundle polls runs
 * through the same broker that starts them, so `get`/`list` must enforce the
 * frozen workflow set exactly like `trigger` does — otherwise a guest could
 * read any run in the tenant by id.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_scope_reads_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });

const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const otherProjectId = crypto.randomUUID();
const appId = crypto.randomUUID();
const versionId = crypto.randomUUID();

const allowedRunId = crypto.randomUUID();
const forbiddenRunId = crypto.randomUUID();
const otherProjectRunId = crypto.randomUUID();

const commitSha = "a".repeat(40);
const artifactId = crypto.randomUUID();
const otherArtifactId = crypto.randomUUID();

/** Production runs must reference a ready artifact and a 40-char sha. */
const productionRun = {
  status: "completed",
  provenance: JSON.stringify({ commitSha }),
  completed_at: new Date(),
};

const builder: Identity = { tenantId, externalUserId: "builder" };
const viewer: Identity = {
  tenantId,
  externalUserId: "viewer",
  scope: [{ kind: "app", projectId, name: "dashboard" }],
};

let tempDirectory = "";
let core: CatamorphicCore;

describeIf("scoped identity run reads", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-scope-reads-"),
    );
    const projectManager = new ProjectManager(
      new FsBackend(path.join(tempDirectory, "dev")),
      new FsRemoteBackend(path.join(tempDirectory, "remote")),
    );
    core = new CatamorphicCore({ db, projectManager });

    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "Audience reads tenant" })
      .execute();
    await db
      .insertInto("projects")
      .values([
        { id: projectId, tenant_id: tenantId, name: "App project" },
        { id: otherProjectId, tenant_id: tenantId, name: "Sibling project" },
      ])
      .execute();
    await db
      .insertInto("apps")
      .values({ id: appId, project_id: projectId, name: "dashboard" })
      .execute();
    await db
      .insertInto("app_versions")
      .values({
        id: versionId,
        app_id: appId,
        kind: "published",
        status: "ready",
        commit_sha: "a".repeat(40),
        built_by_external_user_id: "builder",
        bundle_key: "k1",
        css_key: "k2",
        allowed_workflows: JSON.stringify(["listOrders"]),
        is_active: true,
        published_at: new Date(),
      })
      .execute();
    await db
      .insertInto("deployment_artifacts")
      .values([
        {
          id: artifactId,
          project_id: projectId,
          commit_sha: commitSha,
          artifact_digest: "d".repeat(64),
          plugin_digest: "e".repeat(64),
          transform_version: "test",
          runtime_version: "test",
          status: "ready",
        },
        {
          id: otherArtifactId,
          project_id: otherProjectId,
          commit_sha: commitSha,
          artifact_digest: "f".repeat(64),
          plugin_digest: "0".repeat(64),
          transform_version: "test",
          runtime_version: "test",
          status: "ready",
        },
      ])
      .execute();
    await db
      .insertInto("workflow_runs")
      .values([
        {
          id: allowedRunId,
          project_id: projectId,
          workflow_name: "listOrders",
          deployment_artifact_id: artifactId,
          result: JSON.stringify({ orders: [] }),
          ...productionRun,
        },
        {
          // Same project, but a workflow the app was never granted.
          id: forbiddenRunId,
          project_id: projectId,
          workflow_name: "exportAllCustomerData",
          deployment_artifact_id: artifactId,
          result: JSON.stringify({ secrets: "leaked" }),
          ...productionRun,
        },
        {
          // Allowed workflow name, wrong project — same tenant.
          id: otherProjectRunId,
          project_id: otherProjectId,
          workflow_name: "listOrders",
          deployment_artifact_id: otherArtifactId,
          result: JSON.stringify({ orders: [] }),
          ...productionRun,
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await core?.runs.stopWorkers();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await db.destroy();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("lets a scoped identity read a production run of its frozen set", async () => {
    const run = await core.runs.get({ identity: viewer, runId: allowedRunId });
    expect(run.id).toBe(allowedRunId);
    expect(run.workflowName).toBe("listOrders");
  });

  it("denies reading a run of a workflow outside the frozen set", async () => {
    await expect(
      core.runs.get({ identity: viewer, runId: forbiddenRunId }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("denies reading a run in another project of the same tenant", async () => {
    await expect(
      core.runs.get({ identity: viewer, runId: otherProjectRunId }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("denies uniformly so run ids cannot be enumerated", async () => {
    // A missing run and a forbidden run must be indistinguishable to a guest:
    // a 404/403 split would answer "does this id exist?".
    const missing = crypto.randomUUID();
    await expect(
      core.runs.get({ identity: viewer, runId: missing }),
    ).rejects.toThrow(AccessDeniedError);
    // The builder still gets the precise error.
    await expect(
      core.runs.get({ identity: builder, runId: missing }),
    ).rejects.toThrow(RunNotFoundError);
  });

  it("full identities read every run untouched", async () => {
    for (const runId of [allowedRunId, forbiddenRunId]) {
      const run = await core.runs.get({ identity: builder, runId });
      expect(run.id).toBe(runId);
    }
  });

  it("list returns only runs of the frozen set", async () => {
    const listed = await core.runs.list({ identity: viewer, projectId });
    expect(listed.items.map((run) => run.id)).toEqual([allowedRunId]);
    expect(listed.total).toBe(1);

    // The builder sees everything in the project.
    const all = await core.runs.list({ identity: builder, projectId });
    expect(all.items.length).toBe(2);
  });

  it("list denies an explicit out-of-set filter", async () => {
    await expect(
      core.runs.list({
        identity: viewer,
        projectId,
        workflowName: "exportAllCustomerData",
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("batch drill-downs stay closed to scoped identities", async () => {
    await expect(
      core.runs.listItems({
        identity: viewer,
        runId: allowedRunId,
        workflowStepAttemptId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      core.runs.listItemSteps({
        identity: viewer,
        runId: allowedRunId,
        workflowStepAttemptId: crypto.randomUUID(),
        itemId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(AccessDeniedError);
  });

  it("run controls stay closed to scoped identities", async () => {
    await expect(
      core.runs.cancel({ identity: viewer, runId: allowedRunId }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      core.runs.pause({ identity: viewer, runId: allowedRunId }),
    ).rejects.toThrow(AccessDeniedError);
    await expect(
      core.runs.resume({ identity: viewer, runId: allowedRunId }),
    ).rejects.toThrow(AccessDeniedError);
  });
});
