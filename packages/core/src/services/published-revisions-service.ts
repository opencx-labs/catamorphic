import { randomUUID } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { WorkflowSourceInvalidError } from "@catamorphic/parser";
import { type Kysely, type Selectable, sql } from "kysely";
import { type Identity, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import { ReplicaClaimBusyError, withReplicaClaim } from "./replica-claims.js";
import { toJson } from "./run-coordinator.js";
import {
  RunInputInvalidError,
  type RunsService,
  WorkflowRevisionUnavailableError,
} from "./runs-service.js";
import type { UserNotificationsService } from "./user-notifications-service.js";
import type { WorkWakeups } from "./work-wakeups.js";
import type { WorkflowEnablementFollowOutcome } from "./workflow-enablement-types.js";
import {
  FOLLOW_ACTOR,
  WorkflowEnablementSuspendedError,
  type WorkflowEnablementsService,
} from "./workflow-enablements-service.js";
import { WorkflowNotFoundError } from "./workflows-service.js";
import {
  type PendingProjectEvent,
  projectEventInput,
} from "./workspace-events.js";

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

/**
 * `project.deploy` (ADR 0355): a published revision is about to go live.
 * Project workflows bind it in their own source; Work records it once per
 * try of a revision, before the automations that follow `main` move there,
 * and the revision goes live only once every run it started succeeded.
 */
export const PROJECT_DEPLOY_EVENT = "project.deploy";

/** The source of the project's own events. */
export const PROJECT_EVENT_SOURCE = "project";

/** One project automation that listens for a revision's deploy. */
export interface DeployListener {
  enablementId: string;
  workflowName: string;
  /** The run it started for this try, once it started. */
  runId: string | null;
}

/** One published revision of a project and how it went live (ADR 0330). */
export interface PublishedRevision {
  id: string;
  sequence: number;
  projectId: string;
  commitSha: string;
  status: PublishedRevisionStatus;
  /** The deploy event recorded for it (ADR 0355), when somebody listened. */
  deployEventId: string | null;
  /** The workflows that listened at this revision, and the run of each. */
  deployRuns: Array<{ workflowName: string; runId: string | null }>;
  previousCommitSha: string | null;
  error: string | null;
  report: PublishedRevisionReportEntry[];
  createdAt: string;
  settledAt: string | null;
}

/**
 * What a manifest that still names a deploy workflow is told (ADR 0355): a
 * workflow is never named in configuration.
 */
export const DEPLOY_WORKFLOW_REMOVED =
  '.work/project.json deploy was removed: a workflow is not named in configuration. Bind it to the trigger in its own source instead, trigger("project.deploy"), and keep it turned on as a project automation';

export type ProjectDeploy =
  | { kind: "none" }
  | { kind: "invalid"; error: string };

/**
 * What the project manifest's text says of deploying (null: no manifest):
 * nothing, since a deploy is an event workflows bind, or something that
 * keeps its revision from going live: text that is not JSON, or the
 * `deploy` key that named a workflow.
 */
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
  return "deploy" in manifest && manifest.deploy !== undefined
    ? { kind: "invalid", error: DEPLOY_WORKFLOW_REMOVED }
    : { kind: "none" };
}

const TERMINAL_RUN = ["completed", "failed", "canceled"];

interface PublishedRevisionsDeps {
  db: Kysely<DB>;
  enablements: WorkflowEnablementsService;
  runs: () => Pick<RunsService, "triggerWithEnablementAtRevision" | "cancel">;
  /**
   * The workflows that bind `kind` at a published commit, with config and
   * `where` matching the event as a dispatch matches them (ADR 0355).
   */
  boundWorkflows(args: {
    tenantId: string;
    projectId: string;
    commitSha: string;
    kind: string;
    payload: Json;
  }): Promise<string[]>;
  /**
   * Record a waited event delivered at a published commit by its emitter:
   * the dispatcher leaves it alone, and recording it again changes nothing.
   */
  recordEvent(args: {
    event: PendingProjectEvent;
    atCommit: string;
  }): Promise<void>;
  /** The commit the project's published `main` points to now. */
  publishedHead(args: {
    tenantId: string;
    projectId: string;
  }): Promise<string | null>;
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
  /** A deploy run longer than this fails its revision. Default one hour. */
  deployTimeoutMs?: number;
  /** A deploy run longer than this is reported once. Default 15 minutes. */
  deployNoticeMs?: number;
}

/**
 * Published revisions and how they go live (ADRs 0330, 0331, 0355). Every
 * publication is recorded in order; the dispatch pass advances each
 * project one step at a time under its replica claim: record the
 * revision's deploy event, run the project automations bound to it at the
 * revision and wait for them, then move every following enablement there.
 * A newer revision supersedes one still pending; one deploys or applies at
 * a time per project, on any replica.
 */
export class PublishedRevisionsService {
  constructor(private readonly deps: PublishedRevisionsDeps) {}

  private get db(): Kysely<DB> {
    return this.deps.db;
  }

  /**
   * Record a revision of `main` that a publisher just moved it to. Under
   * the project's lock only the commit main points to now is recorded, so
   * a late or stale caller (a slow publisher, anything that read main
   * before it moved) never makes an older commit the newest revision.
   */
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
      const head = await this.deps.publishedHead({
        tenantId: project.tenant_id,
        projectId: input.projectId,
      });
      if (head !== input.commitSha) return false;
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
    // Ready projects first, oldest first; one waiting to try again last.
    const projects = await this.db
      .selectFrom("published_revisions")
      .select("project_id")
      .where("status", "in", ["pending", "deploying", "applying"])
      .groupBy("project_id")
      .orderBy(sql`max(coalesce(retry_at, '-infinity'::timestamptz))`)
      .orderBy(sql`min(sequence)`)
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

  /**
   * Begin a revision: with nobody listening for its deploy, it goes live at
   * once; otherwise its deploy event is recorded and its listeners' runs
   * start (ADR 0355). Listeners are the project's own automations whose
   * workflow binds the event at this revision: bindings are read here, not
   * where each automation runs now, so a revision decides its own deploy.
   */
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
    const lastLive = await this.db
      .selectFrom("published_revisions")
      .select("commit_sha")
      .where("project_id", "=", row.project_id)
      .where("status", "=", "applied")
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    const eventId = randomUUID();
    const startedAt = new Date();
    const eventOf = (previousCommitSha: string | null) =>
      deployEvent({
        ...row,
        deploy_event_id: eventId,
        deploy_started_at: startedAt,
        previous_commit_sha: previousCommitSha,
      });
    let bound: string[];
    try {
      bound = await this.deps.boundWorkflows({
        tenantId: row.tenant_id,
        projectId: row.project_id,
        commitSha: row.commit_sha,
        kind: PROJECT_DEPLOY_EVENT,
        payload: projectEventInput(eventOf(lastLive?.commit_sha ?? null)),
      });
    } catch (error) {
      // What this revision binds cannot be read: going live without its
      // deploy could skip a migration, so it does not. A failure that may
      // clear is tried again.
      if (!isDeployRefusal(error)) throw error;
      await this.fail(
        row,
        `What listens for this revision's deploy could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
    const automations =
      bound.length === 0
        ? []
        : await this.db
            .selectFrom("workflow_enablements")
            .select(["id", "workflow_name", "commit_sha"])
            .where("project_id", "=", row.project_id)
            .where("workflow_name", "in", bound)
            .where("owner_kind", "=", "project")
            .where("temporary", "=", false)
            .where("status", "!=", "disabled")
            .orderBy("created_at")
            .orderBy("id")
            .execute();
    // Nobody listens: no deploy step.
    if (automations.length === 0) {
      if (!(await this.transition(row, "pending", "applying"))) return false;
      await this.apply(row);
      return true;
    }
    // The last revision that went live; before any did, the commit the
    // listening automations run now, when they agree on one.
    const running = new Set(automations.map((entry) => entry.commit_sha));
    const previousCommitSha =
      lastLive?.commit_sha ??
      (running.size === 1 ? (automations[0]?.commit_sha ?? null) : null);
    const listeners: DeployListener[] = automations.map((entry) => ({
      enablementId: entry.id,
      workflowName: entry.workflow_name,
      runId: null,
    }));
    const claimed = await this.db
      .updateTable("published_revisions")
      .set({
        status: "deploying",
        deploy_event_id: eventId,
        deploy_listeners: toJson(listeners),
        previous_commit_sha: previousCommitSha,
        deploy_started_at: startedAt,
        deploy_noticed: false,
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
    await this.startDeployRuns({
      ...row,
      status: "deploying",
      deploy_event_id: eventId,
      deploy_listeners: toJson(listeners),
      previous_commit_sha: previousCommitSha,
      deploy_started_at: startedAt,
    });
    return true;
  }

  /**
   * Record the revision's deploy event and start, or after a restart find,
   * the run of each listener that has none yet: one run per listener and
   * try, found again by its correlation key even once it settled, stamped
   * with the event, at the revision's commit under the automation's
   * existing authority. A failure that may clear waits and tries again;
   * refused authority (the revision changes what the workflow may use or
   * what starts it) or a deterministic failure fails the revision, and
   * what the other listeners started is canceled.
   */
  private async startDeployRuns(row: Row): Promise<void> {
    const event = row.deploy_event_id ? deployEvent(row) : undefined;
    const listeners = deployListeners(row.deploy_listeners);
    if (!event || listeners.length === 0) {
      await this.fail(row, "The revision's deploy event is gone");
      return;
    }
    await this.deps.recordEvent({ event, atCommit: row.commit_sha });
    const recorded = await this.db
      .selectFrom("project_events")
      .select(["sequence", "received_at"])
      .where("id", "=", event.id)
      .executeTakeFirst();
    const input: Json = {
      id: event.id,
      sequence: Number(recorded?.sequence ?? 0),
      projectId: event.projectId,
      source: event.source,
      kind: event.kind,
      externalId: event.externalId,
      occurredAt: event.occurredAt,
      receivedAt: (recorded?.received_at ?? new Date()).toISOString(),
      payload: event.payload,
    };
    const started: DeployListener[] = [];
    for (const listener of listeners) {
      if (listener.runId) {
        started.push(listener);
        continue;
      }
      const correlationKey = `deploy:${row.id}:${row.deploy_attempt}:${listener.enablementId}`;
      const found = await this.db
        .selectFrom("workflow_runs")
        .select("id")
        .where("project_id", "=", row.project_id)
        .where("workflow_name", "=", listener.workflowName)
        .where("correlation_key", "=", correlationKey)
        .orderBy("created_at")
        .limit(1)
        .executeTakeFirst();
      try {
        const runId =
          found?.id ??
          (
            await this.deps.runs().triggerWithEnablementAtRevision(
              {
                identity: {
                  tenantId: row.tenant_id,
                  externalUserId: FOLLOW_ACTOR,
                },
                enablementId: listener.enablementId,
                projectId: row.project_id,
                workflowName: listener.workflowName,
                commitSha: row.commit_sha,
                input,
                // The host's own key: the run is this try's, whatever the
                // workflow names its runs by.
                correlationKey,
                onConflict: "ignore",
              },
              {
                kind: PROJECT_DEPLOY_EVENT,
                mode: "async",
                event: { id: event.id, waited: true },
              },
            )
          ).id;
        started.push({ ...listener, runId });
        await this.db
          .updateTable("published_revisions")
          .set({
            deploy_listeners: toJson([
              ...started,
              ...listeners.slice(started.length),
            ]),
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .where("status", "=", "deploying")
          .execute();
      } catch (error) {
        if (!isDeployRefusal(error)) {
          await this.deferRow(row);
          return;
        }
        await this.cancelDeployRuns({
          row,
          listeners: started,
          reason: "Another deploy workflow of the revision could not start",
        });
        await this.fail(
          row,
          `The deploy workflow ${listener.workflowName} could not start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
    }
    await this.db
      .updateTable("published_revisions")
      .set({ retry_at: null, updated_at: new Date() })
      .where("id", "=", row.id)
      .where("status", "=", "deploying")
      .execute();
  }

  /**
   * Where a deploying revision's runs stand: every listener's run must
   * end, and all must have completed, before anything moves.
   */
  private async checkDeploy(row: Row): Promise<boolean> {
    const listeners = deployListeners(row.deploy_listeners);
    if (listeners.some((listener) => !listener.runId)) {
      // A deploy that keeps failing to start times out like one that runs.
      const elapsed =
        Date.now() - (row.deploy_started_at?.getTime() ?? Date.now());
      if (elapsed > (this.deps.deployTimeoutMs ?? 60 * 60_000))
        return this.watchDeploy(row);
      await this.startDeployRuns(row);
      return true;
    }
    const runs = await this.deployRuns(listeners);
    if (runs.some((run) => run.status === null)) {
      await this.fail(row, "A deploy run is gone");
      return true;
    }
    if (runs.some((run) => !TERMINAL_RUN.includes(run.status ?? "")))
      return this.watchDeploy(row);
    const failed = runs.filter((run) => run.status !== "completed");
    if (failed.length > 0) {
      await this.fail(
        row,
        `${failed
          .map(
            (run) =>
              `The deploy workflow ${run.workflowName} ${
                run.status === "canceled" ? "was canceled" : "failed"
              }${run.error ? `: ${run.error}` : ""}.`,
          )
          .join(" ")} Nothing moved; the previous revision stays live.`,
      );
      return true;
    }
    if (!(await this.transition(row, "deploying", "applying"))) return false;
    await this.apply(row);
    return true;
  }

  /** Each listener's run as it stands; a null status is a run that is gone. */
  private async deployRuns(listeners: readonly DeployListener[]): Promise<
    Array<{
      workflowName: string;
      runId: string;
      status: string | null;
      error: string | null;
    }>
  > {
    const ids = listeners.flatMap((listener) =>
      listener.runId ? [listener.runId] : [],
    );
    const rows =
      ids.length === 0
        ? []
        : await this.db
            .selectFrom("workflow_runs")
            .select(["id", "status", "error"])
            .where("id", "in", ids)
            .execute();
    return listeners.flatMap((listener) => {
      if (!listener.runId) return [];
      const run = rows.find((row) => row.id === listener.runId);
      return [
        {
          workflowName: listener.workflowName,
          runId: listener.runId,
          status: run?.status ?? null,
          error: run?.error ?? null,
        },
      ];
    });
  }

  /** Cancel the runs of a deploy that will not go live. */
  private async cancelDeployRuns(input: {
    row: Row;
    listeners: readonly DeployListener[];
    reason: string;
  }): Promise<void> {
    for (const run of await this.deployRuns(input.listeners)) {
      if (run.status === null || TERMINAL_RUN.includes(run.status)) continue;
      await this.deps
        .runs()
        .cancel({
          identity: {
            tenantId: input.row.tenant_id,
            externalUserId: FOLLOW_ACTOR,
          },
          runId: run.runId,
          reason: input.reason,
        })
        .catch((error: unknown) =>
          console.warn("[catamorphic] Could not cancel a deploy run", error),
        );
    }
  }

  /**
   * A deploy still running: tell the people who manage automations once it
   * runs long, and after its timeout cancel its runs and fail the revision,
   * so a paused deploy never holds the project's revisions forever.
   */
  private async watchDeploy(row: Row): Promise<boolean> {
    const started = row.deploy_started_at?.getTime() ?? Date.now();
    const elapsed = Date.now() - started;
    const timeout = this.deps.deployTimeoutMs ?? 60 * 60_000;
    const listeners = deployListeners(row.deploy_listeners);
    const named = deployWorkflowsText(listeners);
    if (elapsed > timeout) {
      await this.cancelDeployRuns({
        row,
        listeners,
        reason: "The deploy ran past its timeout",
      });
      await this.fail(
        row,
        `${named.subject} ran longer than ${Math.round(
          timeout / 60_000,
        )} minutes and ${named.plural ? "were" : "was"} canceled. Nothing moved; the previous revision stays live.`,
      );
      return true;
    }
    if (
      row.deploy_noticed ||
      elapsed <= (this.deps.deployNoticeMs ?? 15 * 60_000)
    )
      return false;
    const noticed = await this.db
      .updateTable("published_revisions")
      .set({ deploy_noticed: true, updated_at: new Date() })
      .where("id", "=", row.id)
      .where("deploy_noticed", "=", false)
      .executeTakeFirst();
    if (noticed.numUpdatedRows !== 1n) return false;
    await this.publish({
      row,
      recipients: await this.deps.automationManagers({
        tenantId: row.tenant_id,
        projectId: row.project_id,
      }),
      kind: "deploy_running_long",
      title: `Revision ${row.commit_sha.slice(0, 7)} is still deploying`,
      body: `${named.subject} ${named.plural ? "have" : "has"} run for ${Math.round(
        elapsed / 60_000,
      )} minutes; followers move once ${named.plural ? "they finish" : "it finishes"}.`,
      collapseKey: `deploy_running_long:${row.id}:${row.deploy_attempt}`,
    }).catch((error: unknown) =>
      console.warn("[catamorphic] Could not report a long deploy", error),
    );
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

  /** Hold one revision back after a failure that may clear. */
  private async deferRow(row: Pick<Row, "id" | "attempts">): Promise<void> {
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
   * deploy event is recorded again at that revision and, if every run it
   * starts succeeds, the following enablements move. Needs
   * `automations:write`.
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
   * A project automation that listened for the latest revision's deploy
   * was consented to again: that revision, if it failed, is tried once
   * more by itself.
   */
  async retryAfterConsent(input: {
    projectId: string;
    workflowName: string;
    ownerKind: "member" | "project";
  }): Promise<void> {
    if (input.ownerKind !== "project") return;
    const latest = await this.db
      .selectFrom("published_revisions")
      .select(["id", "status", "deploy_listeners", "auto_retried"])
      .where("project_id", "=", input.projectId)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirst();
    if (
      latest?.status !== "failed" ||
      latest.auto_retried ||
      !deployListeners(latest.deploy_listeners).some(
        (listener) => listener.workflowName === input.workflowName,
      )
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
        deploy_event_id: null,
        deploy_listeners: toJson([]),
        settled_at: null,
        attempts: 0,
        retry_at: null,
        deploy_started_at: null,
        deploy_noticed: false,
        deploy_attempt: sql<number>`deploy_attempt + 1`,
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

  private async fail(row: Row, error: string): Promise<void> {
    const result = await this.db
      .updateTable("published_revisions")
      .set({
        status: "failed",
        error,
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

/**
 * A deploy that cannot start because its automation was refused or the
 * workflow does not build there fails its revision; anything else (machines
 * full, a run limit, the database or network) may clear.
 */
function isDeployRefusal(error: unknown): boolean {
  if (error instanceof WorkflowRevisionUnavailableError)
    return error.kind !== "retry";
  return [
    AccessDeniedError,
    WorkflowEnablementSuspendedError,
    WorkflowNotFoundError,
    WorkflowSourceInvalidError,
    RunInputInvalidError,
  ].some((type) => error instanceof type);
}

/** 15 seconds after the first failure, doubling, at most 15 minutes. */
function retryBackoffMs(attempts: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

/** The listeners a revision's row holds; none for anything else. */
function deployListeners(value: Json): DeployListener[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DeployListener[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return [];
    const { enablementId, workflowName, runId } = entry;
    return typeof enablementId === "string" && typeof workflowName === "string"
      ? [
          {
            enablementId,
            workflowName,
            runId: typeof runId === "string" ? runId : null,
          },
        ]
      : [];
  });
}

/** "The deploy workflow a", or "The deploy workflows a and b". */
function deployWorkflowsText(listeners: readonly DeployListener[]): {
  subject: string;
  plural: boolean;
} {
  const names = [...new Set(listeners.map((entry) => entry.workflowName))];
  const last = names.at(-1) ?? "";
  return names.length > 1
    ? {
        subject: `The deploy workflows ${names.slice(0, -1).join(", ")} and ${last}`,
        plural: true,
      }
    : { subject: `The deploy workflow ${last}`, plural: false };
}

/**
 * A deploying revision's event (ADR 0355), the same on every pass: its id
 * is the row's, and it is recorded once per try. `detail` says the commit
 * about to go live and the one live before it.
 */
function deployEvent(
  row: Pick<
    Row,
    | "id"
    | "project_id"
    | "commit_sha"
    | "previous_commit_sha"
    | "deploy_attempt"
    | "deploy_event_id"
    | "deploy_started_at"
    | "created_at"
  >,
): PendingProjectEvent {
  return {
    id: row.deploy_event_id ?? "",
    projectId: row.project_id,
    source: PROJECT_EVENT_SOURCE,
    kind: PROJECT_DEPLOY_EVENT,
    externalId: `deploy:${row.id}:${row.deploy_attempt}`,
    occurredAt: (row.deploy_started_at ?? row.created_at).toISOString(),
    payload: {
      actor: { kind: "system", code: PROJECT_DEPLOY_EVENT },
      causation: [],
      detail: {
        commit: row.commit_sha,
        previousCommit: row.previous_commit_sha,
      },
    },
  };
}

function mapRevision(row: Row): PublishedRevision {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    projectId: row.project_id,
    commitSha: row.commit_sha,
    status: row.status as PublishedRevisionStatus,
    deployEventId: row.deploy_event_id,
    deployRuns: deployListeners(row.deploy_listeners).map((listener) => ({
      workflowName: listener.workflowName,
      runId: listener.runId,
    })),
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
