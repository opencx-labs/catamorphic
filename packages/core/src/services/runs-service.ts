import type { DB, Json } from "@catamorphic/db";
import {
  fetchRemote,
  type CloneSource as GitCloneSource,
  type ProjectManager,
} from "@catamorphic/git";
import { getTracer, withSpan } from "@catamorphic/otel";
import { prepareWorkflowExecution } from "@catamorphic/parser";
import {
  DeploymentRuntimeExecutorAdapter,
  RUNTIME_PROTOCOL_VERSION,
  RunExecutorImpl,
  type RunPluginPayload,
  type RunResult,
  RuntimeEventReportingError,
  type RuntimeInvocation,
  type RuntimeInvocationReceipt,
  resolveWorkflowPackageFallback,
  type SandboxProvider,
  type WorkflowPackagePayload,
} from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import type {
  DeploymentArtifact,
  DeploymentArtifactsService,
} from "./deployment-artifacts-service.js";
import type { DeploymentRuntimeService } from "./deployment-runtime-service.js";
import type { DevSandboxService } from "./dev-sandbox-service.js";
import type {
  ExecutionJob,
  ExecutionJobsService,
} from "./execution-jobs-service.js";
import type { ExecutionWorkerService } from "./execution-worker-service.js";
import { uploadWorkspace } from "./playground/workspace-upload.js";
import { ProjectNotFoundError } from "./projects-service.js";
import type { RunPluginsLoader } from "./run-plugins-loader.js";
import type { RuntimeEventsService } from "./runtime-events-service.js";
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

export class RegularWorkflowRequiredError extends Error {
  constructor(readonly workflowName: string) {
    super(`Workflow '${workflowName}' is a batch workflow`);
    this.name = "RegularWorkflowRequiredError";
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
  deploymentArtifacts: DeploymentArtifactsService;
  deploymentRuntime?: DeploymentRuntimeService;
  executionJobs: ExecutionJobsService;
  executionWorker: ExecutionWorkerService;
  runtimeEvents: RuntimeEventsService;
}

interface PreparedSource {
  files: Record<string, string>;
  originalFiles: Record<string, string>;
  workflowFile: string;
  commitSha: string | null;
  cloneSource?: GitCloneSource & { commitSha: string };
  workflowKind: "regular" | "batch";
  workflowPackage?: WorkflowPackagePayload;
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
    deps.executionWorker.registerHandler({
      kind: "workflow_run",
      handler: ({ job, signal }) => this.executeProductionJob({ job, signal }),
    });
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

  async cancel(args: { identity: Identity; runId: string }): Promise<Run> {
    const existing = await this.get(args.identity, args.runId);
    if (
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    ) {
      return existing;
    }

    const now = new Date();
    await this.db
      .updateTable("workflow_runs")
      .set({
        status: "cancelled",
        cancel_requested_at: now,
        completed_at: now,
      })
      .where("id", "=", args.runId)
      .where("status", "in", ["pending", "running"])
      .execute();
    await this.deps.executionJobs.cancelByDedupeKey({
      tenantId: args.identity.tenantId,
      dedupeKey: `workflow-run:${args.runId}`,
    });
    const row = await this.db
      .selectFrom("workflow_runs")
      .where("id", "=", args.runId)
      .selectAll()
      .executeTakeFirstOrThrow();
    if (
      row.mode === "production" &&
      row.deployment_artifact_id &&
      this.deps.deploymentRuntime
    ) {
      await this.deps.deploymentRuntime.cancel({
        artifactId: row.deployment_artifact_id,
        invocationId: row.id,
      });
    }
    return mapRun(row);
  }

  async report(args: {
    identity: Identity;
    runId: string;
    result: RunResult;
  }): Promise<RunDetail> {
    await this.get(args.identity, args.runId);
    await this.finalizeRun(args.runId, args.result);
    return this.get(args.identity, args.runId);
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

  async resolveProductionArtifact(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
  }): Promise<DeploymentArtifact> {
    await this.requireProject(args.identity, args.projectId);
    const source = await this.prepareProductionSource(args);
    if (!source.commitSha) {
      throw new ProductionDeploymentNotFoundError(args.projectId);
    }
    const plugins = await this.loadPlugins(args.projectId, "production");
    return this.deps.deploymentArtifacts.ensure({
      tenantId: args.identity.tenantId,
      projectId: args.projectId,
      commitSha: source.commitSha,
      files: source.files,
      plugins: runtimePackages({
        plugins: plugins?.plugins,
        workflowPackage: source.workflowPackage,
      }),
    });
  }

  async invokeProductionRuntime(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
    artifactId: string;
    invocationId: string;
    kind: RuntimeInvocation["kind"];
    operation?: string;
    exportName?: string;
    input: unknown;
    attempt: number;
    timeoutSeconds?: number;
  }): Promise<RuntimeInvocationReceipt> {
    const provider = this.deps.sandboxProvider;
    const deploymentRuntime = this.deps.deploymentRuntime;
    if (!provider?.deploymentRuntime || !deploymentRuntime) {
      throw new SandboxProviderNotConfiguredError();
    }
    const [source, plugins, artifact] = await Promise.all([
      this.prepareProductionSource(args),
      this.loadPlugins(args.projectId, "production"),
      this.deps.deploymentArtifacts.get({ artifactId: args.artifactId }),
    ]);
    if (!artifact || artifact.commitSha !== args.commitSha) {
      throw new Error(
        `Deployment artifact '${args.artifactId}' does not match batch run`,
      );
    }
    const runtime = await deploymentRuntime.ensure({
      projectId: args.projectId,
      artifact,
      files: source.files,
      originalFiles: source.originalFiles,
      cloneSource: source.cloneSource,
      plugins: runtimePackages({
        plugins: plugins?.plugins,
        workflowPackage: source.workflowPackage,
      }),
    });
    return provider.deploymentRuntime.invoke({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId: runtime.runtimeId,
      invocationId: args.invocationId,
      deploymentArtifactId: artifact.id,
      kind: args.kind,
      target: {
        modulePath: source.workflowFile,
        exportName: args.exportName ?? args.workflowName,
        operation: args.operation,
      },
      input: args.input,
      attempt: args.attempt,
      deadlineAt: new Date(
        Date.now() + (args.timeoutSeconds ?? 300) * 1_000,
      ).toISOString(),
      env: plugins?.secrets,
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
    if (source.workflowKind === "batch") {
      throw new RegularWorkflowRequiredError(opts.workflowName);
    }
    const plugins = await this.loadPlugins(opts.projectId, opts.mode);
    const triggerData = opts.input.triggerData ?? {};
    const runId = crypto.randomUUID();
    if (opts.mode === "production") {
      if (!source.commitSha) {
        throw new ProductionDeploymentNotFoundError(opts.projectId);
      }
      const artifact = await this.deps.deploymentArtifacts.ensure({
        tenantId: opts.identity.tenantId,
        projectId: opts.projectId,
        commitSha: source.commitSha,
        files: source.files,
        plugins: runtimePackages({
          plugins: plugins?.plugins,
          workflowPackage: source.workflowPackage,
        }),
      });
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("workflow_runs")
          .values({
            id: runId,
            project_id: opts.projectId,
            workflow_name: opts.workflowName,
            commit_sha: source.commitSha,
            deployment_artifact_id: artifact.id,
            mode: "production",
            external_user_id: opts.identity.externalUserId,
            status: "pending",
            trigger_data: triggerData as Json,
          })
          .execute();
        await this.deps.executionJobs.enqueue({
          tenantId: opts.identity.tenantId,
          kind: "workflow_run",
          payload: { runId },
          priority: 100,
          dedupeKey: `workflow-run:${runId}`,
          trx,
        });
      });
      const row = await this.db
        .selectFrom("workflow_runs")
        .where("id", "=", runId)
        .selectAll()
        .executeTakeFirstOrThrow();
      return mapRun(row);
    }

    await this.db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: opts.projectId,
        workflow_name: opts.workflowName,
        commit_sha: null,
        mode: "test",
        external_user_id: opts.identity.externalUserId,
        status: "running",
        trigger_data: triggerData as Json,
        started_at: new Date(),
      })
      .execute();
    const execution = await this.execute({
      identity: opts.identity,
      projectId: opts.projectId,
      workflowName: opts.workflowName,
      mode: "test",
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

  private async executeProductionJob(args: {
    job: ExecutionJob;
    signal: AbortSignal;
  }): Promise<void> {
    const runId = readRunId(args.job.payload);
    const row = await this.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("workflow_runs.id", "=", runId)
      .selectAll("workflow_runs")
      .select("projects.tenant_id")
      .executeTakeFirst();
    if (!row || row.tenant_id !== args.job.tenantId) {
      throw new RunNotFoundError(runId);
    }
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return;
    }
    if (!row.commit_sha || !row.external_user_id) {
      throw new Error(`Production run '${runId}' has incomplete provenance`);
    }
    if (args.signal.aborted) {
      throw new Error("Execution worker stopped before invocation");
    }

    const claimed = await this.db
      .updateTable("workflow_runs")
      .set({
        status: "running",
        started_at: row.started_at ?? new Date(),
        attempt: args.job.attempt,
      })
      .where("id", "=", runId)
      .where("status", "in", ["pending", "running"])
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) {
      return;
    }

    const identity: Identity = {
      tenantId: row.tenant_id,
      externalUserId: row.external_user_id,
    };
    const provider = this.deps.sandboxProvider;
    const executor = this.executor;
    if (!provider || !executor) {
      throw new SandboxProviderNotConfiguredError();
    }
    const source = await this.prepareProductionSource({
      identity,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      commitSha: row.commit_sha,
    });
    const plugins = await this.loadPlugins(row.project_id, "production");
    const artifact = row.deployment_artifact_id
      ? await this.deps.deploymentArtifacts.get({
          artifactId: row.deployment_artifact_id,
        })
      : null;
    if (!artifact) {
      throw new Error(`Production run '${runId}' has no deployment artifact`);
    }
    const execution = await this.execute({
      identity,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      mode: "production",
      runId,
      source,
      triggerData: jsonObject(row.trigger_data),
      plugins,
      provider,
      executor,
      artifact,
      invocationId: `${runId}:${args.job.attempt}`,
      invocationAttempt: args.job.attempt,
    });
    await this.finalizeRun(runId, execution);
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
    artifact?: DeploymentArtifact;
    invocationId?: string;
    invocationAttempt?: number;
  }): Promise<RunResult> {
    let sandboxId: string | undefined;
    let workingDirectory: string | undefined;
    let destroySandbox = false;
    try {
      if (
        opts.mode === "production" &&
        opts.artifact &&
        this.deps.deploymentRuntime &&
        opts.provider.deploymentRuntime
      ) {
        const runtime = await this.deps.deploymentRuntime.ensure({
          projectId: opts.projectId,
          artifact: opts.artifact,
          files: opts.source.files,
          originalFiles: opts.source.originalFiles,
          cloneSource: opts.source.cloneSource,
          plugins: runtimePackages({
            plugins: opts.plugins?.plugins,
            workflowPackage: opts.source.workflowPackage,
          }),
        });
        const runtimeExecutor = new DeploymentRuntimeExecutorAdapter({
          provider: opts.provider,
          runtime,
          invocationId: opts.invocationId,
          invocationAttempt: opts.invocationAttempt,
          replay: await this.deps.runtimeEvents.replay({
            tenantId: opts.identity.tenantId,
            runId: opts.runId,
          }),
          eventSink: this.deps.runtimeEvents.sink({
            tenantId: opts.identity.tenantId,
            runId: opts.runId,
          }),
        });
        return await runtimeExecutor.executeRun({
          sandboxId: runtime.sandboxId,
          workingDirectory: `${opts.provider.workspaceRoot}/deployments/${opts.artifact.id}/project`,
          workflowFile: opts.source.workflowFile,
          workflowName: opts.workflowName,
          triggerData: opts.triggerData,
          runId: opts.runId,
          plugins: runtimePackages({
            plugins: opts.plugins?.plugins,
            workflowPackage: opts.source.workflowPackage,
          }),
          secrets: opts.plugins?.secrets,
        });
      }
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
        plugins: runtimePackages({
          plugins: opts.plugins?.plugins,
          workflowPackage: opts.source.workflowPackage,
        }),
        secrets: opts.plugins?.secrets,
      });
    } catch (error) {
      if (error instanceof RuntimeEventReportingError) throw error;
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
      return await prepareSource({
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
    commitSha?: string;
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
      const commitSha =
        opts.commitSha ??
        (await repo.resolveRef("refs/remotes/origin/main").catch(() => null));
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
        ...(await prepareSource({
          projectId: opts.projectId,
          workflowName: opts.workflowName,
          files,
          originalFiles: files,
          commitSha,
        })),
        cloneSource: cloneSource ? { ...cloneSource, commitSha } : undefined,
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
      const updated = await trx
        .updateTable("workflow_runs")
        .set({
          status: result.status,
          result: (result.result ?? null) as Json,
          error: result.error ?? null,
          completed_at: completedAt,
        })
        .where("id", "=", runId)
        .where("status", "=", "running")
        .returning("id")
        .execute();
      if (updated.length === 0) return;
      if (result.steps.length > 0) {
        await trx
          .insertInto("workflow_run_steps")
          .values(
            withStepOccurrences(result.steps).map(({ step, occurrence }) => ({
              id: crypto.randomUUID(),
              run_id: runId,
              node_id: step.nodeId,
              occurrence,
              name: step.name,
              status: step.status,
              attempt: step.attempt ?? 1,
              input: (step.input ?? null) as Json,
              output: (step.output ?? null) as Json,
              error: step.error ?? null,
              started_at: new Date(step.startedAt),
              completed_at: new Date(step.completedAt),
            })),
          )
          .onConflict((conflict) =>
            conflict
              .columns(["run_id", "node_id", "occurrence"])
              .doUpdateSet((eb) => ({
                name: eb.ref("excluded.name"),
                status: eb.ref("excluded.status"),
                attempt: eb.ref("excluded.attempt"),
                input: eb.ref("excluded.input"),
                output: eb.ref("excluded.output"),
                error: eb.ref("excluded.error"),
                started_at: eb.ref("excluded.started_at"),
                completed_at: eb.ref("excluded.completed_at"),
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

function withStepOccurrences(
  steps: RunResult["steps"],
): Array<{ step: RunResult["steps"][number]; occurrence: number }> {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = step.occurrence ?? occurrences.get(step.nodeId) ?? 0;
    occurrences.set(
      step.nodeId,
      Math.max(occurrences.get(step.nodeId) ?? 0, occurrence + 1),
    );
    return { step, occurrence };
  });
}

async function prepareSource(opts: {
  projectId: string;
  workflowName: string;
  files: Record<string, string>;
  originalFiles: Record<string, string>;
  commitSha: string | null;
}): Promise<PreparedSource> {
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
    workflowKind: prepared.graph.kind ?? "regular",
    workflowPackage: await resolveWorkflowPackageFallback({
      packageJson: opts.files["package.json"],
    }),
  };
}

function runtimePackages(args: {
  plugins?: readonly RunPluginPayload[];
  workflowPackage?: WorkflowPackagePayload;
}): RunPluginPayload[] | undefined {
  const packages = [
    ...(args.plugins ?? []),
    ...(args.workflowPackage ? [args.workflowPackage] : []),
  ];
  return packages.length > 0 ? packages : undefined;
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

function readRunId(payload: Json): string {
  if (
    Array.isArray(payload) ||
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.runId !== "string"
  ) {
    throw new Error("Workflow run job payload is missing runId");
  }
  return payload.runId;
}

function jsonObject(value: Json | null): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
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
