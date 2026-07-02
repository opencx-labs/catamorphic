import type { DB, JsonObject } from "@catamorphic/db";
import type { CloneSource, ProjectManager } from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import { PlaygroundExecutor } from "./playground-executor.js";
import { ProjectNotFoundError } from "./projects-service.js";
import type { RunPluginsLoader } from "./run-plugins-loader.js";
import { WorkflowNotFoundError } from "./workflows-service.js";

type RunRow = Selectable<DB["workflow_runs"]>;
type StepRow = Selectable<DB["workflow_run_steps"]>;

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface Run {
  id: string;
  projectId: string;
  workflowName: string;
  commitSha: string;
  isTest: boolean;
  status: RunStatus;
  triggerData: unknown;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RunStep {
  id: string;
  runId: string;
  nodeId: string;
  name: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDetail extends Run {
  steps: RunStep[];
}

export interface ListRunsInput {
  workflowName?: string;
  limit?: number;
  offset?: number;
}

export interface ListRunsResult {
  items: Run[];
  total: number;
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run '${runId}' not found`);
    this.name = "RunNotFoundError";
  }
}

export class PluginSecretsMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Missing required plugin secrets: ${missing.join(
        ", ",
      )}. Set them in the project settings before running.`,
    );
    this.name = "PluginSecretsMissingError";
  }
}

const tracer = getTracer("@catamorphic/core");

export class SandboxProviderNotConfiguredError extends Error {
  constructor() {
    super("Sandbox provider not configured");
    this.name = "SandboxProviderNotConfiguredError";
  }
}

export interface TriggerRunInput {
  triggerData?: Record<string, unknown>;
}

interface RunsServiceDeps {
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  runPluginsLoader?: RunPluginsLoader;
}

/**
 * Reads `workflow_runs` + `workflow_run_steps` and triggers new runs against
 * the project's HEAD commit. Execution is delegated to `PlaygroundExecutor`
 * which owns the sandbox lifecycle.
 */
export class RunsService {
  private readonly projectManager: ProjectManager;
  private readonly sandboxProvider?: SandboxProvider;
  private readonly runPluginsLoader?: RunPluginsLoader;

  constructor(
    private readonly db: Kysely<DB>,
    deps: RunsServiceDeps,
  ) {
    this.projectManager = deps.projectManager;
    this.sandboxProvider = deps.sandboxProvider;
    this.runPluginsLoader = deps.runPluginsLoader;
  }

  async get(identity: Identity, runId: string): Promise<RunDetail> {
    const run = await this.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("workflow_runs.id", "=", runId)
      .where("projects.tenant_id", "=", identity.tenantId)
      .selectAll("workflow_runs")
      .executeTakeFirst();

    if (!run) throw new RunNotFoundError(runId);

    const steps = await this.db
      .selectFrom("workflow_run_steps")
      .where("run_id", "=", runId)
      .selectAll()
      .orderBy("started_at", "asc")
      .execute();

    return { ...mapRun(run), steps: steps.map(mapStep) };
  }

  async list(
    identity: Identity,
    projectId: string,
    input: ListRunsInput = {},
  ): Promise<ListRunsResult> {
    await this.requireProject(identity, projectId);

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    let query = this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", projectId);

    if (input.workflowName) {
      query = query.where("workflow_name", "=", input.workflowName);
    }

    const rows = await query
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    let countQuery = this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", projectId);
    if (input.workflowName) {
      countQuery = countQuery.where("workflow_name", "=", input.workflowName);
    }
    const total = await countQuery
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.count));

    return { items: rows.map(mapRun), total };
  }

  /**
   * Trigger a workflow run against the project's HEAD commit. Opens the
   * project's dev working copy, reads all files, resolves HEAD, loads
   * attached plugins + secrets, then hands off to `PlaygroundExecutor` which
   * spawns a sandbox and executes the harness. Persists the run + its
   * steps to `workflow_runs` / `workflow_run_steps` as the execution
   * progresses.
   */
  async trigger(
    identity: Identity,
    projectId: string,
    workflowName: string,
    input: TriggerRunInput,
  ): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.run",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.workflow.name": workflowName,
          "catamorphic.tenant.id": identity.tenantId,
        },
      },
      (span) =>
        this.triggerInner(identity, projectId, workflowName, input, (runId) =>
          span.setAttribute("catamorphic.run.id", runId),
        ),
    );
  }

  private async triggerInner(
    identity: Identity,
    projectId: string,
    workflowName: string,
    input: TriggerRunInput,
    onRunId: (runId: string) => void,
  ): Promise<Run> {
    if (!this.sandboxProvider) {
      throw new SandboxProviderNotConfiguredError();
    }

    await this.requireProject(identity, projectId);

    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    let files: Record<string, string>;
    let commitSha: string;
    let cloneSource: CloneSource | undefined;
    try {
      files = await repo.readAllFiles();
      commitSha = await repo.resolveRef("HEAD");

      // Prefer having the sandbox clone from the origin (e.g. Cloudflare
      // Artifacts) instead of uploading files — but only when the origin is
      // known to contain the commit being executed (dev HEAD == origin/main).
      const remoteBackend = this.projectManager.remoteBackend;
      if (remoteBackend?.getCloneSource) {
        const remoteSha = await repo
          .resolveRef("refs/remotes/origin/main")
          .catch(() => null);
        if (remoteSha === commitSha) {
          cloneSource = await remoteBackend.getCloneSource(
            identity.tenantId,
            projectId,
            { scope: "read" },
          );
        }
      }
    } finally {
      await repo.dispose();
    }

    if (!(workflowName in files) && !findWorkflowInFiles(files, workflowName)) {
      throw new WorkflowNotFoundError(projectId, workflowName);
    }

    let plugins: Awaited<ReturnType<RunPluginsLoader["load"]>> | undefined;
    if (this.runPluginsLoader) {
      plugins = await this.runPluginsLoader.load(projectId);
      if (plugins.missingRequiredSecrets.length > 0) {
        throw new PluginSecretsMissingError(plugins.missingRequiredSecrets);
      }
    }

    const triggerData = input.triggerData ?? {};
    const runId = crypto.randomUUID();
    onRunId(runId);
    const startedAt = new Date();

    await this.db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: workflowName,
        commit_sha: commitSha,
        is_test: false,
        status: "running",
        trigger_data: triggerData as JsonObject,
        started_at: startedAt,
      })
      .execute();

    const executor = new PlaygroundExecutor(this.sandboxProvider);
    const result = await executor.execute({
      files,
      workflowName,
      triggerData,
      commitSha,
      cloneSource,
      plugins: plugins?.plugins,
      secrets: plugins?.secrets,
    });

    const completedAt = new Date(result.completedAt);
    await this.db
      .updateTable("workflow_runs")
      .set({
        status: result.status,
        result: (result.result ?? null) as JsonObject | null,
        error: result.error ?? null,
        completed_at: completedAt,
      })
      .where("id", "=", runId)
      .execute();

    if (result.steps.length > 0) {
      await this.db
        .insertInto("workflow_run_steps")
        .values(
          result.steps.map((step) => ({
            id: crypto.randomUUID(),
            run_id: runId,
            node_id: step.nodeId,
            name: step.name,
            status: step.status,
            input: (step.input ?? null) as JsonObject | null,
            output: (step.output ?? null) as JsonObject | null,
            error: step.error ?? null,
            started_at: new Date(step.startedAt),
            completed_at: new Date(step.completedAt),
          })),
        )
        .execute();
    }

    const row = await this.db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .selectAll()
      .executeTakeFirstOrThrow();
    return mapRun(row);
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }
}

/**
 * Cheap pre-flight check so we fail fast with `WorkflowNotFoundError` before
 * spawning a sandbox. The harness does its own discovery, but a
 * missing workflow would otherwise surface as a `status: 'failed'` run with a
 * generic error string.
 */
function findWorkflowInFiles(
  files: Record<string, string>,
  workflowName: string,
): boolean {
  const needle = `function ${workflowName}`;
  const marker = '"use workflow"';
  for (const [path, source] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".js")) continue;
    if (source.includes(needle) && source.includes(marker)) return true;
  }
  return false;
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowName: row.workflow_name,
    commitSha: row.commit_sha,
    isTest: row.is_test,
    status: row.status as RunStatus,
    triggerData: row.trigger_data,
    result: row.result,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapStep(row: StepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    name: row.name,
    status: row.status as StepStatus,
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}
