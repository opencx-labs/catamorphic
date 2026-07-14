import { getTracer, withSpan } from "@catamorphic/otel";
import {
  type CloneSource,
  type DeploymentRuntime,
  type DeploymentRuntimeStatus,
  type RunPluginPayload,
  removeWorkflowPackageDependency,
  type SandboxProvider,
  uploadPluginPayloads,
  WORKFLOW_PACKAGE_NAME,
} from "@catamorphic/sandbox";
import type {
  DeploymentArtifact,
  DeploymentArtifactsService,
} from "./deployment-artifacts-service.js";
import type {
  DeploymentRuntimeRecord,
  DeploymentRuntimeRecordStatus,
  DeploymentRuntimeStore,
} from "./deployment-runtime-store.js";
import { uploadWorkspace } from "./playground/workspace-upload.js";

const tracer = getTracer("@catamorphic/core");

export class DeploymentRuntimeNotSupportedError extends Error {
  constructor() {
    super("Sandbox provider does not support deployment runtimes");
    this.name = "DeploymentRuntimeNotSupportedError";
  }
}

export interface DeploymentRuntimeHealthResult {
  examined: number;
  healthy: number;
  starting: number;
  stopped: number;
  failed: number;
  activeInvocations: number;
  queuedInvocations: number;
  maxConcurrency: number;
}

export interface DeploymentRuntimeRetirementResult {
  examined: number;
  retired: number;
  skippedPinned: number;
  failed: number;
}

export interface DeploymentRuntimeCleanupResult {
  examined: number;
  destroyed: number;
  retiredArtifacts: number;
  skippedPinned: number;
  failed: number;
}

export class DeploymentRuntimeService {
  constructor(
    private readonly store: DeploymentRuntimeStore,
    private readonly deps: {
      provider: SandboxProvider;
      artifacts: Pick<DeploymentArtifactsService, "markStatus">;
      maxConcurrency?: number;
      now?: () => Date;
    },
  ) {}

  async ensure(args: {
    projectId: string;
    artifact: DeploymentArtifact;
    files: Record<string, string>;
    originalFiles: Record<string, string>;
    cloneSource?: CloneSource;
    plugins?: readonly RunPluginPayload[];
  }): Promise<DeploymentRuntime> {
    const runtimeProvider = this.deps.provider.deploymentRuntime;
    if (!runtimeProvider) throw new DeploymentRuntimeNotSupportedError();

    return withSpan(
      {
        tracer,
        name: "deployment_runtime.ensure",
        attributes: {
          "catamorphic.project.id": args.projectId,
          "catamorphic.deployment_artifact.id": args.artifact.id,
        },
      },
      async (span) => {
        return this.store.withArtifactLock({
          artifactId: args.artifact.id,
          operation: async () => {
            const existing = await this.store.findReusable({
              artifactId: args.artifact.id,
            });
            const sandboxId =
              existing?.sandboxId ??
              (
                await this.deps.provider.createSandbox({
                  language: "typescript",
                  autoStopInterval: 15,
                  labels: {
                    purpose: "deployment-runtime",
                    projectId: args.projectId,
                    deploymentArtifactId: args.artifact.id,
                  },
                })
              ).providerId;
            const projectDirectory = `${this.deps.provider.workspaceRoot}/deployments/${args.artifact.id}/project`;

            if (!existing) {
              await this.deps.artifacts.markStatus({
                artifactId: args.artifact.id,
                status: "building",
              });
              await this.materialize({
                sandboxId,
                projectDirectory,
                files: args.files,
                originalFiles: args.originalFiles,
                cloneSource: args.cloneSource,
                plugins: args.plugins,
              });
            } else {
              await this.deps.provider.startSandbox(sandboxId);
            }

            try {
              const runtime = await runtimeProvider.ensureRuntime({
                sandboxId,
                deploymentArtifactId: args.artifact.id,
                workingDirectory: projectDirectory,
                maxConcurrency: this.deps.maxConcurrency ?? 4,
              });
              if (existing) {
                const now = this.now();
                await this.store.update({
                  runtimeId: existing.id,
                  providerId: runtime.runtimeId,
                  status: "ready",
                  heartbeatAt: now,
                  usedAt: now,
                });
              } else {
                const replicaIndex = 0;
                await this.store.insert({
                  artifactId: args.artifact.id,
                  sandboxId,
                  providerId: runtime.runtimeId,
                  replicaIndex,
                  generation: await this.store.nextGeneration({
                    artifactId: args.artifact.id,
                    replicaIndex,
                  }),
                  status: "ready",
                  heartbeatAt: this.now(),
                });
              }
              await this.deps.artifacts.markStatus({
                artifactId: args.artifact.id,
                status: "ready",
              });
              span.setAttribute("catamorphic.sandbox.id", sandboxId);
              span.setAttribute("catamorphic.runtime.id", runtime.runtimeId);
              return runtime;
            } catch (error) {
              await this.deps.artifacts.markStatus({
                artifactId: args.artifact.id,
                status: "failed",
              });
              if (existing) {
                await this.store.update({
                  runtimeId: existing.id,
                  status: "failed",
                });
              } else {
                await this.deps.provider
                  .destroySandbox(sandboxId)
                  .catch(() => {});
              }
              throw error;
            }
          },
        });
      },
    );
  }

  async cancel(args: {
    artifactId: string;
    invocationId: string;
  }): Promise<void> {
    const runtimeProvider = this.deps.provider.deploymentRuntime;
    if (!runtimeProvider) throw new DeploymentRuntimeNotSupportedError();
    const providerId = await this.store.findReadyProviderId({
      artifactId: args.artifactId,
    });
    if (!providerId) return;
    await runtimeProvider.cancel({
      runtimeId: providerId,
      invocationId: args.invocationId,
    });
  }

  async reconcileHealth(
    args: { limit?: number } = {},
  ): Promise<DeploymentRuntimeHealthResult> {
    const runtimeProvider = this.deps.provider.deploymentRuntime;
    if (!runtimeProvider) throw new DeploymentRuntimeNotSupportedError();
    const limit = boundedLimit(args.limit);

    return withSpan(
      {
        tracer,
        name: "deployment_runtime.reconcile_health",
        attributes: { "catamorphic.runtime.reconcile_limit": limit },
      },
      async (span) => {
        const candidates = await this.store.listHealthCandidates({ limit });
        const outcomes = await Promise.all(
          candidates.map(async (runtime): Promise<HealthOutcome> => {
            try {
              const health = await runtimeProvider.getHealth({
                runtimeId: runtime.providerId,
              });
              const status = runtimeRecordStatus(health.runtimeStatus);
              const now = this.now();
              await this.store.update({
                runtimeId: runtime.id,
                status,
                heartbeatAt: now,
                usedAt:
                  health.activeInvocations + health.queuedInvocations > 0
                    ? now
                    : undefined,
              });
              return {
                status: health.runtimeStatus,
                activeInvocations: health.activeInvocations,
                queuedInvocations: health.queuedInvocations,
                maxConcurrency: health.maxConcurrency,
              };
            } catch {
              await this.store.update({
                runtimeId: runtime.id,
                status: "failed",
              });
              return {
                status: "error",
                activeInvocations: 0,
                queuedInvocations: 0,
                maxConcurrency: 0,
              };
            }
          }),
        );
        const result = outcomes.reduce<DeploymentRuntimeHealthResult>(
          (summary, outcome) => ({
            examined: summary.examined + 1,
            healthy: summary.healthy + (outcome.status === "healthy" ? 1 : 0),
            starting:
              summary.starting + (outcome.status === "starting" ? 1 : 0),
            stopped: summary.stopped + (outcome.status === "stopped" ? 1 : 0),
            failed: summary.failed + (outcome.status === "error" ? 1 : 0),
            activeInvocations:
              summary.activeInvocations + outcome.activeInvocations,
            queuedInvocations:
              summary.queuedInvocations + outcome.queuedInvocations,
            maxConcurrency: summary.maxConcurrency + outcome.maxConcurrency,
          }),
          emptyHealthResult(),
        );
        span.setAttribute(
          "catamorphic.runtime.reconciled_count",
          result.examined,
        );
        span.setAttribute("catamorphic.runtime.healthy_count", result.healthy);
        span.setAttribute(
          "catamorphic.runtime.active_invocations",
          result.activeInvocations,
        );
        span.setAttribute(
          "catamorphic.runtime.queued_invocations",
          result.queuedInvocations,
        );
        span.setAttribute(
          "catamorphic.runtime.max_concurrency",
          result.maxConcurrency,
        );
        return result;
      },
    );
  }

  async retireIdle(args: {
    idleBefore: Date;
    limit?: number;
  }): Promise<DeploymentRuntimeRetirementResult> {
    const limit = boundedLimit(args.limit);
    return withSpan(
      {
        tracer,
        name: "deployment_runtime.retire_idle",
        attributes: {
          "catamorphic.runtime.retire_limit": limit,
          "catamorphic.runtime.idle_before": args.idleBefore.toISOString(),
        },
      },
      async (span) => {
        const candidates = await this.store.listIdleCandidates({
          idleBefore: args.idleBefore,
          limit,
        });
        const outcomes = await Promise.all(
          candidates.map((runtime) => this.retireRuntime({ runtime })),
        );
        const result = outcomes.reduce<DeploymentRuntimeRetirementResult>(
          (summary, outcome) => ({
            examined: summary.examined + 1,
            retired: summary.retired + (outcome === "retired" ? 1 : 0),
            skippedPinned:
              summary.skippedPinned + (outcome === "pinned" ? 1 : 0),
            failed: summary.failed + (outcome === "failed" ? 1 : 0),
          }),
          { examined: 0, retired: 0, skippedPinned: 0, failed: 0 },
        );
        span.setAttribute("catamorphic.runtime.retired_count", result.retired);
        span.setAttribute(
          "catamorphic.runtime.pinned_count",
          result.skippedPinned,
        );
        span.setAttribute("catamorphic.runtime.failed_count", result.failed);
        return result;
      },
    );
  }

  async cleanupOldArtifacts(args: {
    lastUsedBefore: Date;
    limit?: number;
  }): Promise<DeploymentRuntimeCleanupResult> {
    const limit = boundedLimit(args.limit);
    return withSpan(
      {
        tracer,
        name: "deployment_runtime.cleanup_old_artifacts",
        attributes: {
          "catamorphic.runtime.cleanup_limit": limit,
          "catamorphic.deployment_artifact.last_used_before":
            args.lastUsedBefore.toISOString(),
        },
      },
      async (span) => {
        const candidates = await this.store.listOldArtifactCandidates({
          lastUsedBefore: args.lastUsedBefore,
          limit,
        });
        const outcomes = await Promise.all(
          candidates.map((runtime) => this.cleanupRuntime({ runtime })),
        );
        const result = outcomes.reduce<DeploymentRuntimeCleanupResult>(
          (summary, outcome) => ({
            examined: summary.examined + 1,
            destroyed:
              summary.destroyed + (outcome.status === "destroyed" ? 1 : 0),
            retiredArtifacts:
              summary.retiredArtifacts + (outcome.retiredArtifact ? 1 : 0),
            skippedPinned:
              summary.skippedPinned + (outcome.status === "pinned" ? 1 : 0),
            failed: summary.failed + (outcome.status === "failed" ? 1 : 0),
          }),
          {
            examined: 0,
            destroyed: 0,
            retiredArtifacts: 0,
            skippedPinned: 0,
            failed: 0,
          },
        );
        span.setAttribute(
          "catamorphic.runtime.destroyed_count",
          result.destroyed,
        );
        span.setAttribute(
          "catamorphic.deployment_artifact.retired_count",
          result.retiredArtifacts,
        );
        span.setAttribute(
          "catamorphic.runtime.pinned_count",
          result.skippedPinned,
        );
        span.setAttribute("catamorphic.runtime.failed_count", result.failed);
        return result;
      },
    );
  }

  private async retireRuntime(args: {
    runtime: DeploymentRuntimeRecord;
  }): Promise<RetirementOutcome> {
    if (
      await this.store.hasPinnedWork({ artifactId: args.runtime.artifactId })
    ) {
      return "pinned";
    }
    const claimed = await this.store.claim({
      runtimeId: args.runtime.id,
      expectedStatus: args.runtime.status,
    });
    if (!claimed) return "failed";

    try {
      if (
        await this.store.hasPinnedWork({ artifactId: args.runtime.artifactId })
      ) {
        await this.store.update({
          runtimeId: args.runtime.id,
          status: args.runtime.status,
        });
        return "pinned";
      }
      await this.deps.provider.stopSandbox(args.runtime.sandboxId);
      await this.store.update({
        runtimeId: args.runtime.id,
        status: "stopped",
      });
      return "retired";
    } catch {
      await this.store.update({
        runtimeId: args.runtime.id,
        status: "failed",
      });
      return "failed";
    }
  }

  private async cleanupRuntime(args: {
    runtime: DeploymentRuntimeRecord;
  }): Promise<CleanupOutcome> {
    if (
      await this.store.hasPinnedWork({ artifactId: args.runtime.artifactId })
    ) {
      return { status: "pinned", retiredArtifact: false };
    }
    const claimed = await this.store.claim({
      runtimeId: args.runtime.id,
      expectedStatus: args.runtime.status,
    });
    if (!claimed) return { status: "failed", retiredArtifact: false };

    try {
      if (
        await this.store.hasPinnedWork({ artifactId: args.runtime.artifactId })
      ) {
        await this.store.update({
          runtimeId: args.runtime.id,
          status: args.runtime.status,
        });
        return { status: "pinned", retiredArtifact: false };
      }
      await this.deps.provider.destroySandbox(args.runtime.sandboxId);
      const deleted = await this.store.deleteClaimed({
        runtimeId: args.runtime.id,
      });
      if (!deleted) {
        await this.store.update({
          runtimeId: args.runtime.id,
          status: "failed",
        });
        return { status: "failed", retiredArtifact: false };
      }
      const retiredArtifact = await this.store.retireArtifactIfUnused({
        artifactId: args.runtime.artifactId,
      });
      return { status: "destroyed", retiredArtifact };
    } catch {
      await this.store.update({
        runtimeId: args.runtime.id,
        status: "failed",
      });
      return { status: "failed", retiredArtifact: false };
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async materialize(args: {
    sandboxId: string;
    projectDirectory: string;
    files: Record<string, string>;
    originalFiles: Record<string, string>;
    cloneSource?: CloneSource;
    plugins?: readonly RunPluginPayload[];
  }): Promise<void> {
    if (args.cloneSource) {
      await this.deps.provider.gitClone(
        args.sandboxId,
        args.cloneSource.url,
        args.projectDirectory,
        {
          branch: args.cloneSource.branch,
          commitId: args.cloneSource.commitSha,
          username: args.cloneSource.username,
          password: args.cloneSource.password,
        },
      );
      const transformed = changedFiles({
        before: args.originalFiles,
        after: args.files,
      });
      if (Object.keys(transformed).length > 0) {
        await uploadWorkspace({
          provider: this.deps.provider,
          sandboxId: args.sandboxId,
          projectDir: args.projectDirectory,
          files: transformed,
        });
      }
    } else {
      await uploadWorkspace({
        provider: this.deps.provider,
        sandboxId: args.sandboxId,
        projectDir: args.projectDirectory,
        files: args.files,
      });
    }
    const workflowFallback = args.plugins?.find(
      (plugin) => plugin.packageName === WORKFLOW_PACKAGE_NAME,
    );
    const packageJson =
      args.files["package.json"] ?? args.originalFiles["package.json"];
    if (
      workflowFallback &&
      ("bun.lock" in args.files ||
        "bun.lockb" in args.files ||
        "bun.lock" in args.originalFiles ||
        "bun.lockb" in args.originalFiles)
    ) {
      throw new Error(
        "The local @catamorphic/workflow fallback cannot be used with a lockfile",
      );
    }
    if (workflowFallback && !packageJson) {
      throw new Error(
        "The local @catamorphic/workflow fallback requires package.json",
      );
    }
    if (workflowFallback && packageJson) {
      await this.deps.provider.uploadFiles(
        args.sandboxId,
        {
          "package.json": removeWorkflowPackageDependency({ packageJson }),
        },
        args.projectDirectory,
      );
    }
    const install = await this.deps.provider.executeCommand(
      args.sandboxId,
      workflowFallback
        ? "bun install --no-save"
        : "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install --no-save; fi",
      {
        cwd: args.projectDirectory,
        timeout: 300,
      },
    );
    if (workflowFallback && packageJson) {
      await this.deps.provider.uploadFiles(
        args.sandboxId,
        { "package.json": packageJson },
        args.projectDirectory,
      );
    }
    if (install.exitCode !== 0) {
      throw new Error(
        `Deployment dependency install failed: ${install.result}`,
      );
    }
    await uploadPluginPayloads({
      provider: this.deps.provider,
      sandboxId: args.sandboxId,
      projectDir: args.projectDirectory,
      plugins: args.plugins ? [...args.plugins] : undefined,
    });
    const protect = await this.deps.provider.executeCommand(
      args.sandboxId,
      "chmod -R a-w .",
      { cwd: args.projectDirectory, timeout: 30 },
    );
    if (protect.exitCode !== 0) {
      throw new Error(`Failed to protect deployment files: ${protect.result}`);
    }
  }
}

function changedFiles(args: {
  before: Record<string, string>;
  after: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(args.after).filter(
      ([filePath, content]) => args.before[filePath] !== content,
    ),
  );
}

type RetirementOutcome = "retired" | "pinned" | "failed";

interface CleanupOutcome {
  status: "destroyed" | "pinned" | "failed";
  retiredArtifact: boolean;
}

interface HealthOutcome {
  status: DeploymentRuntimeStatus;
  activeInvocations: number;
  queuedInvocations: number;
  maxConcurrency: number;
}

function runtimeRecordStatus(
  status: DeploymentRuntimeStatus,
): DeploymentRuntimeRecordStatus {
  if (status === "healthy") return "ready";
  if (status === "error") return "failed";
  return status;
}

function boundedLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 100, 1_000));
}

function emptyHealthResult(): DeploymentRuntimeHealthResult {
  return {
    examined: 0,
    healthy: 0,
    starting: 0,
    stopped: 0,
    failed: 0,
    activeInvocations: 0,
    queuedInvocations: 0,
    maxConcurrency: 0,
  };
}
