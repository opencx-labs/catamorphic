import type {
  AgentTurnSettledEvent,
  AppBundleStore,
  CapabilityProviderRuntime,
  CatamorphicCore,
  CodingAgentRegistry,
  DeploymentRuntimeCleanupResult,
  DeploymentRuntimeHealthResult,
  DeploymentRuntimeRetirementResult,
  ExecutionWorkerHandle,
  ExecutionWorkerOptions,
  GithubServiceConfig,
  McpToolKindSpec,
  ProjectLifecycleHooks,
  RetentionConfig,
  TriggerKindRuntime,
} from "@catamorphic/core";
import {
  createCatamorphicCore,
  DeploymentRuntimeNotSupportedError,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import {
  createDatabase,
  DEFAULT_SCHEMA,
  migrateToLatest,
} from "@catamorphic/db";
import type { ProjectPathResolver } from "@catamorphic/git";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import type pg from "pg";
import {
  type HostPluginDefinition,
  mergeHostPlugins,
} from "./define-plugin.js";
import { TenantScopedClient } from "./scoped-client.js";

export type DatabaseConfig =
  /**
   * Host-owned `pg.Pool`. Catamorphic manages its own tables inside a
   * dedicated schema (default `catamorphic`) and never ends the pool.
   */
  | { pool: pg.Pool; schema?: string }
  /**
   * Connection string for a pool catamorphic creates itself. Closed by
   * `Catamorphic#close()`.
   */
  | { connectionString: string; schema?: string }
  /**
   * Pre-built Kysely instance for advanced hosts. Must already be scoped to
   * catamorphic's schema (search_path or `WithSchemaPlugin`).
   */
  | { db: Kysely<DB>; schema?: string };

export type StorageConfig =
  /**
   * Filesystem-backed git storage: per-user working copies under
   * `projectsPath`, bare origin repos under `remotesPath`. The simplest way
   * to run. For Cloudflare Artifacts-backed origins, construct a
   * `ProjectManager` with `ArtifactsRemoteBackend` from
   * `@catamorphic/cloudflare` and pass it as `projectManager`.
   */
  | {
      projectsPath: string;
      remotesPath: string;
      /**
       * Optional host-owned lookup mapping a project to an explicit working
       * copy directory (e.g. the desktop app's user-visible project folders).
       * Return null to use the internal projectsPath layout. The host also
       * owns persisting that mapping — catamorphic never stores filesystem
       * paths.
       */
      projectPathResolver?: ProjectPathResolver;
    }
  /** Custom `ProjectManager` wiring (e.g. Artifacts remote backend). */
  | { projectManager: ProjectManager };

export interface CreateCatamorphicConfig {
  database: DatabaseConfig;
  storage: StorageConfig;
  /**
   * Required once the host executes runs. Read-only embedders can omit it.
   * The provider is automatically wrapped with OpenTelemetry instrumentation.
   */
  sandboxProvider?: SandboxProvider;
  /** Required once the host uses plugins + secrets. */
  pluginResolver?: PluginResolver;
  /**
   * Pluggable coding agent(s) for AI-assisted editing: a single provider
   * (e.g. `AiSdkCodingAgent` from `@catamorphic/ai-sdk`) or a
   * `CodingAgentRegistry` when the host offers several agents. Requires
   * `sandboxProvider`; enables the agent-session APIs.
   */
  codingAgent?: CodingAgentProvider | CodingAgentRegistry;
  /**
   * Resolve a project's directory on the host filesystem, required for
   * registry agents with `execution: "host"` (Claude Code, Codex).
   */
  hostProjectPathResolver?: (
    projectId: string,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * How long finished runs are kept before they and everything hanging off
   * them are purged. Defaults to 90 days; pass `{ enabled: false }` to keep
   * runs forever. Per-tenant windows go through `tenantPolicies`.
   */
  retention?: RetentionConfig;
  /**
   * Production runtime sandbox tuning: supervisor concurrency and the idle
   * auto-stop window. Defaults match the previous hardcoded values (4
   * concurrent invocations, 15 idle minutes).
   */
  deploymentRuntime?: {
    maxConcurrency?: number;
    autoStopMinutes?: number;
  };
  /**
   * Where built app bundles are stored (`S3ObjectStore` from `@catamorphic/s3`
   * satisfies this). Requires `sandboxProvider`; without both, app
   * build/publish surfaces are unavailable.
   */
  appBundleStore?: AppBundleStore;
  /** Hard cap on a built app bundle (js + css). Defaults to 5 MiB. */
  maxAppBundleBytes?: number;
  /**
   * GitHub App registration enabling repo import + push-back. Embedders
   * register their own GitHub App and pass its client id (and, when using the
   * server-side web OAuth flow, its client secret). Omit to leave the GitHub
   * surfaces disabled.
   */
  github?: GithubServiceConfig;
  /**
   * The host's custom trigger kinds, built with `defineTriggerKind`.
   * Workflows subscribe with `triggers: [trigger("kind", config)]`; firing a
   * kind through `scoped.triggers.fire` runs every subscribed workflow.
   */
  triggerKinds?: readonly TriggerKindRuntime[];
  /**
   * Which trigger kinds are AI-callable tools, built with `mcpToolKind`.
   * Powers the per-project MCP endpoint: one tool per binding of each
   * named kind. Every named kind must also appear in `triggerKinds`.
   */
  mcpToolKinds?: readonly McpToolKindSpec[];
  /**
   * Fires after a coding-agent chat turn settles — a natural place to fire
   * a chat trigger kind. Exceptions are swallowed and never delay the turn.
   */
  onAgentTurnSettled?: (event: AgentTurnSettledEvent) => void | Promise<void>;
  /**
   * Boot-registered plugin host halves (ADR 0046), built with
   * `definePlugin`. Each contributes capability providers, project
   * lifecycle hooks, trigger kinds, and MCP tool kinds; contributions merge
   * with the top-level arrays and name collisions fail at boot. The same
   * package's sandbox half is attached per project through the plugin
   * catalog — registration is the only way code enters the host process.
   */
  plugins?: readonly HostPluginDefinition[];
  /**
   * Host capability providers (ADR 0046), built with `defineCapability`:
   * named fulfillers for plugin manifest `requires` declarations. Resolved
   * at run launch into env values that are never persisted — mint
   * short-lived per-project credentials here.
   */
  capabilityProviders?: readonly CapabilityProviderRuntime[];
  /**
   * Project lifecycle hooks (ADR 0046): provision per-project
   * infrastructure on create (a throw rolls the create back), deprovision
   * on delete (a throw aborts the delete). Hooks must be idempotent.
   */
  projectHooks?: readonly ProjectLifecycleHooks[];
  /**
   * Transform the default per-project seed files (skills). Receives the
   * framework defaults; return the final map. Replacing or removing entries
   * is legitimate — an embedder's own app-design doctrine belongs here, and
   * a removed seed never resurrects (ADR 0049).
   */
  projectSeeds?: (defaults: Record<string, string>) => Record<string, string>;
  /**
   * The standing system prompt for coding-agent sessions: omit for the
   * framework's workflow-authoring default, pass a string to replace it,
   * or `false` for none (ADR 0049).
   */
  standingAgentPrompt?: string | false;
}

function resolveDatabase(config: DatabaseConfig): {
  db: Kysely<DB>;
  schema: string;
  ownsDb: boolean;
} {
  const schema = config.schema ?? DEFAULT_SCHEMA;
  if ("db" in config) {
    return { db: config.db, schema, ownsDb: false };
  }
  if ("pool" in config) {
    return {
      db: createDatabase({ pool: config.pool, schema }),
      schema,
      ownsDb: false,
    };
  }
  return {
    db: createDatabase({ connectionString: config.connectionString, schema }),
    schema,
    ownsDb: true,
  };
}

function resolveStorage(config: StorageConfig): ProjectManager {
  if ("projectManager" in config) {
    return config.projectManager;
  }
  return new ProjectManager(
    new FsBackend(config.projectsPath, config.projectPathResolver),
    new FsRemoteBackend(config.remotesPath),
  );
}

/**
 * Library-direct entry point for embedding catamorphic in a Node/Bun backend.
 * Hosts construct this once at boot and keep it around for the process
 * lifetime. Identity is bound per request with keyed tenant and user objects.
 */
export class Catamorphic {
  private readonly workerHandles = new Set<ExecutionWorkerHandle>();
  readonly core: CatamorphicCore;

  private readonly schema: string;
  private readonly ownsDb: boolean;

  constructor(config: CreateCatamorphicConfig | { core: CatamorphicCore }) {
    if ("core" in config) {
      this.core = config.core;
      this.schema = DEFAULT_SCHEMA;
      this.ownsDb = false;
      return;
    }

    const { db, schema, ownsDb } = resolveDatabase(config.database);
    this.schema = schema;
    this.ownsDb = ownsDb;
    const contributions = mergeHostPlugins({
      plugins: config.plugins ?? [],
      capabilityProviders: config.capabilityProviders ?? [],
      projectHooks: config.projectHooks ?? [],
      triggerKinds: config.triggerKinds ?? [],
      mcpToolKinds: config.mcpToolKinds ?? [],
    });
    this.core = createCatamorphicCore({
      db,
      projectManager: resolveStorage(config.storage),
      sandboxProvider: config.sandboxProvider,
      pluginResolver: config.pluginResolver,
      codingAgent: config.codingAgent,
      hostProjectPathResolver: config.hostProjectPathResolver,
      ...(config.retention === undefined
        ? {}
        : { retention: config.retention }),
      ...(config.deploymentRuntime === undefined
        ? {}
        : { deploymentRuntime: config.deploymentRuntime }),
      appBundleStore: config.appBundleStore,
      maxAppBundleBytes: config.maxAppBundleBytes,
      github: config.github,
      triggerKinds: contributions.triggerKinds,
      mcpToolKinds: contributions.mcpToolKinds,
      onAgentTurnSettled: config.onAgentTurnSettled,
      capabilityProviders: contributions.capabilityProviders,
      projectHooks: contributions.projectHooks,
      projectSeeds: config.projectSeeds,
      standingAgentPrompt: config.standingAgentPrompt,
    });
  }

  /**
   * Apply pending migrations inside catamorphic's schema. Idempotent and
   * scoped: the host's own tables are never touched. Call it from a deploy
   * step or at boot.
   */
  async migrate(): Promise<{ applied: string[] }> {
    const { applied } = await migrateToLatest({
      db: this.core.db,
      schema: this.schema,
    });
    return { applied };
  }

  /**
   * Bind the tenant (host's org id). Returns an intermediate client that
   * still needs a user id via `.forUser({ externalUserId })`.
   */
  forTenant(args: { tenantId: string }): TenantScopedClient {
    return new TenantScopedClient(this.core, args.tenantId);
  }

  startExecutionWorker(
    options: ExecutionWorkerOptions = {},
  ): ExecutionWorkerHandle {
    if (!this.core.sandboxProvider) {
      throw new Error("Sandbox provider required to start execution workers");
    }
    const handle = this.core.runs.startWorker(options);
    this.workerHandles.add(handle);
    void handle.done.finally(() => this.workerHandles.delete(handle));
    return handle;
  }

  redriveExecutionJob(args: {
    tenantId: string;
    jobId: string;
    availableAt?: Date;
  }): Promise<boolean> {
    return this.core.runs.redriveJob(args);
  }

  /**
   * Per-tenant execution limits: queue share, concurrency ceilings, active-run
   * ceilings, and per-bucket rate overrides.
   *
   * Deliberately host-only — it is not reachable through the HTTP surface,
   * because a tenant must not be able to raise its own limits. Hosts wire it to
   * their own plan/billing tier logic.
   */
  get tenantPolicies() {
    return this.core.tenantPolicies;
  }

  /**
   * Materialize a deployment's runtime ahead of its first trigger, so the
   * cold start (sandbox create, workspace upload, dependency install,
   * supervisor boot) happens at deploy time instead of on the first run's
   * critical path. Idempotent: a warm runtime is found and reused.
   */
  warmDeploymentRuntime(args: {
    tenantId: string;
    externalUserId: string;
    projectId: string;
    workflowName: string;
    commitSha: string;
    artifactId: string;
  }): Promise<void> {
    const { tenantId, externalUserId, ...rest } = args;
    return this.core.runs.warmProductionRuntime({
      ...rest,
      identity: { tenantId, externalUserId },
    });
  }

  reconcileDeploymentRuntimeHealth(
    args: { limit?: number } = {},
  ): Promise<DeploymentRuntimeHealthResult> {
    const service = this.core.deploymentRuntime;
    if (!service) throw new DeploymentRuntimeNotSupportedError();
    return service.reconcileHealth(args);
  }

  retireIdleDeploymentRuntimes(args: {
    idleBefore: Date;
    limit?: number;
  }): Promise<DeploymentRuntimeRetirementResult> {
    const service = this.core.deploymentRuntime;
    if (!service) throw new DeploymentRuntimeNotSupportedError();
    return service.retireIdle(args);
  }

  cleanupOldDeploymentArtifactRuntimes(args: {
    lastUsedBefore: Date;
    limit?: number;
  }): Promise<DeploymentRuntimeCleanupResult> {
    const service = this.core.deploymentRuntime;
    if (!service) throw new DeploymentRuntimeNotSupportedError();
    return service.cleanupOldArtifacts(args);
  }

  /**
   * Release resources catamorphic created itself (currently: the pg pool when
   * booted from a connection string). Host-owned pools and Kysely instances
   * are left untouched.
   */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.workerHandles].map((handle) => handle.stop()),
    );
    if (this.ownsDb) {
      await this.core.db.destroy();
    }
  }
}

/**
 * Convenience factory so hosts can do
 * `const cat = createCatamorphic({ database, storage, ... })`.
 */
export function createCatamorphic(
  config: CreateCatamorphicConfig | { core: CatamorphicCore },
): Catamorphic {
  return new Catamorphic(config);
}
