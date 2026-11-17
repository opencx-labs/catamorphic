import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, type Selectable, sql } from "kysely";
import { z } from "zod";
import { type Identity, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import { ReplicaClaimBusyError, withReplicaClaim } from "./replica-claims.js";
import { toJson } from "./run-coordinator.js";
import type { RunsService } from "./runs-service.js";
import type { UserNotificationsService } from "./user-notifications-service.js";
import type { WorkWakeups } from "./work-wakeups.js";
import type { WorkflowEnablementFollowOutcome } from "./workflow-enablement-types.js";
import {
  FOLLOW_ACTOR,
  type WorkflowEnablementsService,
} from "./workflow-enablements-service.js";

const tracer = getTracer("@catamorphic/core");

export type PublishedRevisionStatus =
  | "pending"
  | "deploying"
  | "applying"
  | "applied"
  | "superseded"
  | "failed";

/** What following one revision did, per enablement, with its workflow. */
export type PublishedRevisionReportEntry = WorkflowEnablementFollowOutcome & {
  workflowName: string;
};

/** One published revision of a project and how it went live (ADR 0330). */
export interface PublishedRevision {
  id: string;
  sequence: number;
  projectId: string;
  commitSha: string;
  status: PublishedRevisionStatus;
  /** The project's deploy workflow that ran for it (ADR 0331). */
  deployWorkflow: string | null;
  deployRunId: string | null;
  previousCommitSha: string | null;
  error: string | null;
  report: PublishedRevisionReportEntry[];
  createdAt: string;
  settledAt: string | null;
}

/** `project.json`'s `deploy` (ADR 0331). */
const DeploySchema = z.strictObject({
  workflow: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message: "deploy.workflow names an exported workflow",
  }),
});

export type ProjectDeploy =
  | { kind: "none" }
  | { kind: "workflow"; workflow: string }
  | { kind: "invalid"; error: string };

/** Read `deploy` from the project manifest's text (null: no manifest). */
export function parseProjectDeploy(content: string | null): ProjectDeploy {
  if (content === null) return { kind: "none" };
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch (cause) {
    return {
      kind: "invalid",
      error: `.work/project.json is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (typeof manifest !== "object" || manifest === null)
    return { kind: "none" };
  const raw = (manifest as Record<string, unknown>).deploy;
  if (raw === undefined) return { kind: "none" };
  const parsed = DeploySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: "invalid",
      error: `.work/project.json deploy${
        issue?.path.length ? `.${issue.path.join(".")}` : ""
      }: ${issue?.message ?? "invalid"}`,
    };
  }
  return { kind: "workflow", workflow: parsed.data.workflow };
}

const TERMINAL_RUN = ["completed", "failed", "canceled"];

interface PublishedRevisionsDeps {
  db: Kysely<DB>;
  enablements: WorkflowEnablementsService;
  runs: () => Pick<RunsService, "triggerWithEnablementAtRevision">;
  /** `.work/project.json` at a commit, or null when it has none. */
  readManifest(args: {
    tenantId: string;
    projectId: string;
    commitSha: string;
  }): Promise<string | null>;
  notifications: Pick<UserNotificationsService, "publish">;
  /** Members who may manage the project's automations (`automations:write`). */
  automationManagers(args: {
    tenantId: string;
    projectId: string;
  }): Promise<string[]>;
  wakeups?: WorkWakeups;
  /** Default 60. */
  claimTtlSeconds?: number;
}

/**
 * Published revisions and how they go live (ADRs 0330, 0331). Every
 * publication is recorded in order; the dispatch pass advances each
 * project one step at a time under its replica claim: run the project's
 * deploy workflow at the revision and wait for it, then move every
 * following enablement there. A newer revision supersedes one still
 * pending; one deploys or applies at a time per project, on any replica.
 */
export class PublishedRevisionsService {
  constructor(private readonly deps: PublishedRevisionsDeps) {}

  private get db(): Kysely<DB> {
    return this.deps.db;
  }

  /** Record a revision of `main`; nothing when it is already the latest. */
  async record(input: { projectId: string; commitSha: string }): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(input.commitSha)) return;
    const latest = () =>
      this.db
        .selectFrom("published_revisions")
        .select("commit_sha")
        .where("project_id", "=", input.projectId)
        .orderBy("sequence", "desc")
        .limit(1)
        .executeTakeFirst();
    if ((await latest())?.commit_sha === input.commitSha) return;
    const recorded = await this.db.transaction().execute(async (trx) => {
      // Recorders of one project take turns, so publication order is the
      // order of the sequence.
      const project = await trx
        .selectFrom("projects")
        .select("tenant_id")
        .where("id", "=", input.projectId)
        .forUpdate()
        .executeTakeFirst();
      if (!project) return false;
      const current = await trx
        .selectFrom("published_revisions")
        .select("commit_sha")
        .where("project_id", "=", input.projectId)
        .orderBy("sequence", "desc")
        .limit(1)
        .executeTakeFirst();
      if (current?.commit_sha === input.commitSha) return false;
      await trx
        .updateTable("published_revisions")
        .set({
          status: "superseded",
          settled_at: new Date(),
          updated_at: new Date(),
        })
        .where("project_id", "=", input.projectId)
        .where("status", "=", "pending")
        .execute();
      await trx
        .insertInto("published_revisions")
        .values({
          tenant_id: project.tenant_id,
          project_id: input.projectId,
          commit_sha: input.commitSha,
        })
        .execute();
      return true;
    });
    if (recorded) this.deps.wakeups?.notify("events");
  }

  /** Recent revisions of a project, newest first. */
  async list(input: {
    identity: Identity;
    projectId: string;
    limit?: number;
  }): Promise<PublishedRevision[]> {
    if (!mayUseProject(input.identity, input.projectId))
      throw new AccessDeniedError();
    const rows = await this.db
      .selectFrom("published_revisions")
      .selectAll()
      .where("tenant_id", "=", input.identity.tenantId)
      .where("project_id", "=", input.projectId)
      .orderBy("sequence", "desc")
      .limit(Math.min(Math.max(input.limit ?? 20, 1), 100))
      .execute();
    return rows.map(mapRevision);
  }

  /**
   * One pass: advance every project with an open revision by one step.
   * Returns how many projects progressed.
   */
  async advance(input: { limit?: number } = {}): Promise<number> {
    const projects = await this.db
      .selectFrom("published_revisions")
      .select("project_id")
      .distinct()
      .where("status", "in", ["pending", "deploying", "applying"])
      .limit(input.limit ?? 50)
      .execute();
    let progressed = 0;
    for (const { project_id: projectId } of projects) {
      try {
        if (await this.step(projectId)) progressed += 1;
      } catch (error) {
        if (error instanceof ReplicaClaimBusyError) continue;
        console.warn(
          `[catamorphic] Published revision of project ${projectId} could not advance`,
          error,
        );
        // A failure that may clear (the database, the network): the same
        // step runs again after a backoff.
        await this.defer(projectId).catch(() => {});
      }
    }
    return progressed;
  }

  private step(projectId: string): Promise<boolean> {
    return withReplicaClaim({
      db: this.db,
      name: `published-revisions:${projectId}`,
      ttlSeconds: this.deps.claimTtlSeconds ?? 60,
      operation: () =>
        withSpan(
          {
            tracer,
            name: "published_revision.step",
            attributes: { "catamorphic.project.id": projectId },
          },
          () => this.stepClaimed(projectId),
        ),
    });
  }

  private async stepClaimed(projectId: string): Promise<boolean> {
    const open = await this.db
      .selectFrom("published_revisions")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("status", "in", ["pending", "deploying", "applying"])
      .orderBy("sequence", "desc")
      .execute();
    const active = open.find((row) => row.status !== "pending");
    const [next, ...older] = open;
    const current = active ?? next;
    if (!current) return false;
    // A newer revision takes over what an applying one still retries.
    const newer = active?.status === "applying" && open[0] !== active;
    if (current.retry_at && current.retry_at > new Date() && !newer)
      return false;
    // A process that stopped mid-apply left it here; applying is idempotent.
    if (active?.status === "applying") {
      await this.apply(active, { newer });
      return true;
    }
    if (active?.status === "deploying") return this.checkDeploy(active);
    if (!next) return false;
    if (older.length > 0)
      await this.db
        .updateTable("published_revisions")
        .set({
          status: "superseded",
          settled_at: new Date(),
          updated_at: new Date(),
        })
        .where(
          "id",
          "in",
          older.map((row) => row.id),
        )
        .where("status", "=", "pending")
        .execute();
    return this.start(next);
  }

  private async start(row: Row): Promise<boolean> {
    const deploy = parseProjectDeploy(
      await this.deps.readManifest({
        tenantId: row.tenant_id,
        projectId: row.project_id,
        commitSha: row.commit_sha,
      }),
    );
    if (deploy.kind === "invalid") {
      await this.fail(row, deploy.error);
      return true;
    }
    if (deploy.kind === "none") {
      if (!(await this.transition(row, "pending", "applying"))) return false;
      await this.apply(row);
      return true;
    }
    const enablements = await this.db
      .selectFrom("workflow_enablements")
      .select(["id", "commit_sha", "status"])
      .where("project_id", "=", row.project_id)
      .where("workflow_name", "=", deploy.workflow)
      .where("owner_kind", "=", "project")
      .where("temporary", "=", false)
      .where("status", "!=", "disabled")
      .execute();
    if (enablements.length !== 1) {
      await this.fail(row, {
        deployWorkflow: deploy.workflow,
        error:
          enablements.length === 0
            ? `The deploy workflow ${deploy.workflow} is not turned on as a project automation. Turn it on so it runs before this revision goes live.`
            : `The deploy workflow ${deploy.workflow} is turned on as a project automation more than once; keep one.`,
      });
      return true;
    }
    const [enablement] = enablements;
    if (!enablement) return false;
    const lastLive = await this.db
      .selectFrom("published_revisions")
      .select("commit_sha")
      .where("project_id", "=", row.project_id)
      .where("status", "=", "applied")
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    const previousCommitSha = lastLive?.commit_sha ?? enablement.commit_sha;
    const claimed = await this.db
      .updateTable("published_revisions")
      .set({
        status: "deploying",
        deploy_workflow: deploy.workflow,
        deploy_enablement_id: enablement.id,
        previous_commit_sha: previousCommitSha,
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .executeTakeFirst()
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) return { numUpdatedRows: 0n };
        throw error;
      });
    if (claimed.numUpdatedRows !== 1n) return false;
    await this.startDeployRun({
      ...row,
      status: "deploying",
      deploy_workflow: deploy.workflow,
      deploy_enablement_id: enablement.id,
      previous_commit_sha: previousCommitSha,
    });
    return true;
  }

  /** Start (or, after a restart, find) the deploy run of a revision. */
  private async startDeployRun(row: Row): Promise<void> {
    if (!row.deploy_workflow || !row.deploy_enablement_id) {
      await this.fail(row, "The deploy workflow's enablement was removed");
      return;
    }
    try {
      const run = await this.deps.runs().triggerWithEnablementAtRevision({
        identity: { tenantId: row.tenant_id, externalUserId: FOLLOW_ACTOR },
        enablementId: row.deploy_enablement_id,
        projectId: row.project_id,
        workflowName: row.deploy_workflow,
        commitSha: row.commit_sha,
        input: {
          commit: row.commit_sha,
          previousCommit: row.previous_commit_sha,
        },
        // One live deploy run per revision, even when a restarted pass
        // starts it again.
        correlationKey: `deploy:${row.id}`,
        onConflict: "ignore",
      });
      await this.db
        .updateTable("published_revisions")
        .set({ deploy_run_id: run.id, updated_at: new Date() })
        .where("id", "=", row.id)
        .where("status", "=", "deploying")
        .execute();
    } catch (error) {
      await this.fail(row, {
        deployWorkflow: row.deploy_workflow,
        error: `The deploy workflow ${row.deploy_workflow} could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private async checkDeploy(row: Row): Promise<boolean> {
    if (!row.deploy_run_id) {
      await this.startDeployRun(row);
      return true;
    }
    const run = await this.db
      .selectFrom("workflow_runs")
      .select(["status", "error"])
      .where("id", "=", row.deploy_run_id)
      .executeTakeFirst();
    if (!run) {
      await this.fail(row, "The deploy run is gone");
      return true;
    }
    if (!TERMINAL_RUN.includes(run.status)) return false;
    if (run.status !== "completed") {
      await this.fail(row, {
        deployWorkflow: row.deploy_workflow,
        error: `The deploy workflow ${row.deploy_workflow} ${
          run.status === "canceled" ? "was canceled" : "failed"
        }${run.error ? `: ${run.error}` : ""}. Nothing moved; the previous revision stays live.`,
      });
      return true;
    }
    if (!(await this.transition(row, "deploying", "applying"))) return false;
    await this.apply(row);
    return true;
  }

  /**
   * Move every following enablement to the revision, then settle it. An
   * enablement whose preview hit a failure that may clear keeps the
   * revision applying, tried again after a backoff; once a newer revision
   * is waiting, that one takes the enablement over instead.
   */
  private async apply(
    row: Row,
    options: { newer?: boolean } = {},
  ): Promise<void> {
    const sequence = Number(row.sequence);
    const followers = await this.deps.enablements.followers({
      projectId: row.project_id,
      sequence,
    });
    const earlier = Array.isArray(row.report)
      ? (row.report as unknown as PublishedRevisionReportEntry[])
      : [];
    const report = new Map(
      earlier.map((entry) => [entry.enablementId, entry] as const),
    );
    let retrying = false;
    for (const follower of followers) {
      const outcome = await this.deps.enablements
        .followRevision({
          enablementId: follower.id,
          commitSha: row.commit_sha,
          sequence,
        })
        .catch(
          (error: unknown): WorkflowEnablementFollowOutcome => ({
            kind: "retry",
            enablementId: follower.id,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      report.set(follower.id, {
        ...outcome,
        workflowName: follower.workflowName,
      });
      if (outcome.kind === "retry") retrying = true;
      if (outcome.kind === "needs_consent" || outcome.kind === "skipped")
        await this.notifyOutcome(row, follower.workflowName, outcome).catch(
          (error: unknown) =>
            console.warn(
              "[catamorphic] Could not report a following enablement",
              error,
            ),
        );
    }
    if (retrying && !options.newer) {
      const attempts = row.attempts + 1;
      await this.db
        .updateTable("published_revisions")
        .set({
          report: toJson([...report.values()]),
          attempts,
          retry_at: new Date(Date.now() + retryBackoffMs(attempts)),
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .where("status", "=", "applying")
        .execute();
      return;
    }
    await this.db
      .updateTable("published_revisions")
      .set({
        status: "applied",
        report: toJson([...report.values()]),
        retry_at: null,
        settled_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .where("status", "=", "applying")
      .execute();
  }

  /** Hold a project's open revision back after a failure that may clear. */
  private async defer(projectId: string): Promise<void> {
    const row = await this.db
      .selectFrom("published_revisions")
      .select(["id", "attempts"])
      .where("project_id", "=", projectId)
      .where("status", "in", ["pending", "deploying", "applying"])
      .orderBy(sql`status = 'pending'`)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return;
    const attempts = row.attempts + 1;
    await this.db
      .updateTable("published_revisions")
      .set({
        attempts,
        retry_at: new Date(Date.now() + retryBackoffMs(attempts)),
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
  }

  /**
   * Try the project's latest revision again when it failed (ADR 0331): its
   * deploy workflow runs again at that revision and, if it succeeds, the
   * following enablements move. Needs `automations:write`.
   */
  async retry(input: {
    identity: Identity;
    projectId: string;
  }): Promise<PublishedRevision> {
    if (
      !this.deps.enablements.mayManageProjectAutomations({
        identity: input.identity,
        projectId: input.projectId,
      })
    )
      throw new AccessDeniedError();
    const latest = await this.db
      .selectFrom("published_revisions")
      .select(["id", "status", "tenant_id"])
      .where("project_id", "=", input.projectId)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!latest || latest.tenant_id !== input.identity.tenantId)
      throw new PublishedRevisionNotRetryableError(
        "This project has no published revision to try again",
      );
    if (!(await this.reopen({ id: latest.id })))
      throw new PublishedRevisionNotRetryableError(
        "The project's latest revision did not fail, so there is nothing to try again",
      );
    const row = await this.db
      .selectFrom("published_revisions")
      .selectAll()
      .where("id", "=", latest.id)
      .executeTakeFirstOrThrow();
    return mapRevision(row);
  }

  /**
   * The deploy workflow's project automation was consented to again: its
   * latest revision, if that failed, is tried once more by itself.
   */
  async retryAfterConsent(input: {
    projectId: string;
    workflowName: string;
    ownerKind: "member" | "project";
  }): Promise<void> {
    if (input.ownerKind !== "project") return;
    const latest = await this.db
      .selectFrom("published_revisions")
      .select(["id", "status", "deploy_workflow", "auto_retried"])
      .where("project_id", "=", input.projectId)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (
      latest?.status !== "failed" ||
      latest.auto_retried ||
      latest.deploy_workflow !== input.workflowName
    )
      return;
    await this.reopen({ id: latest.id, automatic: true });
  }

  /** Put a failed revision back to pending; false when it was not failed. */
  private async reopen(input: {
    id: string;
    automatic?: boolean;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable("published_revisions")
      .set({
        status: "pending",
        error: null,
        deploy_run_id: null,
        deploy_enablement_id: null,
        settled_at: null,
        attempts: 0,
        retry_at: null,
        ...(input.automatic ? { auto_retried: true } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", input.id)
      .where("status", "=", "failed")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) return false;
    this.deps.wakeups?.notify("events");
    return true;
  }

  private async transition(
    row: Row,
    from: PublishedRevisionStatus,
    to: PublishedRevisionStatus,
  ): Promise<boolean> {
    try {
      const result = await this.db
        .updateTable("published_revisions")
        .set({ status: to, updated_at: new Date() })
        .where("id", "=", row.id)
        .where("status", "=", from)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async fail(
    row: Row,
    failure: string | { deployWorkflow: string | null; error: string },
  ): Promise<void> {
    const { error, deployWorkflow } =
      typeof failure === "string"
        ? { error: failure, deployWorkflow: row.deploy_workflow }
        : failure;
    const result = await this.db
      .updateTable("published_revisions")
      .set({
        status: "failed",
        error,
        deploy_workflow: deployWorkflow,
        settled_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .where("status", "in", ["pending", "deploying"])
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) return;
    const recipients = await this.deps.automationManagers({
      tenantId: row.tenant_id,
      projectId: row.project_id,
    });
    await this.publish({
      row,
      recipients,
      kind: "deploy_failed",
      title: `Revision ${row.commit_sha.slice(0, 7)} did not go live`,
      body: error,
      collapseKey: `deploy_failed:${row.id}`,
    }).catch((cause: unknown) =>
      console.warn("[catamorphic] Could not report a failed deploy", cause),
    );
  }

  private async notifyOutcome(
    row: Row,
    workflowName: string,
    outcome: Extract<
      WorkflowEnablementFollowOutcome,
      { kind: "needs_consent" | "skipped" }
    >,
  ): Promise<void> {
    const enablement = await this.db
      .selectFrom("workflow_enablements")
      .select(["owner_kind", "owner_external_user_id", "commit_sha"])
      .where("id", "=", outcome.enablementId)
      .executeTakeFirst();
    if (!enablement) return;
    const recipients =
      enablement.owner_kind === "member" && enablement.owner_external_user_id
        ? [enablement.owner_external_user_id]
        : await this.deps.automationManagers({
            tenantId: row.tenant_id,
            projectId: row.project_id,
          });
    const live = enablement.commit_sha.slice(0, 7);
    await this.publish({
      row,
      recipients,
      kind:
        outcome.kind === "needs_consent"
          ? "automation_update_needs_consent"
          : "automation_update_skipped",
      title:
        outcome.kind === "needs_consent"
          ? `${workflowName} needs your consent to update`
          : `${workflowName} did not update to ${row.commit_sha.slice(0, 7)}`,
      body: `${outcome.reason}. It keeps running ${live}.`,
      collapseKey: `automation_update:${outcome.enablementId}:${row.commit_sha}`,
    });
  }

  private async publish(input: {
    row: Row;
    recipients: readonly string[];
    kind: string;
    title: string;
    body: string;
    collapseKey: string;
  }): Promise<void> {
    for (const externalUserId of new Set(input.recipients))
      await this.deps.notifications.publish({
        identity: { tenantId: input.row.tenant_id, externalUserId },
        kind: input.kind,
        title: input.title,
        body: input.body,
        route: `/?project=${encodeURIComponent(input.row.project_id)}`,
        collapseKey: input.collapseKey,
        projectId: input.row.project_id,
      });
  }
}

type Row = Selectable<DB["published_revisions"]>;

/** There is no failed latest revision to try again (ADR 0331). */
export class PublishedRevisionNotRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedRevisionNotRetryableError";
  }
}

/** 15 seconds after the first failure, doubling, at most 15 minutes. */
function retryBackoffMs(attempts: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

function mapRevision(row: Row): PublishedRevision {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    projectId: row.project_id,
    commitSha: row.commit_sha,
    status: row.status as PublishedRevisionStatus,
    deployWorkflow: row.deploy_workflow,
    deployRunId: row.deploy_run_id,
    previousCommitSha: row.previous_commit_sha,
    error: row.error,
    report: Array.isArray(row.report)
      ? (row.report as unknown as PublishedRevisionReportEntry[])
      : [],
    createdAt: row.created_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
