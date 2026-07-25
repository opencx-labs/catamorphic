import type {
  CatamorphicCore,
  DeploymentRuntimeCleanupResult,
  DeploymentRuntimeHealthResult,
  DeploymentRuntimeRetirementResult,
  ExecutionWorkerHandle,
  ExecutionWorkerOptions,
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
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import type pg from "pg";
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
  | { projectsPath: string; remotesPath: string }
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
   * Pluggable coding agent for AI-assisted editing (e.g. `AiSdkCodingAgent`
   * from `@catamorphic/ai-sdk` or `CodexAgent` from `@catamorphic/codex`).
   * Requires `sandboxProvider`; enables the agent-session APIs.
   */
  codingAgent?: CodingAgentProvider;
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
    new FsBackend(config.projectsPath),
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
    this.core = createCatamorphicCore({
      db,
      projectManager: resolveStorage(config.storage),
      sandboxProvider: config.sandboxProvider,
      pluginResolver: config.pluginResolver,
      codingAgent: config.codingAgent,
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
