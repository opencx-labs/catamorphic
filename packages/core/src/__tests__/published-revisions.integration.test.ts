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
  DEPLOY_WORKFLOW_REMOVED,
  PROJECT_DEPLOY_EVENT,
  PublishedRevisionNotRetryableError,
  PublishedRevisionsService,
  parseProjectDeploy,
} from "../services/published-revisions-service.js";
import {
  type Run,
  WorkflowRevisionUnavailableError,
} from "../services/runs-service.js";
import { WaitedEventsService } from "../services/waited-events.js";
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
    documents: Array<{ path: string; access: "read" | "write" }>;
    secrets: string[];
    fails?: string;
    artifactId: string;
  }
>();
/** `.work/project.json` per commit. */
const manifests = new Map<string, string>();
/** The workflows that bind `project.deploy` at each commit (ADR 0355). */
const deployBindings = new Map<string, string[]>();
/** Reading what a commit binds fails with this while set. */
let bindingsError: Error | null = null;
const notifications: Array<{ kind: string; to: string; title: string }> = [];
/** Deploy runs Work started, in order, with the event each was started by. */
const deploys: Array<{
  runId: string;
  workflow: string;
  commit: string;
  previous: unknown;
  event: string;
}> = [];

/** The deploy event a run was handed as its input. */
function deployInput(value: unknown): {
  id: string;
  commit: string;
  previous: unknown;
} {
  const event = value as {
    id: string;
    kind: string;
    source: string;
    payload: { detail: { commit: string; previousCommit: unknown } };
  };
  expect(event).toMatchObject({
    kind: PROJECT_DEPLOY_EVENT,
    source: "project",
  });
  return {
    id: event.id,
    commit: event.payload.detail.commit,
    previous: event.payload.detail.previousCommit,
  };
}
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
    /** watchInbox's declared store paths at this commit (ADR 0335). */
    documents?: Array<{ path: string; access: "read" | "write" }>;
    fails?: string;
    /** The secret names the project declares at this commit. */
    secrets?: string[];
    /** watchInbox's triggers at this commit. */
    triggers?: Array<{
      kind: string;
      config: unknown;
      where?: unknown;
      projectKind?: string;
    }>;
    /** The project's own kinds as the commit's scan resolved them. */
    projectKinds?: Array<{ name: string; recordable: boolean }>;
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
      .values({
        project_id: projectId,
        commit_sha: commitSha,
        project_kinds: JSON.stringify(
          (options.projectKinds ?? []).map((kind) => ({
            name: kind.name,
            kind: "webhook",
            config: { name: "github" },
            where: [],
            recordable: kind.recordable,
          })),
        ),
      })
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
        project_kind: trigger.projectKind ?? null,
        config: JSON.stringify(trigger.config),
        where_filters: JSON.stringify(trigger.where ?? []),
        input_parameters: JSON.stringify([]),
        can_suspend: false,
      })
      .execute();
  targets.set(commitSha, {
    permissions: options.permissions ?? [],
    documents: options.documents ?? [],
    secrets: options.secrets ?? [],
    ...(options.fails ? { fails: options.fails } : {}),
    artifactId,
  });
}

function revisionsService(): PublishedRevisionsService {
  // The waited event as core records it: only who listens is not asked of
  // it here, since a deploy's listeners are read at its revision.
  const waited = new WaitedEventsService({
    db,
    triggers: { projectListeners: async () => [] },
    cancelRun: async () => {},
  });
  return new PublishedRevisionsService({
    db,
    enablements,
    boundWorkflows: async ({ commitSha, kind }) => {
      if (bindingsError) throw bindingsError;
      return kind === PROJECT_DEPLOY_EVENT
        ? (deployBindings.get(commitSha) ?? [])
        : [];
    },
    recordEvent: (input) => waited.record(input),
    runs: () => ({
      triggerWithEnablementAtRevision: async (args, dispatch) => {
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
        // As the runs service does: the automation's existing authority
        // runs the revision only when the revision leaves it unchanged.
        const ready = await enablements.previewAtRevision({
          enablementId: args.enablementId,
          commitSha: args.commitSha,
        });
        if (ready.kind !== "ready")
          throw new WorkflowRevisionUnavailableError(ready.reason, ready.kind);
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
        const input = deployInput(args.input);
        expect(dispatch).toEqual({
          kind: PROJECT_DEPLOY_EVENT,
          mode: "async",
          event: { id: input.id, waited: true },
        });
        const run = await insertRun({
          workflowName: args.workflowName,
          commitSha: args.commitSha,
          status: "running",
          correlationKey: args.correlationKey,
          eventId: input.id,
        });
        deploys.push({
          runId: run,
          workflow: args.workflowName,
          commit: input.commit,
          previous: input.previous,
          event: input.id,
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
  eventId?: string;
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
      event_id: input.eventId ?? null,
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
        documents: target.documents,
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

describe("a revision's deploy is an event workflows bind (ADRs 0331, 0355)", () => {
  let watcher: string;
  let migrate: string;
  /** The workflow `migrate` binds `project.deploy` at this commit. */
  const migrates = (commitSha: string) =>
    deployBindings.set(commitSha, ["migrate"]);
  const latest = async () =>
    (await revisions.list({ identity: owner, projectId }))[0];

  it("names no workflow in the manifest: one that still does keeps its revision from going live", () => {
    expect(parseProjectDeploy(null)).toEqual({ kind: "none" });
    expect(parseProjectDeploy("{}")).toEqual({ kind: "none" });
    expect(parseProjectDeploy(JSON.stringify({ environments: {} }))).toEqual({
      kind: "none",
    });
    for (const deploy of [{ workflow: "migrate" }, {}, "migrate"])
      expect(parseProjectDeploy(JSON.stringify({ deploy }))).toEqual({
        kind: "invalid",
        error: DEPLOY_WORKFLOW_REMOVED,
      });
    expect(DEPLOY_WORKFLOW_REMOVED).toContain('trigger("project.deploy")');
    expect(parseProjectDeploy("{")).toMatchObject({ kind: "invalid" });
  });

  it("records the event once at the revision and runs its listener there, before following enablements move", async () => {
    head = sha("3");
    watcher = (await enablements.list({ identity: owner, projectId })).find(
      (item) => item.workflowName === "watchInbox",
    )!.id;
    migrate = (await enable("migrate")).id;

    await addCommit(sha("4"));
    migrates(sha("4"));
    await publish(sha("4"));
    await revisions.advance();

    expect(deploys).toEqual([
      expect.objectContaining({
        workflow: "migrate",
        commit: sha("4"),
        previous: sha("3"),
      }),
    ]);
    expect((await statuses()).slice(-1)).toEqual(["4:deploying"]);
    // The event is recorded as one its emitter waits for and delivers at
    // the revision, so the dispatcher never hands it to an automation at
    // the commit it runs now.
    const recorded = await db
      .selectFrom("project_events")
      .select(["id", "source", "waited", "at_commit", "payload"])
      .where("project_id", "=", projectId)
      .where("kind", "=", PROJECT_DEPLOY_EVENT)
      .execute();
    expect(recorded).toEqual([
      {
        id: deploys[0]?.event,
        source: "project",
        waited: true,
        at_commit: sha("4"),
        payload: {
          actor: { kind: "system", code: PROJECT_DEPLOY_EVENT },
          causation: [],
          detail: { commit: sha("4"), previousCommit: sha("3") },
        },
      },
    ]);
    // Its run carries the dispatcher's stamp.
    expect(
      await db
        .selectFrom("workflow_runs")
        .select("event_id")
        .where("id", "=", deploys[0]?.runId ?? "")
        .executeTakeFirstOrThrow(),
    ).toEqual({ event_id: deploys[0]?.event });
    expect(await latest()).toMatchObject({
      status: "deploying",
      deployEventId: deploys[0]?.event,
      deployRuns: [{ workflowName: "migrate", runId: deploys[0]?.runId }],
      previousCommitSha: sha("3"),
    });
    // Waiting for the deploy: nothing moved, no second run starts, and the
    // event is not recorded again.
    await revisions.advance();
    expect(deploys).toHaveLength(1);
    expect(await commitOf(watcher)).toBe(sha("3"));

    await settleRun(deploys[0]!.runId, "completed");
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["4:applied"]);
    expect(await commitOf(watcher)).toBe(sha("4"));
    expect(await commitOf(migrate)).toBe(sha("4"));
    expect(
      await db
        .selectFrom("project_events")
        .select("id")
        .where("project_id", "=", projectId)
        .where("kind", "=", PROJECT_DEPLOY_EVENT)
        .execute(),
    ).toHaveLength(1);
  });

  it("moves nothing when the deploy fails, and tries again at the next revision", async () => {
    await addCommit(sha("5"));
    migrates(sha("5"));
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
    expect((await latest())?.error).toBe(
      "The deploy workflow migrate failed: relation already exists. Nothing moved; the previous revision stays live.",
    );

    await addCommit(sha("6"));
    migrates(sha("6"));
    await publish(sha("6"));
    await revisions.advance();
    // The live revision is still the last one that went live, and each
    // revision's deploy is an event of its own.
    expect(deploys[2]).toMatchObject({ commit: sha("6"), previous: sha("4") });
    expect(deploys[2]?.event).not.toBe(deploys[1]?.event);
    await settleRun(deploys[2]!.runId, "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("6"));
  });

  it("deploys revisions published in quick succession in order, one at a time", async () => {
    await addCommit(sha("7"));
    await addCommit(sha("8"));
    migrates(sha("7"));
    migrates(sha("8"));
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

  it("takes no deploy step when nobody listens: no binding at the revision, or one whose workflow is not a project automation", async () => {
    const started = deploys.length;
    const events = async () =>
      (
        await db
          .selectFrom("project_events")
          .select("id")
          .where("project_id", "=", projectId)
          .where("kind", "=", PROJECT_DEPLOY_EVENT)
          .execute()
      ).length;
    const before = await events();
    // The revision no longer binds the event: `migrate` is not run for it.
    await addCommit(sha("9"));
    await publish(sha("9"));
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["9:applied"]);
    expect(await commitOf(watcher)).toBe(sha("9"));
    expect(await latest()).toMatchObject({
      deployEventId: null,
      deployRuns: [],
      error: null,
    });
    // A workflow binds it and nobody turned it on for the project, or only
    // a member did for themselves: it does not listen.
    await addCommit(sha("9a"));
    deployBindings.set(sha("9a"), ["seedData", "notifyMe"]);
    head = sha("9");
    const mine = await enable("notifyMe", {
      type: "member",
      externalUserId: "owner",
    });
    await publish(sha("9a"));
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["9:applied"]);
    expect((await latest())?.commitSha).toBe(sha("9a"));
    expect(await commitOf(watcher)).toBe(sha("9a"));
    expect(deploys).toHaveLength(started);
    expect(await events()).toBe(before);
    await enablements.disable({ identity: owner, enablementId: mine.id });
  });

  it("fails a revision whose manifest still names a deploy workflow, saying what to bind instead", async () => {
    const started = deploys.length;
    await addCommit(sha("9b"));
    manifests.set(
      sha("9b"),
      JSON.stringify({ deploy: { workflow: "migrate" } }),
    );
    migrates(sha("9b"));
    await publish(sha("9b"));
    await revisions.advance();
    expect((await latest())?.status).toBe("failed");
    expect((await latest())?.error).toBe(DEPLOY_WORKFLOW_REMOVED);
    expect(deploys).toHaveLength(started);
    expect(await commitOf(watcher)).toBe(sha("9a"));
    // With the key gone the next revision's listener runs as bound.
    await addCommit(sha("9c"));
    migrates(sha("9c"));
    await publish(sha("9c"));
    await revisions.advance();
    expect(deploys.at(-1)).toMatchObject({
      commit: sha("9c"),
      previous: sha("9a"),
    });
    await settleRun(deploys.at(-1)?.runId ?? "", "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("9c"));
  });

  it("does not go live when what the revision binds cannot be read, and waits when that may clear", async () => {
    await addCommit(sha("9d"));
    migrates(sha("9d"));
    bindingsError = new Error("connection reset");
    await publish(sha("9d"));
    await revisions.advance();
    // A failure that may clear: the revision waits, and nothing is told.
    expect((await latest())?.status).toBe("pending");
    expect(notifications).toEqual([]);
    bindingsError = new WorkflowSourceInvalidError(
      "Unknown trigger kind 'project.deployed'",
    );
    await db
      .updateTable("published_revisions")
      .set({ retry_at: null })
      .where("project_id", "=", projectId)
      .where("status", "=", "pending")
      .execute();
    await revisions.advance();
    bindingsError = null;
    expect((await latest())?.status).toBe("failed");
    expect((await latest())?.error).toContain(
      "What listens for this revision's deploy could not be read: Unknown trigger kind",
    );
    expect(await commitOf(watcher)).toBe(sha("9c"));
    // Tried again on request, it deploys as bound.
    await revisions.retry({ identity: owner, projectId });
    await revisions.advance();
    await settleRun(deploys.at(-1)?.runId ?? "", "completed");
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("9d"));
  });

  it("tries a failed revision again once by itself when a workflow that listened for its deploy is consented to again", async () => {
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
    migrates(sha("ab"));
    await publish(sha("ab"));
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["a:failed"]);
    const blocked = await latest();
    expect(blocked?.error).toContain(
      "The deploy workflow migrate could not start",
    );
    // What listened is kept with the failure.
    expect(blocked?.deployRuns).toEqual([
      { workflowName: "migrate", runId: null },
    ]);

    // Turning the listening automation back on tries the revision again.
    const started = deploys.length;
    await enablements.reenable({ identity: owner, enablementId: migrate });
    expect((await statuses()).slice(-1)).toEqual(["a:pending"]);
    await revisions.advance();
    expect(deploys.slice(started)).toEqual([
      expect.objectContaining({ commit: sha("ab"), previous: sha("9d") }),
    ]);
    await settleRun(deploys.at(-1)?.runId ?? "", "failed");
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["a:failed"]);

    // Only once: consenting again does not start another deploy.
    await suspend();
    await enablements.reenable({ identity: owner, enablementId: migrate });
    expect((await statuses()).slice(-1)).toEqual(["a:failed"]);
    expect(deploys).toHaveLength(started + 1);
    expect(await commitOf(watcher)).toBe(sha("9d"));
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
    expect(retried).toMatchObject({
      status: "pending",
      error: null,
      deployEventId: null,
      deployRuns: [],
    });
    await revisions.advance();
    const run = deploys.at(-1);
    expect(run).toMatchObject({ commit: sha("ab"), previous: sha("9d") });
    // Each try is an event of its own.
    expect(new Set(deploys.slice(-3).map((deploy) => deploy.event)).size).toBe(
      3,
    );
    await settleRun(run?.runId ?? "", "completed");
    await revisions.advance();
    expect((await statuses()).slice(-1)).toEqual(["a:applied"]);
    expect(await commitOf(watcher)).toBe(sha("ab"));
    expect(await commitOf(migrate)).toBe(sha("ab"));

    await expect(
      revisions.retry({ identity: owner, projectId }),
    ).rejects.toBeInstanceOf(PublishedRevisionNotRetryableError);
  });

  it("runs every listener for the one event, and goes live only when all of them succeeded", async () => {
    head = sha("ab");
    const seed = (await enable("seedData")).id;
    const both = (commitSha: string) =>
      deployBindings.set(commitSha, ["migrate", "seedData"]);
    const runOf = (started: number, workflow: string) =>
      deploys.slice(started).find((deploy) => deploy.workflow === workflow);

    let started = deploys.length;
    await addCommit(sha("ac"));
    both(sha("ac"));
    await publish(sha("ac"));
    await revisions.advance();
    expect(
      deploys
        .slice(started)
        .map((deploy) => deploy.workflow)
        .sort(),
    ).toEqual(["migrate", "seedData"]);
    // One event, a run of its own for each listener.
    expect(runOf(started, "migrate")?.event).toBe(
      runOf(started, "seedData")?.event,
    );
    expect(
      await db
        .selectFrom("project_events")
        .select("id")
        .where("id", "=", runOf(started, "migrate")?.event ?? "")
        .execute(),
    ).toHaveLength(1);
    expect((await latest())?.deployRuns).toEqual(
      expect.arrayContaining([
        { workflowName: "migrate", runId: runOf(started, "migrate")?.runId },
        { workflowName: "seedData", runId: runOf(started, "seedData")?.runId },
      ]),
    );

    // One failed and the other still runs: the deploy waits for it.
    await settleRun(runOf(started, "seedData")?.runId ?? "", "failed");
    await revisions.advance();
    expect((await latest())?.status).toBe("deploying");
    expect(notifications).toEqual([]);
    await settleRun(runOf(started, "migrate")?.runId ?? "", "completed");
    await revisions.advance();
    expect(await latest()).toMatchObject({
      status: "failed",
      error:
        "The deploy workflow seedData failed: relation already exists. Nothing moved; the previous revision stays live.",
    });
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "deploy_failed", to: "owner" }),
    ]);
    expect(await commitOf(watcher)).toBe(sha("ab"));
    expect(await commitOf(seed)).toBe(sha("ab"));

    // The next revision, while one listener cannot run: every listener is
    // asked before any run starts, so the other's run is never begun.
    started = deploys.length;
    const canceledBefore = canceled.length;
    await db
      .updateTable("workflow_enablements")
      .set({ status: "suspended", suspension_reason: "connection_unavailable" })
      .where("id", "=", seed)
      .execute();
    notifications.length = 0;
    await addCommit(sha("ad"));
    both(sha("ad"));
    await publish(sha("ad"));
    await revisions.advance();
    expect(await latest()).toMatchObject({
      status: "failed",
      error:
        "The deploy workflow seedData could not start: Workflow enablement is unavailable: connection_unavailable",
      deployRuns: [
        { workflowName: "migrate", runId: null },
        { workflowName: "seedData", runId: null },
      ],
    });
    expect(deploys).toHaveLength(started);
    expect(canceled).toHaveLength(canceledBefore);

    // Turned back on, the revision is tried again: both succeed, and
    // everything moves.
    await enablements.reenable({ identity: owner, enablementId: seed });
    expect((await latest())?.status).toBe("pending");
    await revisions.advance();
    expect(deploys.slice(started)).toHaveLength(2);
    for (const deploy of deploys.slice(started)) {
      expect(deploy).toMatchObject({ commit: sha("ad"), previous: sha("ab") });
      await settleRun(deploy.runId, "completed");
    }
    await revisions.advance();
    expect((await latest())?.status).toBe("applied");
    expect(await commitOf(watcher)).toBe(sha("ad"));
    expect(await commitOf(migrate)).toBe(sha("ad"));
    expect(await commitOf(seed)).toBe(sha("ad"));
    await enablements.disable({ identity: owner, enablementId: seed });
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

  it("needs consent when a revision lets workflows record a verified kind", async () => {
    const pullRequest = {
      kind: "webhook",
      config: { name: "github" },
      projectKind: "github.pull_request",
    };
    await addCommit(sha("f1"), {
      triggers: [pullRequest],
      projectKinds: [{ name: "github.pull_request", recordable: false }],
    });
    await addCommit(sha("f2"), {
      triggers: [pullRequest],
      projectKinds: [{ name: "github.pull_request", recordable: false }],
    });
    await addCommit(sha("f3"), {
      triggers: [pullRequest],
      projectKinds: [{ name: "github.pull_request", recordable: true }],
    });
    const authorityAt = async (commitSha: string) =>
      (
        await enablements.preview({
          identity: owner,
          projectId,
          workflowName: "watchInbox",
          owner: { type: "project" },
          commitSha,
        })
      ).authorityDigest;
    // The same triggers, the same authority; recording them is not.
    expect(await authorityAt(sha("f2"))).toBe(await authorityAt(sha("f1")));
    expect(await authorityAt(sha("f3"))).not.toBe(await authorityAt(sha("f1")));
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
  /** The workflow `migrate` binds `project.deploy` at this commit. */
  const migrates = (commitSha: string) =>
    deployBindings.set(commitSha, ["migrate"]);
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
    const live = await commitOf(watcher);
    await addCommit(sha("fc"));
    previewError = new EnvironmentBindingUnavailableError("default");
    await publish(sha("fc"));
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(live);
    expect(notifications).toEqual([]);
    expect((await openRevision()).status).toBe("applying");

    previewError = null;
    await due();
    await revisions.advance();
    expect(await commitOf(watcher)).toBe(sha("fc"));
  });

  it("tries a deploy that could not start for a passing reason again, instead of failing it", async () => {
    await addCommit(sha("fd"));
    migrates(sha("fd"));
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
    migrates(sha("fe"));
    await publish(sha("fe"));
    await revisions.advance();
    const started = deploys.length;
    const runId = deploys.at(-1)?.runId;
    await settleRun(runId ?? "", "completed");
    // The process died after the run started and before it kept the id.
    const deploying = await openRevision();
    await db
      .updateTable("published_revisions")
      .set({
        deploy_listeners: JSON.stringify(
          (deploying.deploy_listeners as Array<Record<string, unknown>>).map(
            (listener) => ({ ...listener, runId: null }),
          ),
        ),
      })
      .where("id", "=", deploying.id)
      .execute();
    await revisions.advance();
    await revisions.advance();
    expect(deploys).toHaveLength(started);
    expect(await commitOf(watcher)).toBe(sha("fe"));
  });

  it("tells the people who manage automations when a deploy runs long, and gives up after its timeout", async () => {
    await addCommit(sha("0a"));
    migrates(sha("0a"));
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

describe("moving keeps what a trigger received (ADR 0330)", () => {
  it("keeps an unchanged trigger's activation, created time and receipts, and starts a new one fresh", async () => {
    const watcher =
      (await enablements.list({ identity: owner, projectId })).find(
        (item) => item.workflowName === "watchInbox",
      )?.id ?? (await enable("watchInbox")).id;
    const moveTo = async (commitSha: string) => {
      const preview = await enablements.preview({
        identity: owner,
        projectId,
        workflowName: "watchInbox",
        owner: { type: "project" },
        commitSha,
      });
      await enablements.updateDeployment({
        identity: owner,
        enablementId: watcher,
        consentDigest: preview.consentDigest,
        commitSha,
      });
    };
    const activations = () =>
      db
        .selectFrom("workflow_enablement_triggers as activation")
        .innerJoin(
          "trigger_definitions as definition",
          "definition.id",
          "activation.trigger_definition_id",
        )
        .select([
          "activation.id",
          "activation.created_at",
          "definition.commit_sha",
          "definition.config",
        ])
        .where("activation.enablement_id", "=", watcher)
        .orderBy("definition.binding_index")
        .execute();
    const inbox = { kind: "webhook", config: { name: "inbox" } };
    await addCommit(sha("e1"), { triggers: [inbox] });
    await moveTo(sha("e1"));
    const [before] = await activations();
    // An event received before the move, its delivery waiting to retry.
    const event = await db
      .insertInto("project_events")
      .values({
        project_id: projectId,
        source: "webhook",
        kind: "webhook",
        external_id: "delivery-1",
        occurred_at: new Date(),
        payload: JSON.stringify({ name: "inbox" }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("project_event_deliveries")
      .values({ activation_id: before!.id, event_id: event.id })
      .execute();

    await addCommit(sha("e2"), {
      triggers: [inbox, { kind: "webhook", config: { name: "alerts" } }],
    });
    await moveTo(sha("e2"));
    const after = await activations();
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({
      id: before!.id,
      created_at: before!.created_at,
      commit_sha: sha("e2"),
    });
    expect(after[1]?.id).not.toBe(before!.id);
    expect(after[1]?.created_at.getTime()).toBeGreaterThan(
      before!.created_at.getTime(),
    );
    expect(
      await db
        .selectFrom("project_event_deliveries")
        .select("status")
        .where("activation_id", "=", before!.id)
        .where("event_id", "=", event.id)
        .executeTakeFirst(),
    ).toEqual({ status: "pending" });
  });
});

describe("a deploy listener whose authority the revision changes (ADRs 0331, 0355)", () => {
  const latest = async () =>
    (await revisions.list({ identity: owner, projectId }))[0];

  it("fails the deploy with the reason, runs nothing, and tries it again once that is consented to", async () => {
    const live = (
      await db
        .selectFrom("published_revisions")
        .select("commit_sha")
        .where("project_id", "=", projectId)
        .where("status", "=", "applied")
        .orderBy("sequence", "desc")
        .executeTakeFirstOrThrow()
    ).commit_sha;
    head = live;
    const backfill = (await enable("backfill")).id;
    const started = deploys.length;
    // The revision asks for more than `backfill` was consented to.
    await addCommit(sha("5c"), { permissions: ["documents:write"] });
    deployBindings.set(sha("5c"), ["backfill"]);
    await publish(sha("5c"));
    notifications.length = 0;
    await revisions.advance();
    expect(await latest()).toMatchObject({
      commitSha: sha("5c"),
      status: "failed",
      error:
        "The deploy workflow backfill could not start: This revision changes what the workflow may use or what starts it (connections, permissions, Environment, triggers or secrets)",
      deployRuns: [{ workflowName: "backfill", runId: null }],
    });
    // Nothing ran the new code under the old authority, and nothing moved.
    expect(deploys).toHaveLength(started);
    expect(notifications).toEqual([
      expect.objectContaining({ kind: "deploy_failed", to: "owner" }),
    ]);
    expect(await commitOf(backfill)).toBe(live);

    // Consenting to the listener at the revision tries the deploy again.
    const preview = await enablements.preview({
      identity: owner,
      projectId,
      workflowName: "backfill",
      owner: { type: "project" },
      commitSha: sha("5c"),
    });
    await enablements.updateDeployment({
      identity: owner,
      enablementId: backfill,
      consentDigest: preview.consentDigest,
      commitSha: sha("5c"),
    });
    expect((await latest())?.status).toBe("pending");
    await revisions.advance();
    expect(deploys.slice(started)).toEqual([
      expect.objectContaining({
        workflow: "backfill",
        commit: sha("5c"),
        previous: live,
      }),
    ]);
    await settleRun(deploys.at(-1)?.runId ?? "", "completed");
    await revisions.advance();
    expect((await latest())?.status).toBe("applied");
  });
});
