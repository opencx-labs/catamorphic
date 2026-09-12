import type { DB, Json } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";

import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "./agent-sessions-service.js";
import type { GithubService } from "./github-service.js";
import type { ProjectEventMonitorsService } from "./project-event-monitors-service.js";
import type { ProjectEventsService } from "./project-events-service.js";
import type { RunsService } from "./runs-service.js";
import { SessionArtifactsService } from "./session-artifacts-service.js";
import type { TriggersService } from "./triggers-service.js";
import type { WorkflowEnablementsService } from "./workflow-enablements-service.js";

type WatcherRow = Selectable<DB["watchers"]>;

export interface Watcher {
  id: string;
  projectId: string;
  sessionId: string;
  monitorId: string | null;
  workflowName: string;
  sourcePath: string;
  remoteBranch: string;
  commitSha: string;
  deploymentArtifactId: string;
  environment: string | null;
  triggerKinds: string[];
  cursorSequence: number;
  status: "active" | "paused" | "stopped" | "expired";
  expiresAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface WatchersDeps {
  artifacts?: SessionArtifactsService;
  projectManager: ProjectManager;
  runs: RunsService;
  triggers: TriggersService;
  workflowEnablements: WorkflowEnablementsService;
  events: ProjectEventsService;
  monitors: ProjectEventMonitorsService;
  sessions: AgentSessionsService;
  github?: GithubService;
}

const tracer = getTracer("@catamorphic/core");

export class WatchersService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: WatchersDeps,
  ) {
    this.artifacts =
      deps.artifacts ?? new SessionArtifactsService(db, deps.projectManager);
  }
  private readonly artifacts: SessionArtifactsService;

  async create(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    workflowName: string;
    source: string;
    environment?: string;
    expiresInSeconds?: number;
  }): Promise<Watcher> {
    await this.deps.sessions.assertSession(
      input.identity,
      input.projectId,
      input.sessionId,
    );
    return this.createPinned({
      ...input,
      monitorId: null,
      cursorSequence: await this.latestProjectSequence(input.projectId),
    });
  }

  async createGithub(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    workflowName: string;
    source: string;
    environment?: string;
    placement?: "local" | "remote" | "any";
    expiresInSeconds?: number;
    pollIntervalSeconds?: number;
  }): Promise<Watcher> {
    await this.deps.sessions.assertSession(
      input.identity,
      input.projectId,
      input.sessionId,
    );
    if (!this.deps.github) throw new Error("GitHub is not configured");

    // Verify the caller's current GitHub credential can read the linked repo,
    // seed the provider cursor, and make pre-existing activity invisible to
    // this new watcher. A watcher observes changes after creation by default.
    const initial = await this.deps.github.pollProjectEvents(
      input.identity,
      input.projectId,
    );
    const monitor = await this.deps.monitors.ensure({
      identity: input.identity,
      projectId: input.projectId,
      sourceKind: "github",
      sourceKey: input.projectId,
      placement: input.placement ?? "local",
      config: {},
      cursor: initial.nextCursor
        ? { externalId: initial.nextCursor }
        : undefined,
      pollIntervalSeconds: input.pollIntervalSeconds ?? 30,
    });
    return this.createPinned({
      identity: input.identity,
      projectId: input.projectId,
      sessionId: input.sessionId,
      workflowName: input.workflowName,
      source: input.source,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.expiresInSeconds !== undefined
        ? { expiresInSeconds: input.expiresInSeconds }
        : {}),
      monitorId: monitor.id,
      cursorSequence: await this.latestProjectSequence(input.projectId),
      requiredTriggerPrefix: "github.",
    });
  }

  private async createPinned(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    workflowName: string;
    source: string;
    environment?: string;
    expiresInSeconds?: number;
    monitorId: string | null;
    cursorSequence: number;
    requiredTriggerPrefix?: string;
  }): Promise<Watcher> {
    return withSpan(
      {
        tracer,
        name: "watcher.create",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.agent.session.id": input.sessionId,
          "catamorphic.workflow.name": input.workflowName,
        },
      },
      () => this.createPinnedInner(input),
    );
  }

  private async createPinnedInner(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    workflowName: string;
    source: string;
    environment?: string;
    expiresInSeconds?: number;
    monitorId: string | null;
    cursorSequence: number;
    requiredTriggerPrefix?: string;
  }): Promise<Watcher> {
    const session = await this.db
      .selectFrom("agent_sessions")
      .select("status")
      .where("id", "=", input.sessionId)
      .where("project_id", "=", input.projectId)
      .executeTakeFirstOrThrow();
    if (session.status !== "active")
      throw new Error("Cannot create a watcher for a closed session");
    const source = await this.artifacts.create({
      identity: input.identity,
      projectId: input.projectId,
      sessionId: input.sessionId,
      kind: "workflow",
      name: input.workflowName,
      source: input.source,
    });
    const watcherId = source.id;
    const sourcePath = source.sourcePath;
    const remoteBranch = source.remoteBranch;
    const commitSha = source.commitSha;
    let enablementId: string | undefined;
    try {
      const bindings = await this.deps.triggers.listAtCommit({
        identity: input.identity,
        projectId: input.projectId,
        workflowName: input.workflowName,
        commitSha,
        remoteBranch,
        environment: input.environment,
      });
      if (bindings.length === 0) {
        throw new Error(
          `Watcher workflow '${input.workflowName}' must declare at least one trigger`,
        );
      }
      const requiredTriggerPrefix = input.requiredTriggerPrefix;
      if (
        requiredTriggerPrefix &&
        !bindings.some((binding) =>
          binding.kind.startsWith(requiredTriggerPrefix),
        )
      ) {
        throw new Error(
          `Watcher workflow '${input.workflowName}' must declare at least one ${requiredTriggerPrefix} trigger`,
        );
      }
      const triggerKinds = [
        ...new Set(bindings.map((binding) => binding.kind)),
      ];
      const artifact = await this.deps.runs.resolveArtifactAtCommit({
        identity: input.identity,
        projectId: input.projectId,
        workflowName: input.workflowName,
        commitSha,
        remoteBranch,
      });
      const expiresInSeconds = Math.min(
        Math.max(input.expiresInSeconds ?? 86_400, 60),
        30 * 86_400,
      );
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1_000);
      const preview = await this.deps.workflowEnablements.preview({
        identity: input.identity,
        projectId: input.projectId,
        workflowName: input.workflowName,
        commitSha,
        remoteBranch,
        environment: input.environment,
      });
      const enablement = await this.deps.workflowEnablements.create({
        identity: input.identity,
        projectId: input.projectId,
        workflowName: input.workflowName,
        commitSha,
        remoteBranch,
        environment: input.environment,
        consentDigest: preview.consentDigest,
        temporary: true,
        expiresAt,
      });
      enablementId = enablement.id;
      const row = await this.db
        .insertInto("watchers")
        .values({
          id: watcherId,
          project_id: input.projectId,
          session_id: input.sessionId,
          monitor_id: input.monitorId,
          owner_external_user_id: input.identity.externalUserId,
          owner_identity: JSON.parse(JSON.stringify(input.identity)),
          workflow_name: input.workflowName,
          source_path: sourcePath,
          remote_branch: remoteBranch,
          commit_sha: commitSha,
          deployment_artifact_id: artifact.id,
          workflow_enablement_id: enablement.id,
          environment_name: enablement.environment,
          cursor_sequence: String(input.cursorSequence),
          expires_at: expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapWatcher(row, triggerKinds);
    } catch (error) {
      if (enablementId)
        await this.deps.workflowEnablements.disable({
          identity: input.identity,
          enablementId,
        });
      await this.artifacts.discard({
        identity: input.identity,
        projectId: input.projectId,
        artifactId: watcherId,
      });
      throw error;
    }
  }

  async list(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
  }): Promise<Watcher[]> {
    await this.deps.sessions.assertSession(
      input.identity,
      input.projectId,
      input.sessionId,
    );
    const rows = await this.db
      .selectFrom("watchers")
      .selectAll()
      .where("project_id", "=", input.projectId)
      .where("session_id", "=", input.sessionId)
      .orderBy("created_at", "desc")
      .execute();
    return Promise.all(
      rows.map(async (row) => {
        const bindings = await this.db
          .selectFrom("trigger_definitions")
          .select("trigger_kind")
          .where("project_id", "=", row.project_id)
          .where("commit_sha", "=", row.commit_sha)
          .where("workflow_name", "=", row.workflow_name)
          .execute();
        return mapWatcher(row, [
          ...new Set(bindings.map((binding) => binding.trigger_kind)),
        ]);
      }),
    );
  }

  async stop(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    watcherId: string;
  }): Promise<boolean> {
    await this.deps.sessions.assertSession(
      input.identity,
      input.projectId,
      input.sessionId,
    );
    const watcher = await this.db
      .selectFrom("watchers")
      .selectAll()
      .where("id", "=", input.watcherId)
      .where("project_id", "=", input.projectId)
      .where("session_id", "=", input.sessionId)
      .executeTakeFirst();
    if (!watcher) return false;
    if (watcher.workflow_enablement_id) {
      await this.deps.workflowEnablements.disable({
        identity: input.identity,
        enablementId: watcher.workflow_enablement_id,
      });
    }
    const result = await this.db
      .updateTable("watchers")
      .set({ status: "stopped", updated_at: new Date() })
      .where("id", "=", input.watcherId)
      .where("project_id", "=", input.projectId)
      .where("session_id", "=", input.sessionId)
      .where("status", "in", ["active", "paused"])
      .executeTakeFirst();
    await this.cleanupRetired();
    return result.numUpdatedRows === 1n;
  }

  /** Source retirement belongs to the shared session artifact lifecycle. */
  private async cleanupRetired(): Promise<void> {
    const discarded = await this.db
      .selectFrom("watchers")
      .innerJoin("session_artifacts", "session_artifacts.id", "watchers.id")
      .innerJoin("projects", "projects.id", "watchers.project_id")
      .where("session_artifacts.status", "=", "discarded")
      .where("watchers.status", "in", ["active", "paused"])
      .select([
        "watchers.id",
        "watchers.workflow_enablement_id",
        "watchers.owner_identity",
        "watchers.owner_external_user_id",
        "projects.tenant_id",
      ])
      .execute();
    for (const row of discarded) {
      if (row.workflow_enablement_id)
        await this.deps.workflowEnablements.disable({
          identity: persistedIdentity(
            row.owner_identity,
            row.tenant_id,
            row.owner_external_user_id,
          ),
          enablementId: row.workflow_enablement_id,
        });
      await this.db
        .updateTable("watchers")
        .set({ status: "stopped", updated_at: new Date() })
        .where("id", "=", row.id)
        .execute();
    }
    await this.artifacts.cleanup();
  }

  /** Stop every Watcher owned by a session tree before it is archived. */
  async stopForSessions(input: {
    identity: Identity;
    projectId: string;
    sessionIds: readonly string[];
  }): Promise<void> {
    if (input.sessionIds.length === 0) return;
    const rows = await this.db
      .selectFrom("watchers")
      .select(["id", "session_id"])
      .where("project_id", "=", input.projectId)
      .where("session_id", "in", [...input.sessionIds])
      .where("status", "in", ["active", "paused"])
      .execute();
    for (const row of rows) {
      await this.stop({
        identity: input.identity,
        projectId: input.projectId,
        sessionId: row.session_id,
        watcherId: row.id,
      });
    }
  }

  async dispatchPending(input: { limit?: number } = {}): Promise<number> {
    return withSpan({ tracer, name: "watcher.dispatch" }, () =>
      this.dispatchPendingInner(input),
    );
  }

  private async dispatchPendingInner(
    input: { limit?: number } = {},
  ): Promise<number> {
    await this.cleanupRetired();
    const rows = await this.db
      .selectFrom("watchers")
      .innerJoin("projects", "projects.id", "watchers.project_id")
      .selectAll("watchers")
      .select("projects.tenant_id")
      .where("watchers.status", "in", ["active", "paused"])
      .where(({ or, and, eb, exists, selectFrom }) =>
        or([
          eb("watchers.expires_at", "<=", new Date()),
          and([
            eb("watchers.status", "=", "active"),
            exists(
              selectFrom("project_events as event")
                .select("event.id")
                .whereRef("event.project_id", "=", "watchers.project_id")
                .whereRef("event.sequence", ">", "watchers.cursor_sequence"),
            ),
          ]),
        ]),
      )
      .orderBy("watchers.updated_at")
      .limit(input.limit ?? 50)
      .execute();
    let dispatched = 0;
    for (const row of rows) {
      try {
        const identity = persistedIdentity(
          row.owner_identity,
          row.tenant_id,
          row.owner_external_user_id,
        );
        if (row.expires_at && row.expires_at <= new Date()) {
          if (row.workflow_enablement_id) {
            await this.deps.workflowEnablements.disable({
              identity,
              enablementId: row.workflow_enablement_id,
            });
          }
          await this.db
            .updateTable("watchers")
            .set({ status: "expired", updated_at: new Date() })
            .where("id", "=", row.id)
            .execute();
          continue;
        }
        const bindings = await this.deps.triggers.listAtCommit({
          identity,
          projectId: row.project_id,
          workflowName: row.workflow_name,
          commitSha: row.commit_sha,
          remoteBranch: row.remote_branch,
        });
        const kinds = [...new Set(bindings.map((binding) => binding.kind))];
        const events = await this.deps.events.list({
          projectId: row.project_id,
          afterSequence: Number(row.cursor_sequence),
          limit: 100,
        });
        for (const event of events) {
          try {
            // Advance past irrelevant events too, so idle watchers never rescan
            // the same history and cannot starve later watchers in the page.
            if (!kinds.includes(event.kind)) {
              await this.advance(row.id, event.sequence, null);
              continue;
            }
            const result = await this.deps.triggers.fireAtCommit({
              identity,
              projectId: row.project_id,
              commitSha: row.commit_sha,
              remoteBranch: row.remote_branch,
              environment: row.environment_name ?? undefined,
              kind: event.kind,
              payload: JSON.parse(JSON.stringify(event)),
              workflows: [row.workflow_name],
              enablementIds: row.workflow_enablement_id
                ? [row.workflow_enablement_id]
                : [],
              mode: "async",
              correlationKey: `watcher:${row.id}:event:${event.id}`,
              onConflict: "ignore",
            });
            if (result.runs.length > 1) {
              throw new Error(
                "A Watcher event matched more than one workflow run",
              );
            }
            const run = result.runs[0];
            if (run) {
              await this.db
                .insertInto("watcher_runs")
                .values({
                  watcher_id: row.id,
                  event_id: event.id,
                  run_id: run.runId,
                })
                .onConflict((conflict) =>
                  conflict.columns(["watcher_id", "event_id"]).doNothing(),
                )
                .execute();
            }
            await this.advance(row.id, event.sequence, null);
            dispatched += result.runs.length;
          } catch (error) {
            await this.recordFailure(
              row.id,
              error instanceof Error ? error.message : String(error),
            );
            break;
          }
        }
      } catch (error) {
        await this.recordFailure(
          row.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return dispatched;
  }

  private async latestProjectSequence(projectId: string): Promise<number> {
    const row = await this.db
      .selectFrom("project_events")
      .select("sequence")
      .where("project_id", "=", projectId)
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    return Number(row?.sequence ?? 0);
  }

  private async advance(
    watcherId: string,
    sequence: number,
    error: string | null,
  ): Promise<void> {
    await this.db
      .updateTable("watchers")
      .set(({ ref }) => ({
        cursor_sequence: sql`greatest(${ref("cursor_sequence")}, ${String(sequence)})`,
        last_error: error,
        updated_at: new Date(),
      }))
      .where("id", "=", watcherId)
      .execute();
  }

  private async recordFailure(watcherId: string, error: string): Promise<void> {
    await this.db
      .updateTable("watchers")
      .set({ last_error: error, updated_at: new Date() })
      .where("id", "=", watcherId)
      .execute();
  }
}

export function startWatcherDispatcher(input: {
  watchers: WatchersService;
  pollEveryMs?: number;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    await input.watchers.dispatchPending().catch((error) => {
      console.warn("[catamorphic] Watcher dispatch failed", error);
    });
    if (stopped) return;
    timer = setTimeout(() => {
      pending = tick();
    }, input.pollEveryMs ?? 1_000);
    timer.unref?.();
  };
  let pending = tick();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}

function watcherStatus(value: string): Watcher["status"] {
  if (
    value !== "active" &&
    value !== "paused" &&
    value !== "stopped" &&
    value !== "expired"
  ) {
    throw new Error(`Invalid watcher status '${value}'`);
  }
  return value;
}

function mapWatcher(row: WatcherRow, triggerKinds: string[]): Watcher {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    monitorId: row.monitor_id,
    workflowName: row.workflow_name,
    sourcePath: row.source_path,
    remoteBranch: row.remote_branch,
    commitSha: row.commit_sha,
    deploymentArtifactId: row.deployment_artifact_id,
    environment: row.environment_name,
    triggerKinds,
    cursorSequence: Number(row.cursor_sequence),
    status: watcherStatus(row.status),
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}

function persistedIdentity(
  value: Json,
  tenantId: string,
  externalUserId: string,
): Identity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Watcher owner identity is invalid");
  }
  const identity = value as Record<string, unknown>;
  if (
    identity.tenantId !== tenantId ||
    identity.externalUserId !== externalUserId
  ) {
    throw new Error("Watcher owner identity is invalid");
  }
  return value as unknown as Identity;
}
