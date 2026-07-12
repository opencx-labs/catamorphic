import type { DB, Json } from "@catamorphic/db";
import {
  type CloneSource,
  fetchRemote,
  type ProjectManager,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { prepareWorkflowExecution } from "@catamorphic/parser";
import {
  RunExecutorImpl,
  type RunResult,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import { uploadWorkspace } from "./playground/workspace-upload.js";
import { ProjectNotFoundError } from "./projects-service.js";
import type { RunPluginsLoader } from "./run-plugins-loader.js";
import { WorkflowNotFoundError } from "./workflows-service.js";

type RunRow = Selectable<DB["workflow_runs"]>;
type StepRow = Selectable<DB["workflow_run_steps"]>;

export type RunMode = "test" | "production";
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
  commitSha: string | null;
  mode: RunMode;
  initiatedBy: string | null;
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
  mode?: RunMode;
  limit?: number;
  offset?: number;
}

export interface ListRunsResult {
  items: Run[];
  total: number;
}

export interface TriggerRunInput {
  triggerData?: Record<string, unknown>;
}

export interface TriggerTestRunInput extends TriggerRunInput {
  files?: Record<string, string>;
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
      )}. Set them in the selected environment before running.`,
    );
    this.name = "PluginSecretsMissingError";
  }
}

export class SandboxProviderNotConfiguredError extends Error {
  constructor() {
    super("Sandbox provider not configured");
    this.name = "SandboxProviderNotConfiguredError";
  }
}

export class ProductionDeploymentNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project '${projectId}' has no deployed main revision`);
    this.name = "ProductionDeploymentNotFoundError";
  }
}

export class InvalidRunOverlayError extends Error {
  constructor(readonly filePath: string) {
    super(`Invalid test run overlay path '${filePath}'`);
    this.name = "InvalidRunOverlayError";
  }
}

interface RunsServiceDeps {
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  devSandboxes?: DevSandboxService;
  runPluginsLoader?: RunPluginsLoader;
}

interface PreparedSource {
  files: Record<string, string>;
  originalFiles: Record<string, string>;
  workflowFile: string;
  commitSha: string | null;
  cloneSource?: CloneSource;
}

const tracer = getTracer("@catamorphic/core");

export class RunsService {
  private readonly executor?: RunExecutorImpl;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: RunsServiceDeps,
  ) {
    this.executor = deps.sandboxProvider
      ? new RunExecutorImpl({ provider: deps.sandboxProvider })
      : undefined;
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
    let countQuery = this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", projectId);
    if (input.workflowName) {
      query = query.where("workflow_name", "=", input.workflowName);
      countQuery = countQuery.where("workflow_name", "=", input.workflowName);
    }
    if (input.mode) {
      query = query.where("mode", "=", input.mode);
      countQuery = countQuery.where("mode", "=", input.mode);
    }
    const [rows, count] = await Promise.all([
      query
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      countQuery
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(mapRun), total: Number(count.count) };
  }

  async triggerProduction(
    identity: Identity,
    projectId: string,
    workflowName: string,
    input: TriggerRunInput,
  ): Promise<Run> {
    return this.trigger({
      identity,
      projectId,
      workflowName,
      input,
      mode: "production",
    });
  }

  async triggerTest(
    identity: Identity,
    projectId: string,
    workflowName: string,
    input: TriggerTestRunInput,
  ): Promise<Run> {
    return this.trigger({
      identity,
      projectId,
      workflowName,
      input,
      mode: "test",
    });
  }

  private async trigger(opts: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    input: TriggerTestRunInput;
    mode: RunMode;
  }): Promise<Run> {
    return withSpan(
      {
        tracer,
        name: "workflow.run",
        attributes: {
          "catamorphic.project.id": opts.projectId,
          "catamorphic.workflow.name": opts.workflowName,
          "catamorphic.tenant.id": opts.identity.tenantId,
          "catamorphic.run.mode": opts.mode,
        },
      },
      async (span) => {
        const run = await this.triggerInner(opts);
        span.setAttribute("catamorphic.run.id", run.id);
        span.setAttribute("catamorphic.run.status", run.status);
        return run;
      },
    );
  }

  private async triggerInner(opts: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    input: TriggerTestRunInput;
    mode: RunMode;
  }): Promise<Run> {
    const provider = this.deps.sandboxProvider;
    const executor = this.executor;
    if (!provider || !executor) {
      throw new SandboxProviderNotConfiguredError();
    }
    await this.requireProject(opts.identity, opts.projectId);

    const source =
      opts.mode === "test"
        ? await this.prepareTestSource(opts)
        : await this.prepareProductionSource(opts);
    const plugins = await this.loadPlugins(opts.projectId, opts.mode);
    const triggerData = opts.input.triggerData ?? {};
    const runId = crypto.randomUUID();
    const startedAt = new Date();

    await this.db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: opts.projectId,
        workflow_name: opts.workflowName,
        commit_sha: source.commitSha,
        mode: opts.mode,
        external_user_id: opts.identity.externalUserId,
        status: "running",
        trigger_data: triggerData as Json,
        started_at: startedAt,
      })
      .execute();

    const execution = await this.execute({
      identity: opts.identity,
      projectId: opts.projectId,
      workflowName: opts.workflowName,
      mode: opts.mode,
      runId,
      source,
      triggerData,
      plugins,
      provider,
      executor,
    });
    await this.finalizeRun(runId, execution);
    const row = await this.db
      .selectFrom("workflow_runs")
      .where("id", "=", runId)
      .selectAll()
      .executeTakeFirstOrThrow();
    return mapRun(row);
  }

  private async execute(opts: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    mode: RunMode;
    runId: string;
    source: PreparedSource;
    triggerData: Record<string, unknown>;
    plugins?: Awaited<ReturnType<RunPluginsLoader["load"]>>;
    provider: SandboxProvider;
    executor: RunExecutorImpl;
  }): Promise<RunResult> {
    let sandboxId: string | undefined;
    let workingDirectory: string | undefined;
    let destroySandbox = false;
    try {
      if (opts.mode === "test") {
        const devSandbox = await this.requireDevSandboxes().ensure({
          identity: opts.identity,
          projectId: opts.projectId,
          refresh: false,
        });
        sandboxId = devSandbox.providerId;
        workingDirectory = `${opts.provider.workspaceRoot}/runs/${opts.runId}`;
        await opts.provider.executeCommand(
          sandboxId,
          `rm -rf ${shellQuote(workingDirectory)} && mkdir -p ${shellQuote(workingDirectory)}`,
        );
        await uploadWorkspace({
          provider: opts.provider,
          sandboxId,
          projectDir: workingDirectory,
          files: opts.source.files,
        });
      } else {
        const handle = await opts.provider.createSandbox({
          language: "typescript",
          autoStopInterval: 5,
          labels: {
            purpose: "execution",
            projectId: opts.projectId,
            commitSha: opts.source.commitSha ?? "",
          },
        });
        sandboxId = handle.providerId;
        destroySandbox = true;
        workingDirectory = `${opts.provider.workspaceRoot}/project`;
        if (opts.source.cloneSource) {
          await opts.provider.gitClone(
            sandboxId,
            opts.source.cloneSource.url,
            workingDirectory,
            {
              branch: opts.source.cloneSource.branch,
              commitId: opts.source.commitSha ?? undefined,
              username: opts.source.cloneSource.username,
              password: opts.source.cloneSource.password,
            },
          );
          const transformedFiles = changedFiles({
            before: opts.source.originalFiles,
            after: opts.source.files,
          });
          if (Object.keys(transformedFiles).length > 0) {
            await uploadWorkspace({
              provider: opts.provider,
              sandboxId,
              projectDir: workingDirectory,
              files: transformedFiles,
            });
          }
        } else {
          await uploadWorkspace({
            provider: opts.provider,
            sandboxId,
            projectDir: workingDirectory,
            files: opts.source.files,
          });
        }
      }

      return await opts.executor.executeRun({
        sandboxId,
        workingDirectory,
        workflowFile: opts.source.workflowFile,
        workflowName: opts.workflowName,
        triggerData: opts.triggerData,
        runId: opts.runId,
        plugins: opts.plugins?.plugins,
        secrets: opts.plugins?.secrets,
      });
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        steps: [],
      };
    } finally {
      if (sandboxId && workingDirectory && opts.mode === "test") {
        await opts.provider
          .executeCommand(sandboxId, `rm -rf ${shellQuote(workingDirectory)}`)
          .catch(() => {});
      }
      if (sandboxId && destroySandbox) {
        await opts.provider.destroySandbox(sandboxId).catch(() => {});
      }
    }
  }

  private async prepareTestSource(opts: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    input: TriggerTestRunInput;
  }): Promise<PreparedSource> {
    const repo = await this.deps.projectManager.openDev(
      opts.identity.tenantId,
      opts.projectId,
      opts.identity.externalUserId,
    );
    try {
      const originalFiles = await repo.readAllFiles();
      const overlays = opts.input.files ?? {};
      assertOverlayPaths(overlays);
      const files = { ...originalFiles, ...overlays };
      return prepareSource({
        projectId: opts.projectId,
        workflowName: opts.workflowName,
        files,
        originalFiles,
        commitSha: null,
      });
    } finally {
      await repo.dispose();
    }
  }

  private async prepareProductionSource(opts: {
    identity: Identity;
    projectId: string;
    workflowName: string;
  }): Promise<PreparedSource> {
    const remote = this.deps.projectManager.remoteBackend;
    if (!remote) throw new ProductionDeploymentNotFoundError(opts.projectId);
    const repo = await this.deps.projectManager.openDev(
      opts.identity.tenantId,
      opts.projectId,
      opts.identity.externalUserId,
    );
    try {
      await fetchRemote({
        dev: repo,
        remote,
        tenantId: opts.identity.tenantId,
        projectId: opts.projectId,
        remoteBranch: "main",
      });
      const commitSha = await repo
        .resolveRef("refs/remotes/origin/main")
        .catch(() => null);
      if (!commitSha) {
        throw new ProductionDeploymentNotFoundError(opts.projectId);
      }
      const files = await repo.readAllFilesAtRef(commitSha);
      const cloneSource = remote.getCloneSource
        ? await remote.getCloneSource(opts.identity.tenantId, opts.projectId, {
            scope: "read",
          })
        : undefined;
      return {
        ...prepareSource({
          projectId: opts.projectId,
          workflowName: opts.workflowName,
          files,
          originalFiles: files,
          commitSha,
        }),
        cloneSource,
      };
    } finally {
      await repo.dispose();
    }
  }

  private async loadPlugins(projectId: string, mode: RunMode) {
    if (!this.deps.runPluginsLoader) return undefined;
    const plugins = await this.deps.runPluginsLoader.load({
      projectId,
      environment: mode,
    });
    if (plugins.missingRequiredSecrets.length > 0) {
      throw new PluginSecretsMissingError(plugins.missingRequiredSecrets);
    }
    return plugins;
  }

  private async finalizeRun(runId: string, result: RunResult): Promise<void> {
    const completedAt = new Date();
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("workflow_runs")
        .set({
          status: result.status,
          result: (result.result ?? null) as Json,
          error: result.error ?? null,
          completed_at: completedAt,
        })
        .where("id", "=", runId)
        .where("status", "=", "running")
        .execute();
      await trx
        .deleteFrom("workflow_run_steps")
        .where("run_id", "=", runId)
        .execute();
      if (result.steps.length > 0) {
        await trx
          .insertInto("workflow_run_steps")
          .values(
            result.steps.map((step) => ({
              id: crypto.randomUUID(),
              run_id: runId,
              node_id: step.nodeId,
              name: step.name,
              status: step.status,
              input: (step.input ?? null) as Json,
              output: (step.output ?? null) as Json,
              error: step.error ?? null,
              started_at: new Date(step.startedAt),
              completed_at: new Date(step.completedAt),
            })),
          )
          .execute();
      }
    });
  }

  private requireDevSandboxes(): DevSandboxService {
    if (!this.deps.devSandboxes) {
      throw new SandboxProviderNotConfiguredError();
    }
    return this.deps.devSandboxes;
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

function prepareSource(opts: {
  projectId: string;
  workflowName: string;
  files: Record<string, string>;
  originalFiles: Record<string, string>;
  commitSha: string | null;
}): PreparedSource {
  const prepared = prepareWorkflowExecution({
    files: opts.files,
    workflowName: opts.workflowName,
  });
  if (!prepared) {
    throw new WorkflowNotFoundError(opts.projectId, opts.workflowName);
  }
  const workflowFile = prepared.graph.filePath;
  if (!workflowFile) {
    throw new WorkflowNotFoundError(opts.projectId, opts.workflowName);
  }
  return {
    files: prepared.files,
    originalFiles: opts.originalFiles,
    workflowFile,
    commitSha: opts.commitSha,
  };
}

function changedFiles(opts: {
  before: Record<string, string>;
  after: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(opts.after).filter(
      ([path, content]) => opts.before[path] !== content,
    ),
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertOverlayPaths(files: Record<string, string>): void {
  for (const filePath of Object.keys(files)) {
    const parts = filePath.split("/");
    if (
      filePath.startsWith("/") ||
      filePath.includes("\0") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new InvalidRunOverlayError(filePath);
    }
  }
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowName: row.workflow_name,
    commitSha: row.commit_sha,
    mode: row.mode as RunMode,
    initiatedBy: row.external_user_id,
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
