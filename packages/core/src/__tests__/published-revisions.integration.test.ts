import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import type { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import {
  PublishedRevisionsService,
  parseProjectDeploy,
} from "../services/published-revisions-service.js";
import type { Run } from "../services/runs-service.js";
import { WorkflowEnablementsService } from "../services/workflow-enablements-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const schema = "catamorphic_published_revisions";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(schema)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
/** An unscoped host identity, as on the desktop: it holds every permission. */
const owner: Identity = { tenantId, externalUserId: "owner" };
const sha = (letter: string) => letter.repeat(40);

/** What each commit's workflows build to, per workflow name. */
const targets = new Map<
  string,
  { permissions: string[]; fails?: string; artifactId: string }
>();
/** `.work/project.json` per commit. */
const manifests = new Map<string, string>();
const notifications: Array<{ kind: string; to: string; title: string }> = [];
/** Deploy runs Work started, in order. */
const deploys: Array<{ runId: string; commit: string; previous: unknown }> = [];
let maxLiveDeploys = 0;
let head = sha("a");

let enablements: WorkflowEnablementsService;
let revisions: PublishedRevisionsService;

async function addCommit(
  commitSha: string,
  options: { permissions?: string[]; fails?: string } = {},
) {
  const artifactId = crypto.randomUUID();
  await db
    .insertInto("deployment_artifacts")
    .values({
      id: artifactId,
      project_id: projectId,
      commit_sha: commitSha,
      artifact_digest: `artifact-${commitSha.slice(0, 1)}`,
      plugin_digest: "plugins",
      runtime_version: "test",
      transform_version: "test",
    })
    .execute();
  targets.set(commitSha, {
    permissions: options.permissions ?? [],
    ...(options.fails ? { fails: options.fails } : {}),
    artifactId,
  });
}

function revisionsService(): PublishedRevisionsService {
  return new PublishedRevisionsService({
    db,
    enablements,
    runs: () => ({
      triggerWithEnablementAtRevision: async (args) => {
        const live = await db
          .selectFrom("workflow_runs")
          .select("id")
          .where("workflow_name", "=", args.workflowName)
          .where("status", "not in", ["completed", "failed", "canceled"])
          .execute();
        maxLiveDeploys = Math.max(maxLiveDeploys, live.length + 1);
        const run = await insertRun({
          workflowName: args.workflowName,
          commitSha: args.commitSha,
          status: "running",
        });
        const input = args.input as { commit: string; previousCommit: unknown };
        deploys.push({
          runId: run,
          commit: input.commit,
          previous: input.previousCommit,
        });
        return { id: run } as Run;
      },
    }),
    readManifest: async ({ commitSha }) => manifests.get(commitSha) ?? null,
    notifications: {
      publish: async (input) => {
        notifications.push({
          kind: input.kind,
          to: input.identity.externalUserId,
          title: input.title,
        });
      },
    },
    automationManagers: async () => ["owner"],
  });
}

async function insertRun(input: {
  workflowName: string;
  commitSha: string;
  status: string;
}): Promise<string> {
  const row = await db
    .insertInto("workflow_runs")
    .values({
      project_id: projectId,
      workflow_name: input.workflowName,
      provenance: JSON.stringify({ commitSha: input.commitSha }),
      deployment_artifact_id: targets.get(input.commitSha)?.artifactId ?? null,
      status: input.status,
      ...(input.status === "running" ? {} : { completed_at: new Date() }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function settleRun(runId: string, status: "completed" | "failed") {
  await db
    .updateTable("workflow_runs")
    .set({
      status,
      completed_at: new Date(),
      ...(status === "failed" ? { error: "relation already exists" } : {}),
    })
    .where("id", "=", runId)
    .execute();
}

async function enable(workflowName: string) {
  const preview = await enablements.preview({
    identity: owner,
    projectId,
    workflowName,
    owner: { type: "project" },
  });
  return enablements.create({
    identity: owner,
    projectId,
    workflowName,
    owner: { type: "project" },
    consentDigest: preview.consentDigest,
  });
}

const commitOf = async (enablementId: string) =>
  (await enablements.get({ identity: owner, enablementId })).commitSha;

async function statuses() {
  return (
    await db
      .selectFrom("published_revisions")
      .select(["commit_sha", "status"])
      .where("project_id", "=", projectId)
      .orderBy("sequence")
      .execute()
  ).map((row) => `${row.commit_sha.slice(0, 1)}:${row.status}`);
}

beforeAll(async () => {
  await migrateToLatest({ db, schema });
  await db.insertInto("tenants").values({ id: tenantId, name: "T" }).execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: tenantId, name: "P" })
    .execute();
  await addCommit(sha("a"));
  enablements = new WorkflowEnablementsService(db, {
    executionEnvironments: {
      admit: async () => ({ environmentName: "default" }),
    } as unknown as ExecutionEnvironmentsService,
    resolveTarget: async ({ commitSha }) => {
      const target = targets.get(commitSha ?? head);
      if (!target) throw new Error(`No commit ${commitSha}`);
      if (target.fails) throw new Error(target.fails);
      const artifact = await db
        .selectFrom("deployment_artifacts")
        .selectAll()
        .where("id", "=", target.artifactId)
        .executeTakeFirstOrThrow();
      return {
        artifact: {
          id: artifact.id,
          projectId,
          commitSha: artifact.commit_sha,
          artifactDigest: artifact.artifact_digest,
          pluginDigest: artifact.plugin_digest,
          runtimeVersion: artifact.runtime_version,
          transformVersion: artifact.transform_version,
          status: "ready" as const,
          createdAt: artifact.created_at.toISOString(),
          readyAt: artifact.created_at.toISOString(),
          lastUsedAt: artifact.created_at.toISOString(),
        },
        requirements: [],
        permissions: target.permissions,
      };
    },
    ensureTriggerDefinitions: async () => undefined,
    assertWorkflowAccess: async () => undefined,
  });
  revisions = revisionsService();
});

afterAll(async () => {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
  await db.destroy();
});

beforeEach(() => {
  notifications.length = 0;
});

describe("following the published program (ADR 0330)", () => {
  let watcher: string;

  it("follows by default, and moves at a new revision whose authority is unchanged", async () => {
    const created = await enable("watchInbox");
    watcher = created.id;
    expect(created.follow).toBe(true);
    const inFlight = await insertRun({
      workflowName: "watchInbox",
      commitSha: sha("a"),
      status: "running",
    });

    await addCommit(sha("b"));
    await revisions.record({ projectId, commitSha: sha("b") });
    await revisions.advance();

    const moved = await enablements.get({
      identity: owner,
      enablementId: watcher,
    });
    expect(moved).toMatchObject({
      commitSha: sha("b"),
      deploymentArtifactId: targets.get(sha("b"))?.artifactId,
      updateAvailable: false,
    });
    expect(await statuses()).toEqual(["b:applied"]);
    const [applied] = await revisions.list({ identity: owner, projectId });
    expect(applied?.report).toEqual([
      {
        kind: "moved",
        enablementId: watcher,
        commitSha: sha("b"),
        workflowName: "watchInbox",
      },
    ]);
    // A run in flight keeps the commit it started on (ADR 0040).
    expect(
      await db
        .selectFrom("workflow_runs")
        .select("deployment_artifact_id")
        .where("id", "=", inFlight)
        .executeTakeFirstOrThrow(),
    ).toEqual({ deployment_artifact_id: targets.get(sha("a"))?.artifactId });
    await settleRun(inFlight, "completed");
  });

  it("stays, offers the update and tells its owner when the revision needs new consent", async () => {
    await addCommit(sha("c"), { permissions: ["store:write"] });
    await revisions.record({ projectId, commitSha: sha("c") });
    await revisions.advance();

    expect(
      await enablements.get({ identity: owner, enablementId: watcher }),
    ).toMatchObject({ commitSha: sha("b"), updateAvailable: true });
    expect(notifications).toEqual([
      {
        kind: "automation_update_needs_consent",
        to: "owner",
        title: "watchInbox needs your consent to update",
      },
    ]);
  });

  it("skips a revision whose workflow does not build and follows the next good one", async () => {
    await addCommit(sha("d"), { fails: "Workflow watchInbox does not parse" });
    await revisions.record({ projectId, commitSha: sha("d") });
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("b"));
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: "automation_update_skipped",
        title: `watchInbox did not update to ${sha("d").slice(0, 7)}`,
      }),
    ]);

    await addCommit(sha("e"));
    await revisions.record({ projectId, commitSha: sha("e") });
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("e"));
  });

  it("never moves an enablement back to an older revision", async () => {
    await expect(
      enablements.followRevision({
        enablementId: watcher,
        commitSha: sha("b"),
        sequence: 1,
      }),
    ).resolves.toEqual({ kind: "unchanged", enablementId: watcher });
    expect(await commitOf(watcher)).toBe(sha("e"));
  });

  it("records each revision once, and a newer one supersedes one still pending", async () => {
    await addCommit(sha("f"));
    await addCommit(sha("1"));
    await revisions.record({ projectId, commitSha: sha("f") });
    await revisions.record({ projectId, commitSha: sha("f") });
    await revisions.record({ projectId, commitSha: sha("1") });
    expect((await statuses()).slice(-2)).toEqual(["f:superseded", "1:pending"]);
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["1:applied"]);
    expect(await commitOf(watcher)).toBe(sha("1"));
  });

  it("does not move an enablement that stopped following", async () => {
    await enablements.setFollow({
      identity: owner,
      enablementId: watcher,
      follow: false,
    });
    await addCommit(sha("2"));
    await revisions.record({ projectId, commitSha: sha("2") });
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("1"));
    await enablements.setFollow({
      identity: owner,
      enablementId: watcher,
      follow: true,
    });
  });

  it("moves an enablement once when two replicas advance together", async () => {
    await addCommit(sha("3"));
    await revisions.record({ projectId, commitSha: sha("3") });
    const other = revisionsService();
    await Promise.all([revisions.advance(), other.advance()]);
    await Promise.all([revisions.advance(), other.advance()]);
    expect(await commitOf(watcher)).toBe(sha("3"));
    const followed = await db
      .selectFrom("workflow_enablement_events")
      .select("metadata")
      .where("enablement_id", "=", watcher)
      .where("event_type", "=", "followed")
      .execute();
    expect(
      followed.filter(
        (event) =>
          (event.metadata as { commitSha?: string }).commitSha === sha("3"),
      ),
    ).toHaveLength(1);
  });
});

describe("the project's deploy workflow (ADR 0331)", () => {
  let watcher: string;
  let migrate: string;
  const deployManifest = JSON.stringify({
    deploy: { workflow: "migrate" },
  });

  it("reads deploy from project.json", () => {
    expect(parseProjectDeploy(null)).toEqual({ kind: "none" });
    expect(parseProjectDeploy("{}")).toEqual({ kind: "none" });
    expect(parseProjectDeploy(deployManifest)).toEqual({
      kind: "workflow",
      workflow: "migrate",
    });
    expect(
      parseProjectDeploy(JSON.stringify({ deploy: { workflow: 3 } })),
    ).toMatchObject({ kind: "invalid" });
  });

  it("runs once at the revision, before following enablements move", async () => {
    head = sha("3");
    watcher = (await enablements.list({ identity: owner, projectId })).find(
      (item) => item.workflowName === "watchInbox",
    )!.id;
    migrate = (await enable("migrate")).id;

    await addCommit(sha("4"));
    manifests.set(sha("4"), deployManifest);
    await revisions.record({ projectId, commitSha: sha("4") });
    await revisions.advance();

    expect(deploys).toEqual([
      expect.objectContaining({ commit: sha("4"), previous: sha("3") }),
    ]);
    expect((await statuses()).slice(-1)).toEqual(["4:deploying"]);
    // Waiting for the deploy: nothing moved, and no second run starts.
    await revisions.advance();
    expect(deploys).toHaveLength(1);
    expect(await commitOf(watcher)).toBe(sha("3"));

    await settleRun(deploys[0]!.runId, "completed");
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["4:applied"]);
    expect(await commitOf(watcher)).toBe(sha("4"));
    expect(await commitOf(migrate)).toBe(sha("4"));
  });

  it("moves nothing when the deploy fails, and tries again at the next revision", async () => {
    await addCommit(sha("5"));
    manifests.set(sha("5"), deployManifest);
    await revisions.record({ projectId, commitSha: sha("5") });
    await revisions.advance();
    await settleRun(deploys[1]!.runId, "failed");
    await revisions.advance();

    expect((await statuses()).slice(-1)).toEqual(["5:failed"]);
    expect(await commitOf(watcher)).toBe(sha("4"));
    expect(await commitOf(migrate)).toBe(sha("4"));
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: "deploy_failed",
        to: "owner",
        title: `Revision ${sha("5").slice(0, 7)} did not go live`,
      }),
    ]);
    const [failed] = await revisions.list({ identity: owner, projectId });
    expect(failed?.error).toContain("relation already exists");

    await addCommit(sha("6"));
    manifests.set(sha("6"), deployManifest);
    await revisions.record({ projectId, commitSha: sha("6") });
    await revisions.advance();
    // The live revision is still the last one that went live.
    expect(deploys[2]).toMatchObject({ commit: sha("6"), previous: sha("4") });
    await settleRun(deploys[2]!.runId, "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("6"));
  });

  it("deploys revisions published in quick succession in order, one at a time", async () => {
    await addCommit(sha("7"));
    await addCommit(sha("8"));
    manifests.set(sha("7"), deployManifest);
    manifests.set(sha("8"), deployManifest);
    await revisions.record({ projectId, commitSha: sha("7") });
    await revisions.advance();
    await revisions.record({ projectId, commitSha: sha("8") });
    await revisions.advance();
    await revisions.advance();
    // 8 waits while 7 deploys.
    expect(deploys.slice(3).map((deploy) => deploy.commit)).toEqual([sha("7")]);
    expect((await statuses()).slice(-2)).toEqual(["7:deploying", "8:pending"]);

    await settleRun(deploys[3]!.runId, "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("7"));
    await revisions.advance();
    expect(deploys[4]).toMatchObject({ commit: sha("8"), previous: sha("7") });
    await settleRun(deploys[4]!.runId, "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("8"));
    expect((await statuses()).slice(-2)).toEqual(["7:applied", "8:applied"]);
    expect(maxLiveDeploys).toBe(1);
  });

  it("fails the revision when the deploy workflow is not turned on", async () => {
    await enablements.disable({ identity: owner, enablementId: migrate });
    await addCommit(sha("9"));
    manifests.set(sha("9"), deployManifest);
    await revisions.record({ projectId, commitSha: sha("9") });
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["9:failed"]);
    expect(await commitOf(watcher)).toBe(sha("8"));
    const [failed] = await revisions.list({ identity: owner, projectId });
    expect(failed?.error).toContain("not turned on as a project automation");
  });
});
