import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { instrumentSandboxProvider } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { AgentContextService } from "./services/agent-context-service.js";
import { AgentSessionsService } from "./services/agent-sessions-service.js";
import { BatchExecutionService } from "./services/batch-execution-service.js";
import { BatchRunsService } from "./services/batch-runs-service.js";
import { DbSandboxStore } from "./services/db-sandbox-store.js";
import { DeploymentArtifactsService } from "./services/deployment-artifacts-service.js";
import { DeploymentRuntimeService } from "./services/deployment-runtime-service.js";
import { KyselyDeploymentRuntimeStore } from "./services/deployment-runtime-store.js";
import { DeploymentService } from "./services/deployment-service.js";
import { DevSandboxService } from "./services/dev-sandbox-service.js";
import { ExecutionJobsService } from "./services/execution-jobs-service.js";
import { ExecutionWorkerService } from "./services/execution-worker-service.js";
import { PluginsService } from "./services/plugins-service.js";
import { ProjectsService } from "./services/projects-service.js";
import { RateReservationsService } from "./services/rate-reservations-service.js";
import { RunPluginsLoader } from "./services/run-plugins-loader.js";
import { RunsService } from "./services/runs-service.js";
import { RuntimeEventsService } from "./services/runtime-events-service.js";
import { SecretsService } from "./services/secrets-service.js";
import { SkillsService } from "./services/skills-service.js";
import { WorkflowsService } from "./services/workflows-service.js";

export interface CatamorphicCoreConfig {
  db: Kysely<DB>;
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  pluginResolver?: PluginResolver;
  /**
   * Pluggable coding agent (e.g. `FlueCodingAgent` from `@catamorphic/flue`,
   * `CodexAgent` from `@catamorphic/codex`, or a host-supplied
   * implementation). Requires `sandboxProvider` — agent sessions operate on a
   * per-(project, user) dev sandbox.
   */
  codingAgent?: CodingAgentProvider;
}

/**
 * Container for all catamorphic services wired against a single DB + storage
 * backend. Framework-agnostic: consumed by `@catamorphic/server-sdk`
 * (library-direct embedding) and by `@catamorphic/fastify-plugin` (HTTP
 * surface). Host apps
 * construct exactly one of these at boot and hand it to whichever surface
 * they use.
 */
export class CatamorphicCore {
  readonly db: Kysely<DB>;
  readonly projectManager: ProjectManager;
  readonly sandboxProvider?: SandboxProvider;
  readonly pluginResolver?: PluginResolver;

  readonly projects: ProjectsService;
  readonly workflows: WorkflowsService;
  readonly runs: RunsService;
  readonly batchRuns: BatchRunsService;
  readonly batchExecution: BatchExecutionService;
  readonly deployment: DeploymentService;
  readonly deploymentArtifacts: DeploymentArtifactsService;
  readonly deploymentRuntime?: DeploymentRuntimeService;
  readonly executionJobs: ExecutionJobsService;
  readonly executionWorker: ExecutionWorkerService;
  readonly runtimeEvents: RuntimeEventsService;
  readonly rateReservations: RateReservationsService;
  readonly skills: SkillsService;
  readonly plugins?: PluginsService;
  readonly secrets?: SecretsService;
  readonly runPluginsLoader?: RunPluginsLoader;
  readonly devSandboxes?: DevSandboxService;
  readonly agentContext?: AgentContextService;
  readonly agentSessions?: AgentSessionsService;

  constructor(config: CatamorphicCoreConfig) {
    this.db = config.db;
    this.projectManager = config.projectManager;
    this.sandboxProvider = config.sandboxProvider
      ? instrumentSandboxProvider(config.sandboxProvider)
      : undefined;
    this.pluginResolver = config.pluginResolver;
    this.devSandboxes = this.sandboxProvider
      ? new DevSandboxService({
          projectManager: this.projectManager,
          provider: this.sandboxProvider,
          store: new DbSandboxStore(this.db),
        })
      : undefined;

    this.projects = new ProjectsService(this.db, this.projectManager);
    this.workflows = new WorkflowsService(this.projectManager, this.projects);
    this.deployment = new DeploymentService(this.projectManager);
    this.deploymentArtifacts = new DeploymentArtifactsService(this.db);
    this.deploymentRuntime = this.sandboxProvider
      ? new DeploymentRuntimeService(
          new KyselyDeploymentRuntimeStore(this.db),
          {
            provider: this.sandboxProvider,
            artifacts: this.deploymentArtifacts,
          },
        )
      : undefined;
    this.executionJobs = new ExecutionJobsService(this.db);
    this.executionWorker = new ExecutionWorkerService(this.executionJobs);
    this.runtimeEvents = new RuntimeEventsService(this.db);
    this.rateReservations = new RateReservationsService(this.db);

    if (this.pluginResolver) {
      this.plugins = new PluginsService(this.db, this.pluginResolver);
      this.secrets = new SecretsService(this.db, this.plugins);
      this.runPluginsLoader = new RunPluginsLoader(
        this.plugins,
        this.secrets,
        this.pluginResolver,
      );
      this.agentContext = new AgentContextService(
        this.plugins,
        this.pluginResolver,
      );
    }

    this.runs = new RunsService(this.db, {
      projectManager: this.projectManager,
      sandboxProvider: this.sandboxProvider,
      devSandboxes: this.devSandboxes,
      runPluginsLoader: this.runPluginsLoader,
      deploymentArtifacts: this.deploymentArtifacts,
      deploymentRuntime: this.deploymentRuntime,
      executionJobs: this.executionJobs,
      executionWorker: this.executionWorker,
      runtimeEvents: this.runtimeEvents,
    });
    this.batchRuns = new BatchRunsService(this.db, {
      jobs: this.executionJobs,
      resolveProductionArtifact: (args) =>
        this.runs.resolveProductionArtifact(args),
      getWorkflowKind: async (args) => {
        const workflow = await this.workflows.get(
          args.identity,
          args.projectId,
          args.workflowName,
          { ref: args.ref },
        );
        return workflow.kind ?? "regular";
      },
      cancelRuntimeInvocations: this.deploymentRuntime
        ? async ({ artifactId, invocationIds }) => {
            await Promise.all(
              invocationIds.map((invocationId) =>
                this.deploymentRuntime?.cancel({
                  artifactId,
                  invocationId,
                }),
              ),
            );
          }
        : undefined,
    });
    this.batchExecution = new BatchExecutionService(this.db, {
      batchRuns: this.batchRuns,
      jobs: this.executionJobs,
      rateReservations: this.rateReservations,
      worker: this.executionWorker,
      invokeRuntime: (args) => this.runs.invokeProductionRuntime(args),
    });

    this.skills = new SkillsService(this.db, this.projectManager);

    if (config.codingAgent && this.sandboxProvider && this.devSandboxes) {
      this.agentSessions = new AgentSessionsService(this.db, {
        projectManager: this.projectManager,
        sandboxProvider: this.sandboxProvider,
        codingAgent: config.codingAgent,
        devSandboxes: this.devSandboxes,
        plugins: this.plugins,
        pluginResolver: this.pluginResolver,
      });
    }
  }
}

export function createCatamorphicCore(
  config: CatamorphicCoreConfig,
): CatamorphicCore {
  return new CatamorphicCore(config);
}
