import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { instrumentSandboxProvider } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { HOST_SKILLS, SEED_SKILLS } from "./seeds.js";
import { AgentContextService } from "./services/agent-context-service.js";
import { AgentDefinitionsService } from "./services/agent-definitions-service.js";
import {
  AgentSessionsService,
  type AgentTurnSettledEvent,
} from "./services/agent-sessions-service.js";
import type { AppBundleStore } from "./services/app-bundle-store.js";
import { AppPoliciesService } from "./services/app-policies-service.js";
import { AppStorageService } from "./services/app-storage-service.js";
import { AppsService } from "./services/apps-service.js";
import { BatchExecutionHandler } from "./services/batch-execution-handler.js";
import { BoundaryExecutionHandler } from "./services/boundary-execution-handler.js";
import {
  type CapabilityProviderRuntime,
  CapabilityRegistry,
} from "./services/capability-providers.js";
import {
  type CodingAgentRegistry,
  isCodingAgentRegistry,
  singleAgentRegistry,
} from "./services/coding-agent-registry.js";
import { DbSandboxStore } from "./services/db-sandbox-store.js";
import { DeploymentArtifactsService } from "./services/deployment-artifacts-service.js";
import { DeploymentRuntimeService } from "./services/deployment-runtime-service.js";
import { KyselyDeploymentRuntimeStore } from "./services/deployment-runtime-store.js";
import { DeploymentService } from "./services/deployment-service.js";
import { DevSandboxService } from "./services/dev-sandbox-service.js";
import {
  type DocumentBlobStore,
  DocumentsService,
} from "./services/documents-service.js";
import { ExecutionJobsService } from "./services/execution-jobs-service.js";
import { ExecutionWorkerService } from "./services/execution-worker-service.js";
import {
  GithubService,
  type GithubServiceConfig,
} from "./services/github-service.js";
import { executeHostCall } from "./services/host-calls.js";
import { MembershipsService } from "./services/memberships-service.js";
import { PluginsService } from "./services/plugins-service.js";
import {
  type ProjectLifecycleHooks,
  ProjectsService,
} from "./services/projects-service.js";
import { RateReservationsService } from "./services/rate-reservations-service.js";
import { RemoteSyncService } from "./services/remote-sync-service.js";
import {
  type RetentionConfig,
  RetentionService,
} from "./services/retention-service.js";
import { RolesService } from "./services/roles-service.js";
import { RunCoordinator } from "./services/run-coordinator.js";
import { RunPluginsLoader } from "./services/run-plugins-loader.js";
import { RunsService } from "./services/runs-service.js";
import { RuntimeEventsService } from "./services/runtime-events-service.js";
import { SecretsService } from "./services/secrets-service.js";
import { SkillsService } from "./services/skills-service.js";
import { TenantPoliciesService } from "./services/tenant-policies-service.js";
import type { ToolPermissionBroker } from "./services/tool-permission-broker.js";
import type {
  McpToolKindSpec,
  TriggerKindRuntime,
} from "./services/trigger-kinds.js";
import { TriggersService } from "./services/triggers-service.js";
import { WorkflowsService } from "./services/workflows-service.js";

export interface CatamorphicCoreConfig {
  /**
   * How long a project's parsed `roles/*.json` set is trusted before it is
   * re-read from the shared origin (ADR 0055). Role *definitions* may lag
   * by this much; membership is read fresh on every resolve. Default 10s.
   */
  rolesCacheTtlMs?: number;
  /**
   * Where project-store bytes live when a document is not text (ADR 0055):
   * inline in Postgres by default; a filesystem or S3-compatible store
   * (`FsBundleStore`, `S3ObjectStore`) when configured. Metadata, versions,
   * text and the search index always stay in the database.
   */
  documentBlobStore?: DocumentBlobStore;
  db: Kysely<DB>;
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  pluginResolver?: PluginResolver;
  /**
   * Pluggable coding agent(s). Pass a single provider (e.g. `AiSdkCodingAgent`
   * from `@catamorphic/ai-sdk`) for the classic one-agent setup, or a
   * {@link CodingAgentRegistry} when the host offers several agents (the
   * desktop app registers one per configured profile agent). Requires
   * `sandboxProvider` — sandbox-execution agents operate on a per-(project,
   * user) dev sandbox.
   */
  codingAgent?: CodingAgentProvider | CodingAgentRegistry;
  /**
   * Where tool-permission asks (ADR 0054) park for hosts that answer them
   * over HTTP: hand its `handlerFor(agent)` to your providers'
   * `onToolPermission`, and the plugin serves the pending list + answer
   * routes. Hosts with their own consent UI (the desktop bridge) omit it.
   */
  toolPermissions?: ToolPermissionBroker;
  /**
   * Resolve a project's directory on the host filesystem, required for
   * registry agents with `execution: "host"` (Claude Code, Codex).
   */
  hostProjectPathResolver?: (
    projectId: string,
  ) => Promise<string | undefined> | string | undefined;
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
  /**
   * Host-defined trigger kinds. Workflows subscribe with
   * `triggers: [trigger("kind", config)]`; the host fires a kind with a
   * payload and every subscribed workflow runs. Build these with
   * `defineTriggerKind` from `@catamorphic/server-sdk`.
   */
  triggerKinds?: readonly TriggerKindRuntime[];
  /**
   * Which trigger kinds are AI-callable tools, and how to project a
   * binding's config into MCP tool metadata. Powers the per-project MCP
   * endpoint (`POST /projects/:id/mcp`): one tool per binding of every
   * kind named here. Every named kind must appear in `triggerKinds`.
   */
  mcpToolKinds?: readonly McpToolKindSpec[];
  /**
   * Fires after a coding-agent chat turn settles (completed, failed, or
   * awaiting input). Host-owned; a natural place to fire a chat trigger
   * kind. Exceptions are swallowed and never delay the turn.
   */
  onAgentTurnSettled?: (event: AgentTurnSettledEvent) => void | Promise<void>;
  /**
   * Host-side capability providers (ADR 0046): named fulfillers for plugin
   * `requires` declarations, resolved at run launch into env values that
   * are never persisted. Build these with `defineCapability` from
   * `@catamorphic/server-sdk`. Duplicate names fail at boot.
   */
  capabilityProviders?: readonly CapabilityProviderRuntime[];
  /**
   * Host-side project lifecycle hooks (ADR 0046). `onProjectCreated`
   * failures roll the create back; `onProjectDeleted` failures abort the
   * delete. Hooks must be idempotent.
   */
  projectHooks?: readonly ProjectLifecycleHooks[];
  /**
   * Transform the default per-project seed files (skills). Receives the
   * framework defaults; return the final map. Replacing or removing entries
   * is legitimate — an embedder's own app-design doctrine belongs here
   * (ADR 0049). A seed removed from the returned map is also never restored
   * by the per-turn workflow-skill staging.
   */
  projectSeeds?: (defaults: Record<string, string>) => Record<string, string>;
  /**
   * Transform the default host-tier skills (ADR 0049): playbooks the host
   * ships, listed alongside a project's own `.agents/skills/` without being
   * written into the project repo. Receives the framework defaults keyed by
   * `<name>/SKILL.md`; return the final map. Replacing or removing entries
   * is legitimate. A project skill with the same name shadows a host skill.
   */
  hostSkills?: (defaults: Record<string, string>) => Record<string, string>;
  /**
   * The standing system prompt prepended to every coding-agent session.
   * `undefined` keeps the framework default (the workflow-authoring
   * primer), a string replaces it, `false` removes it entirely
   * (ADR 0049).
   */
  standingAgentPrompt?: string | false;
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
  readonly triggers: TriggersService;
  readonly deployment: DeploymentService;
  readonly deploymentArtifacts: DeploymentArtifactsService;
  readonly deploymentRuntime?: DeploymentRuntimeService;
  readonly skills: SkillsService;
  readonly agentDefinitions: AgentDefinitionsService;
  /** Committed `roles/*.json` and their expansion into identities (ADR 0055). */
  readonly roles: RolesService;
  /** Stock `user → roles + grants` per project (ADR 0055). */
  readonly memberships: MembershipsService;
  /** The documents surface: program (git) + project store (ADR 0055). */
  readonly documents: DocumentsService;
  readonly tenantPolicies: TenantPoliciesService;
  readonly retention: RetentionService;
  readonly plugins?: PluginsService;
  readonly secrets?: SecretsService;
  readonly runPluginsLoader?: RunPluginsLoader;
  readonly devSandboxes?: DevSandboxService;
  readonly agentContext?: AgentContextService;
  readonly agentSessions?: AgentSessionsService;
  readonly toolPermissions?: ToolPermissionBroker;
  readonly apps?: AppsService;
  readonly appPolicies: AppPoliciesService;
  readonly github?: GithubService;
  readonly remoteSync: RemoteSyncService;
  readonly appStorage: AppStorageService;
  /** Tool-kind declarations behind the per-project MCP endpoint. */
  readonly mcpToolKinds: readonly McpToolKindSpec[];
  /** The host's registered capability providers (ADR 0046). */
  readonly capabilities: CapabilityRegistry;
  /** The resolved per-project seed files, after the host's hook (ADR 0049). */
  readonly seedFiles: Record<string, string>;
  /** The resolved host-tier skill files, after the host's hook (ADR 0049). */
  readonly hostSkillFiles: Record<string, string>;

  constructor(config: CatamorphicCoreConfig) {
    this.toolPermissions = config.toolPermissions;
    this.db = config.db;
    this.projectManager = config.projectManager;
    // Doctrine resolves ONCE, at boot: every consumer below (project
    // creation, skill restore) sees the same host-final set (ADR 0049).
    this.seedFiles = config.projectSeeds?.({ ...SEED_SKILLS }) ?? SEED_SKILLS;
    this.hostSkillFiles =
      config.hostSkills?.({ ...HOST_SKILLS }) ?? HOST_SKILLS;
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

    this.capabilities = new CapabilityRegistry(config.capabilityProviders);
    this.projects = new ProjectsService(
      this.db,
      this.projectManager,
      config.projectHooks,
      { seedFiles: this.seedFiles },
    );
    this.appStorage = new AppStorageService(this.db);
    this.github = config.github
      ? new GithubService(
          this.db,
          this.projectManager,
          this.projects,
          config.github,
        )
      : undefined;
    // Provider-agnostic remote sync (ADR 0044); code hosts contribute
    // credentials/capabilities through the CodeHost seam.
    this.remoteSync = new RemoteSyncService(
      this.db,
      this.projectManager,
      this.github ? [this.github.codeHost] : [],
    );
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
      this.plugins = new PluginsService(
        this.db,
        this.pluginResolver,
        this.capabilities.names,
      );
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
        this.capabilities,
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
      callHost: (args) =>
        executeHostCall(
          { documents: this.documents, capabilities: this.capabilities },
          args,
        ),
    });
    new BatchExecutionHandler(this.db, {
      coordinator,
      jobs: executionJobs,
      rateReservations,
      worker: executionWorker,
      invokeRuntime: (args) => this.runs.invokeProductionRuntime(args),
    });
    this.mcpToolKinds = config.mcpToolKinds ?? [];
    const registeredKinds = new Set(
      (config.triggerKinds ?? []).map((kind) => kind.name),
    );
    for (const spec of this.mcpToolKinds) {
      if (!registeredKinds.has(spec.kind)) {
        throw new Error(
          `mcpToolKinds names trigger kind '${spec.kind}', which is not in triggerKinds`,
        );
      }
    }
    this.triggers = new TriggersService(this.db, {
      kinds: config.triggerKinds ?? [],
      mcpToolKinds: this.mcpToolKinds,
      projectManager: this.projectManager,
      runs: this.runs,
    });

    this.skills = new SkillsService(this.db, this.projectManager, {
      hostSkills: this.hostSkillFiles,
    });
    // Committed project agent definitions (ADR 0050). The "e2e-fake" kind
    // is a desktop test seam, accepted only under the e2e flag — mirroring
    // how the desktop swaps in its fake harness and pick-folder stub.
    this.agentDefinitions = new AgentDefinitionsService(
      this.db,
      this.projectManager,
      { allowE2eFake: process.env.CATAMORPHIC_E2E_FAKE_AGENT === "1" },
    );
    this.roles = new RolesService(this.db, this.projectManager, {
      ...(config.rolesCacheTtlMs !== undefined
        ? { ttlMs: config.rolesCacheTtlMs }
        : {}),
    });
    this.memberships = new MembershipsService(this.db, this.roles);
    this.documents = new DocumentsService(this.db, {
      projectManager: this.projectManager,
      ...(config.documentBlobStore
        ? { blobStore: config.documentBlobStore }
        : {}),
    });

    if (config.codingAgent && this.sandboxProvider && this.devSandboxes) {
      const codingAgents = isCodingAgentRegistry(config.codingAgent)
        ? config.codingAgent
        : singleAgentRegistry(config.codingAgent);
      this.agentSessions = new AgentSessionsService(this.db, {
        projectManager: this.projectManager,
        sandboxProvider: this.sandboxProvider,
        codingAgents,
        hostProjectPath: config.hostProjectPathResolver,
        devSandboxes: this.devSandboxes,
        plugins: this.plugins,
        pluginResolver: this.pluginResolver,
        onTurnSettled: config.onAgentTurnSettled,
        seedFiles: this.seedFiles,
        standingAgentPrompt: config.standingAgentPrompt,
        mcpToolNames: (identity, projectId) =>
          this.triggers.mcpToolNames({ identity, projectId }),
        appPolicies: this.appPolicies,
      });
    }
  }
}

export function createCatamorphicCore(
  config: CatamorphicCoreConfig,
): CatamorphicCore {
  return new CatamorphicCore(config);
}
