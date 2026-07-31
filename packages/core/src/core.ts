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
import type { AppBundleStore } from "./services/app-bundle-store.js";
import { AppPoliciesService } from "./services/app-policies-service.js";
import { AppsService } from "./services/apps-service.js";
import { BatchExecutionHandler } from "./services/batch-execution-handler.js";
import { BoundaryExecutionHandler } from "./services/boundary-execution-handler.js";
import { DbSandboxStore } from "./services/db-sandbox-store.js";
import { DeploymentArtifactsService } from "./services/deployment-artifacts-service.js";
import { DeploymentRuntimeService } from "./services/deployment-runtime-service.js";
import { KyselyDeploymentRuntimeStore } from "./services/deployment-runtime-store.js";
import { DeploymentService } from "./services/deployment-service.js";
import { DevSandboxService } from "./services/dev-sandbox-service.js";
import { ExecutionJobsService } from "./services/execution-jobs-service.js";
import { ExecutionWorkerService } from "./services/execution-worker-service.js";
import {
  GithubService,
  type GithubServiceConfig,
} from "./services/github-service.js";
import { PluginsService } from "./services/plugins-service.js";
import { ProjectsService } from "./services/projects-service.js";
import { RateReservationsService } from "./services/rate-reservations-service.js";
import {
  type RetentionConfig,
  RetentionService,
} from "./services/retention-service.js";
import { RunCoordinator } from "./services/run-coordinator.js";
import { RunPluginsLoader } from "./services/run-plugins-loader.js";
import { RunsService } from "./services/runs-service.js";
import { RuntimeEventsService } from "./services/runtime-events-service.js";
import { SecretsService } from "./services/secrets-service.js";
import { SkillsService } from "./services/skills-service.js";
import { TenantPoliciesService } from "./services/tenant-policies-service.js";
import { WorkflowsService } from "./services/workflows-service.js";

export interface CatamorphicCoreConfig {
  db: Kysely<DB>;
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  pluginResolver?: PluginResolver;
  /**
   * Pluggable coding agent (e.g. `AiSdkCodingAgent` from
   * `@catamorphic/ai-sdk`, `CodexAgent` from `@catamorphic/codex`, or a host-supplied
   * implementation). Requires `sandboxProvider` — agent sessions operate on a
   * per-(project, user) dev sandbox.
   */
  codingAgent?: CodingAgentProvider;
  /**
   * How long finished runs are kept. Defaults to 90 days; set
   * `{ enabled: false }` to keep everything. Individual tenants can be given a
   * different window through `tenantPolicies`.
   */
  retention?: RetentionConfig;
  /**
   * Production runtime sandbox tuning. Everything here trades cold-start
   * latency against idle sandbox cost; the defaults match the previous
   * hardcoded values.
   */
  deploymentRuntime?: {
    /**
     * Concurrent invocations one runtime supervisor accepts before queueing.
     * Defaults to 4.
     */
    maxConcurrency?: number;
    /**
     * Minutes of idleness before the provider auto-stops a sandbox. A stopped
     * sandbox restarts much faster than a fresh one materializes, but every
     * stop still puts the next invocation through sandbox-start plus a health
     * poll. Defaults to 15.
     */
    autoStopMinutes?: number;
  };
  /**
   * Where built app bundles are stored (`S3ObjectStore` from `@catamorphic/s3`
   * satisfies this). Apps require both this and `sandboxProvider`; without
   * either, app build/publish surfaces are unavailable.
   */
  appBundleStore?: AppBundleStore;
  /** Hard cap on a built app bundle (js + css). Defaults to 5 MiB. */
  maxAppBundleBytes?: number;
  /**
   * GitHub App registration for repo import + push-back. Hosts bring their
   * own app (client id, and the secret when using the server web flow).
   * Without it, the GitHub surfaces are unavailable.
   */
  github?: GithubServiceConfig;
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
  readonly deployment: DeploymentService;
  readonly deploymentArtifacts: DeploymentArtifactsService;
  readonly deploymentRuntime?: DeploymentRuntimeService;
  readonly skills: SkillsService;
  readonly tenantPolicies: TenantPoliciesService;
  readonly retention: RetentionService;
  readonly plugins?: PluginsService;
  readonly secrets?: SecretsService;
  readonly runPluginsLoader?: RunPluginsLoader;
  readonly devSandboxes?: DevSandboxService;
  readonly agentContext?: AgentContextService;
  readonly agentSessions?: AgentSessionsService;
  readonly apps?: AppsService;
  readonly appPolicies: AppPoliciesService;
  readonly github?: GithubService;

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

    this.appPolicies = new AppPoliciesService(this.db);
    this.apps =
      this.sandboxProvider && this.devSandboxes && config.appBundleStore
        ? new AppsService(this.db, {
            projectManager: this.projectManager,
            devSandboxes: this.devSandboxes,
            provider: this.sandboxProvider,
            bundleStore: config.appBundleStore,
            policies: this.appPolicies,
            maxBundleBytes: config.maxAppBundleBytes,
          })
        : undefined;

    this.projects = new ProjectsService(this.db, this.projectManager);
    this.github = config.github
      ? new GithubService(
          this.db,
          this.projectManager,
          this.projects,
          config.github,
        )
      : undefined;
    this.workflows = new WorkflowsService(this.projectManager, this.projects);
    this.deployment = new DeploymentService(this.projectManager);
    this.deploymentArtifacts = new DeploymentArtifactsService(this.db);
    this.deploymentRuntime = this.sandboxProvider
      ? new DeploymentRuntimeService(
          new KyselyDeploymentRuntimeStore(this.db),
          {
            provider: this.sandboxProvider,
            artifacts: this.deploymentArtifacts,
            maxConcurrency: config.deploymentRuntime?.maxConcurrency,
            autoStopMinutes: config.deploymentRuntime?.autoStopMinutes,
          },
        )
      : undefined;
    const executionJobs = new ExecutionJobsService(this.db);
    this.retention = new RetentionService(this.db, config.retention);
    const executionWorker = new ExecutionWorkerService(
      executionJobs,
      this.retention,
      this.db,
    );
    const runtimeEvents = new RuntimeEventsService(this.db);
    const rateReservations = new RateReservationsService(this.db);
    this.tenantPolicies = new TenantPoliciesService(this.db);

    if (this.pluginResolver) {
      this.plugins = new PluginsService(this.db, this.pluginResolver);
    }
    // Secrets exist independently of plugins: a project declares its own with
    // `defineSecrets` in code, and plugins may declare additional ones.
    this.secrets = new SecretsService(this.db, this.plugins, (args) =>
      this.workflows.listDeclaredSecrets(args),
    );
    if (this.plugins && this.pluginResolver) {
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

    const coordinator = new RunCoordinator(this.db, executionJobs);
    executionWorker.registerExhaustedHandler((args) =>
      coordinator.handleExhaustedJob(args),
    );
    this.runs = new RunsService(this.db, {
      appPolicies: this.appPolicies,
      projectManager: this.projectManager,
      sandboxProvider: this.sandboxProvider,
      devSandboxes: this.devSandboxes,
      runPluginsLoader: this.runPluginsLoader,
      deploymentArtifacts: this.deploymentArtifacts,
      deploymentRuntime: this.deploymentRuntime,
      executionJobs,
      executionWorker,
      runtimeEvents,
      coordinator,
      tenantPolicies: this.tenantPolicies,
    });
    new BoundaryExecutionHandler(this.db, {
      coordinator,
      worker: executionWorker,
      rateReservations,
      tenantPolicies: this.tenantPolicies,
      invokeRuntime: (args) => this.runs.invokeProductionRuntime(args),
      resolveChild: (args) => this.runs.resolveProductionWorkflow(args),
    });
    new BatchExecutionHandler(this.db, {
      coordinator,
      jobs: executionJobs,
      rateReservations,
      worker: executionWorker,
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
