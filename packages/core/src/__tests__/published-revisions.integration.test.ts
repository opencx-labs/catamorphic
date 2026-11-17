import type { DB } from "@catamorphic/db";
import { migrateToLatest } from "@catamorphic/db";
import { WorkflowSourceInvalidError } from "@catamorphic/parser";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import type { ExecutionEnvironmentsService } from "../services/execution-environments-service.js";
import { EnvironmentBindingUnavailableError } from "../services/execution-environments-service.js";
import {
  PublishedRevisionNotRetryableError,
  PublishedRevisionsService,
  parseProjectDeploy,
} from "../services/published-revisions-service.js";
import type { Run } from "../services/runs-service.js";
import {
  WorkflowEnablementSuspendedError,
  WorkflowEnablementsService,
} from "../services/workflow-enablements-service.js";
import { projectAdmin } from "./project-admin.js";

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
const sha = (letters: string) => letters.repeat(40).slice(0, 40);

/** What each commit's workflows build to, per workflow name. */
const targets = new Map<
  string,
  {
    permissions: string[];
    secrets: string[];
    fails?: string;
    artifactId: string;
  }
>();
/** `.work/project.json` per commit. */
const manifests = new Map<string, string>();
const notifications: Array<{ kind: string; to: string; title: string }> = [];
/** Deploy runs Work started, in order. */
const deploys: Array<{ runId: string; commit: string; previous: unknown }> = [];
let maxLiveDeploys = 0;
let head = sha("a");
/** What the project's published main points to. */
let mainHead: string | null = null;

/** Main moves to `commitSha`, and the publisher records it. */
async function publish(commitSha: string) {
  mainHead = commitSha;
  await revisions.record({ projectId, commitSha });
}

/** Starting a deploy run fails with this while set. */
let deployStartFailure: Error | null = null;
/** Previewing any revision fails with this while set. */
let previewError: Error | null = null;
/** Runs Work canceled. */
const canceled: string[] = [];

/** A failure that may clear (the database, the network) while set. */
let transientFailure: string | null = null;

let enablements: WorkflowEnablementsService;
let revisions: PublishedRevisionsService;

async function addCommit(
  commitSha: string,
  options: {
    permissions?: string[];
    fails?: string;
    /** The secret names the project declares at this commit. */
    secrets?: string[];
    /** watchInbox's triggers at this commit. */
    triggers?: Array<{ kind: string; config: unknown; where?: unknown }>;
  } = {},
) {
  const artifactId = crypto.randomUUID();
  await db
    .insertInto("deployment_artifacts")
    .values({
      id: artifactId,
      project_id: projectId,
      commit_sha: commitSha,
      artifact_digest: `artifact-${commitSha}`,
      plugin_digest: "plugins",
      runtime_version: "test",
      transform_version: "test",
    })
    .execute();
  if (options.triggers?.length)
    await db
      .insertInto("trigger_definition_scans")
      .values({ project_id: projectId, commit_sha: commitSha })
      .execute();
  for (const [index, trigger] of (options.triggers ?? []).entries())
    await db
      .insertInto("trigger_definitions")
      .values({
        project_id: projectId,
        commit_sha: commitSha,
        workflow_name: "watchInbox",
        binding_index: index,
        trigger_kind: trigger.kind,
        config: JSON.stringify(trigger.config),
        where_filters: JSON.stringify(trigger.where ?? []),
        input_parameters: JSON.stringify([]),
        can_suspend: false,
      })
      .execute();
  targets.set(commitSha, {
    permissions: options.permissions ?? [],
    secrets: options.secrets ?? [],
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
        const enablement = await db
          .selectFrom("workflow_enablements")
          .select("status")
          .where("id", "=", args.enablementId)
          .executeTakeFirstOrThrow();
        if (enablement.status !== "active")
          throw new WorkflowEnablementSuspendedError(
            args.enablementId,
            enablement.status,
          );
        if (deployStartFailure) throw deployStartFailure;
        const existing = await db
          .selectFrom("workflow_runs")
          .select("id")
          .where("correlation_key", "=", args.correlationKey ?? "")
          .where("status", "not in", ["completed", "failed", "canceled"])
          .executeTakeFirst();
        if (existing) return { id: existing.id } as Run;
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
          correlationKey: args.correlationKey,
        });
        const input = args.input as { commit: string; previousCommit: unknown };
        deploys.push({
          runId: run,
          commit: input.commit,
          previous: input.previousCommit,
        });
        return { id: run } as Run;
      },
      cancel: async ({ runId }) => {
        canceled.push(runId);
        await settleRun(runId, "canceled");
        return { id: runId } as Run;
      },
    }),
    readManifest: async ({ commitSha }) => manifests.get(commitSha) ?? null,
    publishedHead: async () => mainHead,
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
  correlationKey?: string;
}): Promise<string> {
  const row = await db
    .insertInto("workflow_runs")
    .values({
      project_id: projectId,
      workflow_name: input.workflowName,
      provenance: JSON.stringify({ commitSha: input.commitSha }),
      deployment_artifact_id: targets.get(input.commitSha)?.artifactId ?? null,
      status: input.status,
      correlation_key: input.correlationKey ?? null,
      ...(input.status === "running" ? {} : { completed_at: new Date() }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function settleRun(
  runId: string,
  status: "completed" | "failed" | "canceled",
) {
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

async function enable(
  workflowName: string,
  by: { type: "project" } | { type: "member"; externalUserId: string } = {
    type: "project",
  },
) {
  const preview = await enablements.preview({
    identity: owner,
    projectId,
    workflowName,
    owner: by,
  });
  return enablements.create({
    identity: owner,
    projectId,
    workflowName,
    owner: by,
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
      if (target.fails) throw new WorkflowSourceInvalidError(target.fails);
      if (transientFailure) throw new Error(transientFailure);
      if (previewError) throw previewError;
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
        secrets: target.secrets,
        permissions: target.permissions,
      };
    },
    ensureTriggerDefinitions: async () => undefined,
    assertWorkflowAccess: async () => undefined,
    onConsented: (input) => revisions.retryAfterConsent(input),
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
    await publish(sha("b"));
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
    await publish(sha("c"));
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
    await publish(sha("d"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("b"));
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: "automation_update_skipped",
        title: `watchInbox did not update to ${sha("d").slice(0, 7)}`,
      }),
    ]);

    await addCommit(sha("e"));
    await publish(sha("e"));
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

  it("does not skip a revision on a failure that may clear, and moves once it clears", async () => {
    await addCommit(sha("0"));
    transientFailure = "connection reset by peer";
    await publish(sha("0"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("e"));
    expect((await statuses()).slice(-1)).toEqual(["0:applying"]);
    expect(notifications).toEqual([]);
    const [waiting] = await revisions.list({ identity: owner, projectId });
    expect(waiting?.report).toEqual([
      expect.objectContaining({
        kind: "retry",
        reason: "connection reset by peer",
      }),
    ]);

    // Backing off: an immediate pass leaves it alone, even once it clears.
    transientFailure = null;
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("e"));

    await db
      .updateTable("published_revisions")
      .set({ retry_at: new Date(Date.now() - 1_000) })
      .where("project_id", "=", projectId)
      .where("status", "=", "applying")
      .execute();
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("0"));
    expect((await statuses()).slice(-1)).toEqual(["0:applied"]);
  });

  it("leaves a member's own automation where it is unless they turn following on", async () => {
    const mine = await enable("memberDigest", {
      type: "member",
      externalUserId: "owner",
    });
    expect(mine.follow).toBe(false);
    expect(
      (
        await enablements.setFollow({
          identity: owner,
          enablementId: mine.id,
          follow: true,
        })
      ).follow,
    ).toBe(true);
    await enablements.disable({ identity: owner, enablementId: mine.id });
  });

  it("records each revision once, and a newer one supersedes one still pending", async () => {
    await addCommit(sha("f"));
    await addCommit(sha("1"));
    await publish(sha("f"));
    await publish(sha("f"));
    await publish(sha("1"));
    expect((await statuses()).slice(-2)).toEqual(["f:superseded", "1:pending"]);
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["1:applied"]);
    expect(await commitOf(watcher)).toBe(sha("1"));
  });

  it("ignores a publication that is no longer what main points to", async () => {
    const before = await statuses();
    // A scan or a slow publisher that read main before it moved.
    await revisions.record({ projectId, commitSha: sha("e") });
    expect(await statuses()).toEqual(before);
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("1"));
  });

  it("does not move back an enablement a person pointed at a newer commit", async () => {
    await addCommit(sha("bc"));
    await addCommit(sha("cd"));
    await publish(sha("bc"));
    const preview = await enablements.preview({
      identity: owner,
      projectId,
      workflowName: "watchInbox",
      owner: { type: "project" },
      commitSha: sha("cd"),
    });
    await enablements.updateDeployment({
      identity: owner,
      enablementId: watcher,
      consentDigest: preview.consentDigest,
      commitSha: sha("cd"),
    });
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["b:applied"]);
    expect(await commitOf(watcher)).toBe(sha("cd"));
  });

  it("does not move an enablement that stopped following", async () => {
    await enablements.setFollow({
      identity: owner,
      enablementId: watcher,
      follow: false,
    });
    await addCommit(sha("2"));
    await publish(sha("2"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("cd"));
    await enablements.setFollow({
      identity: owner,
      enablementId: watcher,
      follow: true,
    });
  });

  it("moves an enablement once when two replicas advance together", async () => {
    await addCommit(sha("3"));
    await publish(sha("3"));
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

  it("never moves an enablement to a commit older than the one it runs", async () => {
    await db
      .updateTable("workflow_enablements")
      .set({ followed_sequence: null })
      .where("id", "=", watcher)
      .execute();
    const older = await db
      .selectFrom("published_revisions")
      .select("sequence")
      .where("commit_sha", "=", sha("2"))
      .executeTakeFirstOrThrow();
    await expect(
      enablements.followRevision({
        enablementId: watcher,
        commitSha: sha("2"),
        sequence: Number(older.sequence),
      }),
    ).resolves.toEqual({ kind: "unchanged", enablementId: watcher });
    expect(await commitOf(watcher)).toBe(sha("3"));
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
    await publish(sha("4"));
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
    await publish(sha("5"));
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
    await publish(sha("6"));
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
    await publish(sha("7"));
    await revisions.advance();
    await publish(sha("8"));
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
    await addCommit(sha("9"));
    manifests.set(
      sha("9"),
      JSON.stringify({ deploy: { workflow: "seedData" } }),
    );
    await publish(sha("9"));
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["9:failed"]);
    expect(await commitOf(watcher)).toBe(sha("8"));
    const [failed] = await revisions.list({ identity: owner, projectId });
    expect(failed?.error).toContain("not turned on as a project automation");
  });

  it("tries a failed revision again once by itself when its deploy workflow is consented to again", async () => {
    const suspend = () =>
      db
        .updateTable("workflow_enablements")
        .set({
          status: "suspended",
          suspension_reason: "connection_unavailable",
        })
        .where("id", "=", migrate)
        .execute();
    await suspend();
    await addCommit(sha("ab"));
    manifests.set(sha("ab"), deployManifest);
    await publish(sha("ab"));
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["a:failed"]);
    const [blocked] = await revisions.list({ identity: owner, projectId });
    expect(blocked?.error).toContain("could not start");

    // Turning the deploy automation back on tries the revision again.
    const started = deploys.length;
    await enablements.reenable({ identity: owner, enablementId: migrate });
    expect((await statuses()).slice(-1)).toEqual(["a:pending"]);
    await revisions.advance();
    expect(deploys.slice(started)).toEqual([
      expect.objectContaining({ commit: sha("ab"), previous: sha("8") }),
    ]);
    await settleRun(deploys.at(-1)?.runId ?? "", "failed");
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["a:failed"]);

    // Only once: consenting again does not start another deploy.
    await suspend();
    await enablements.reenable({ identity: owner, enablementId: migrate });
    expect((await statuses()).slice(-1)).toEqual(["a:failed"]);
    expect(deploys).toHaveLength(started + 1);
    expect(await commitOf(watcher)).toBe(sha("8"));
  });

  it("tries the latest failed revision again on request, for whoever manages project automations", async () => {
    const viewer: Identity = {
      tenantId,
      externalUserId: "viewer",
      scope: [],
      projectPermissions: [],
    };
    await expect(
      revisions.retry({ identity: viewer, projectId }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const retried = await revisions.retry({ identity: owner, projectId });
    expect(retried).toMatchObject({ status: "pending", error: null });
    await revisions.advance();
    const run = deploys.at(-1);
    expect(run).toMatchObject({ commit: sha("ab"), previous: sha("8") });
    await settleRun(run?.runId ?? "", "completed");
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["a:applied"]);
    expect(await commitOf(watcher)).toBe(sha("ab"));
    expect(await commitOf(migrate)).toBe(sha("ab"));

    await expect(
      revisions.retry({ identity: owner, projectId }),
    ).rejects.toBeInstanceOf(PublishedRevisionNotRetryableError);
  });
});

describe("what following never does on its own (ADR 0330)", () => {
  const admin: Identity = {
    tenantId,
    externalUserId: "admin",
    ...projectAdmin(projectId),
  };
  let watcher: string;

  it("lets only the member turn following on for their own automation", async () => {
    const mine = await enable("memberReport", {
      type: "member",
      externalUserId: "owner",
    });
    await expect(
      enablements.setFollow({
        identity: admin,
        enablementId: mine.id,
        follow: true,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      enablements.setFollow({
        identity: owner,
        enablementId: mine.id,
        follow: true,
      }),
    ).resolves.toMatchObject({ follow: true });
    // Anyone who may manage it may stop it following.
    await expect(
      enablements.setFollow({
        identity: admin,
        enablementId: mine.id,
        follow: false,
      }),
    ).resolves.toMatchObject({ follow: false });
    await enablements.disable({ identity: owner, enablementId: mine.id });
  });

  it("needs consent when a revision changes the workflow's triggers", async () => {
    watcher = (await enablements.list({ identity: owner, projectId })).find(
      (item) => item.workflowName === "watchInbox",
    )!.id;
    const before = await commitOf(watcher);
    await addCommit(sha("fa"), {
      triggers: [{ kind: "webhook", config: { path: "public" } }],
    });
    await publish(sha("fa"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(before);
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "automation_update_needs_consent" }),
    ]);
  });

  it("needs consent when a revision declares new secrets", async () => {
    const before = await commitOf(watcher);
    await addCommit(sha("fb"), { secrets: ["PAYMENTS_KEY"] });
    await publish(sha("fb"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(before);
    // Every run of the project receives its declared secrets.
    expect(notifications.map((notice) => notice.title).sort()).toEqual([
      "migrate needs your consent to update",
      "watchInbox needs your consent to update",
    ]);
  });
});

describe("going live through passing trouble (ADRs 0330, 0331)", () => {
  let watcher: string;
  const deployManifest = JSON.stringify({ deploy: { workflow: "migrate" } });
  const openRevision = () =>
    db
      .selectFrom("published_revisions")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
  const due = () =>
    db
      .updateTable("published_revisions")
      .set({ retry_at: new Date(Date.now() - 1_000) })
      .where("project_id", "=", projectId)
      .execute();

  it("waits for a machine to come back instead of asking for consent", async () => {
    watcher = (await enablements.list({ identity: owner, projectId })).find(
      (item) => item.workflowName === "watchInbox",
    )!.id;
    await addCommit(sha("fc"));
    previewError = new EnvironmentBindingUnavailableError("default");
    await publish(sha("fc"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("ab"));
    expect(notifications).toEqual([]);
    expect((await openRevision()).status).toBe("applying");

    previewError = null;
    await due();
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("fc"));
  });

  it("tries a deploy that could not start for a passing reason again, instead of failing it", async () => {
    await addCommit(sha("fd"));
    manifests.set(sha("fd"), deployManifest);
    const started = deploys.length;
    deployStartFailure = new Error("No machine has room for this run");
    await publish(sha("fd"));
    await revisions.advance();
    expect((await openRevision()).status).toBe("deploying");
    expect(notifications).toEqual([]);
    expect(deploys).toHaveLength(started);

    deployStartFailure = null;
    await due();
    await revisions.advance();
    expect(deploys.slice(started)).toEqual([
      expect.objectContaining({ commit: sha("fd") }),
    ]);
    await settleRun(deploys.at(-1)?.runId ?? "", "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("fd"));
  });

  it("finds the deploy run it started when it lost the run's id, instead of starting another", async () => {
    await addCommit(sha("fe"));
    manifests.set(sha("fe"), deployManifest);
    await publish(sha("fe"));
    await revisions.advance();
    const started = deploys.length;
    const runId = deploys.at(-1)?.runId;
    await settleRun(runId ?? "", "completed");
    // The process died after the run started and before it kept the id.
    await db
      .updateTable("published_revisions")
      .set({ deploy_run_id: null })
      .where("project_id", "=", projectId)
      .where("status", "=", "deploying")
      .execute();
    await revisions.advance();
    await revisions.advance();
    expect(deploys).toHaveLength(started);
    expect(await commitOf(watcher)).toBe(sha("fe"));
  });

  it("tells the people who manage automations when a deploy runs long, and gives up after its timeout", async () => {
    await addCommit(sha("0a"));
    manifests.set(sha("0a"), deployManifest);
    await publish(sha("0a"));
    await revisions.advance();
    const runId = deploys.at(-1)?.runId ?? "";
    const startedAgo = (minutes: number) =>
      db
        .updateTable("published_revisions")
        .set({ deploy_started_at: new Date(Date.now() - minutes * 60_000) })
        .where("project_id", "=", projectId)
        .where("status", "=", "deploying")
        .execute();

    await startedAgo(20);
    await revisions.advance();
    await revisions.advance();
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "deploy_running_long", to: "owner" }),
    ]);

    await startedAgo(120);
    await revisions.advance();
    expect((await openRevision()).status).toBe("failed");
    expect((await openRevision()).error).toContain("longer than");
    expect(canceled).toContain(runId);
    expect(await commitOf(watcher)).toBe(sha("fe"));
  });

  it("advances a ready project before one that is waiting to try again", async () => {
    const other = crypto.randomUUID();
    await db
      .insertInto("projects")
      .values({ id: other, tenant_id: tenantId, name: "Other" })
      .execute();
    await addCommit(sha("1a"));
    await publish(sha("1a"));
    await db
      .updateTable("published_revisions")
      .set({ retry_at: new Date(Date.now() + 60_000) })
      .where("project_id", "=", projectId)
      .where("status", "=", "pending")
      .execute();
    await db
      .insertInto("published_revisions")
      .values({ tenant_id: tenantId, project_id: other, commit_sha: sha("2a") })
      .execute();
    await expect(revisions.advance({ limit: 1 })).resolves.toBe(1);
    expect(
      await db
        .selectFrom("published_revisions")
        .select("status")
        .where("project_id", "=", other)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "applied" });
  });
});
