import { randomUUID } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { type ProjectManager, push } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { parseProject } from "@catamorphic/parser";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "./agent-sessions-service.js";
import type { GithubService } from "./github-service.js";
import type { ProjectEventMonitorsService } from "./project-event-monitors-service.js";
import type { ProjectEventsService } from "./project-events-service.js";
import type { RunsService } from "./runs-service.js";
import type { TriggersService } from "./triggers-service.js";

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
  projectManager: ProjectManager;
  runs: RunsService;
  triggers: TriggersService;
  events: ProjectEventsService;
  monitors: ProjectEventMonitorsService;
  sessions: AgentSessionsService;
  github?: GithubService;
}

const WATCHER_AUTHOR = {
  name: "Catamorphic Watcher",
  email: "watcher@catamorphic.dev",
};
const tracer = getTracer("@catamorphic/core");

export class WatchersService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: WatchersDeps,
  ) {}

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
    const watcherId = randomUUID();
    const sourcePath = `workflows/src/watchers/${watcherId}.ts`;
    const remoteBranch = `catamorphic/watchers/${watcherId}`;
    const repo = await this.deps.projectManager.openDev(
      input.identity.tenantId,
      input.projectId,
      `watcher-${watcherId}`,
    );
    let commitSha: string;
    try {
      await repo.writeFile(sourcePath, input.source);
      const parsed = parseProject(await repo.readAllFiles());
      const parseErrors = parsed.errors.map((error) =>
        error.file ? `${error.file}: ${error.message}` : error.message,
      );
      if (
        !parsed.workflows.some(
          (workflow) => workflow.functionName === input.workflowName,
        )
      ) {
        parseErrors.push(`Workflow '${input.workflowName}' is not exported`);
      }
      if (parseErrors.length > 0) {
        throw new Error(`Invalid watcher workflow:\n${parseErrors.join("\n")}`);
      }
      commitSha = await repo.commit(
        `Create watcher ${watcherId}`,
        WATCHER_AUTHOR,
        {
          paths: [sourcePath],
        },
      );
      const remote = this.deps.projectManager.remoteBackend;
      if (!remote) throw new Error("Watchers require durable project storage");
      await push({
        dev: repo,
        remote,
        tenantId: input.identity.tenantId,
        projectId: input.projectId,
        remoteBranch,
        localSha: commitSha,
      });
    } finally {
      await repo.dispose();
    }

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
    const triggerKinds = [...new Set(bindings.map((binding) => binding.kind))];
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
        environment_name: input.environment ?? null,
        cursor_sequence: String(input.cursorSequence),
        expires_at: new Date(Date.now() + expiresInSeconds * 1_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapWatcher(row, triggerKinds);
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
        const bindings = await this.deps.triggers.listAtCommit({
          identity: input.identity,
          projectId: input.projectId,
          workflowName: row.workflow_name,
          commitSha: row.commit_sha,
          remoteBranch: row.remote_branch,
        });
        return mapWatcher(row, [
          ...new Set(bindings.map((binding) => binding.kind)),
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
    const result = await this.db
      .updateTable("watchers")
      .set({ status: "stopped", updated_at: new Date() })
      .where("id", "=", input.watcherId)
      .where("project_id", "=", input.projectId)
      .where("session_id", "=", input.sessionId)
      .where("status", "in", ["active", "paused"])
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async dispatchPending(input: { limit?: number } = {}): Promise<number> {
    return withSpan({ tracer, name: "watcher.dispatch" }, () =>
      this.dispatchPendingInner(input),
    );
  }

  private async dispatchPendingInner(
    input: { limit?: number } = {},
  ): Promise<number> {
    const rows = await this.db
      .selectFrom("watchers")
      .innerJoin("projects", "projects.id", "watchers.project_id")
      .selectAll("watchers")
      .select("projects.tenant_id")
      .where("watchers.status", "=", "active")
      .orderBy("watchers.created_at")
      .limit(input.limit ?? 50)
      .execute();
    let dispatched = 0;
    for (const row of rows) {
      if (row.expires_at && row.expires_at <= new Date()) {
        await this.db
          .updateTable("watchers")
          .set({ status: "expired", updated_at: new Date() })
          .where("id", "=", row.id)
          .execute();
        continue;
      }
      const identity = persistedIdentity(
        row.owner_identity,
        row.tenant_id,
        row.owner_external_user_id,
      );
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
        kinds,
        limit: 100,
      });
      for (const event of events) {
        try {
          const result = await this.deps.triggers.fireAtCommit({
            identity,
            projectId: row.project_id,
            commitSha: row.commit_sha,
            remoteBranch: row.remote_branch,
            environment: row.environment_name ?? undefined,
            kind: event.kind,
            payload: JSON.parse(JSON.stringify(event)),
            workflows: [row.workflow_name],
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
}): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    await input.watchers.dispatchPending().catch(() => {});
    timer = setTimeout(() => void tick(), input.pollEveryMs ?? 1_000);
    timer.unref?.();
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
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
